import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  buildDecisionRequest,
  decodeDecision,
  JEV_ENDPOINT,
  JEV_MODEL,
} from "./jev-controller.mjs";

const { values } = parseArgs({
  options: {
    run: { type: "boolean", default: false },
    source: {
      type: "string",
      default: ".sessionlore/peekatrack-kimi-four-cleaned-v1",
    },
    out: {
      type: "string",
      default: ".sessionlore/peekatrack-jev-controller-v1",
    },
  },
});
const source = resolve(values.source),
  out = resolve(values.out);
await mkdir(out, { recursive: true, mode: 0o700 });
const baseline = await readJson(join(source, "COMPLETED.json"));
if (baseline?.status !== "all_four_complete")
  throw new Error("The frozen Kimi comparison must be complete first");
const states = [];
for (const name of await readdir(join(source, "attempts"))) {
  const attempt = await readJson(join(source, "attempts", name));
  if (
    !/^recursive\/root(?:\/child-\d+)*\/step-\d+$/.test(attempt.request.stage)
  )
    continue;
  const saved = await readJson(join(source, "responses", name));
  if (!saved?.response) throw new Error("Missing baseline controller response");
  const prepared = buildDecisionRequest(attempt.request);
  states.push({
    original_hash: name.replace(/\.json$/, ""),
    attempt,
    baseline: saved.response,
    baseline_elapsed_ms:
      Date.parse(saved.completed_at) - Date.parse(attempt.started_at),
    prepared,
  });
}
states.sort((a, b) => a.attempt.started_at.localeCompare(b.attempt.started_at));
if (states.length !== 10)
  throw new Error(
    `Expected 10 saved controller states, found ${states.length}`,
  );
const identity = hash(
  states.map((state) => ({
    original_hash: state.original_hash,
    request: state.prepared.body,
    long_context: state.prepared.longContext,
  })),
);
const manifest = {
  kind: "controller-state-replay",
  identity,
  source,
  model: JEV_MODEL,
  endpoint: JEV_ENDPOINT,
  states: states.length,
  scope:
    "JEV chooses operations and existing goals on frozen Kimi controller states. No alternate reading trajectory or new devlog is generated.",
  generation_providers: ["JEV"],
  new_kimi_generations: 0,
  history: baseline.inputs,
  limits: { calls: 10, tokens: 500000 },
  complete_request_reservations: states.map((state) => ({
    stage: state.attempt.request.stage,
    tokens: state.prepared.reservedTokens,
    long_context_header: state.prepared.longContext,
  })),
  reservation_note:
    "Complete UTF-8 request bytes plus 2048 framing and 8192 output reserve. Not an exact JEV token count; actual provider usage is saved.",
  pricing: {
    input_usd_per_million: 0.042,
    output_usd_per_million: 0,
    source: "https://docs.typesafe.ai/models",
    checked_at: "2026-11-11",
    invoice: false,
  },
};
const manifestPath = join(out, "manifest.json"),
  oldManifest = await readJson(manifestPath);
if (oldManifest && oldManifest.identity !== identity)
  throw new Error(
    "Replay inputs changed; do not reuse this allowance for a different experiment",
  );
if (!oldManifest) await atomicJson(manifestPath, manifest);
if (!values.run) {
  console.log(
    JSON.stringify({
      states: states.length,
      maximum_conservative_reservation: Math.max(
        ...states.map((s) => s.prepared.reservedTokens),
      ),
      total_conservative_reservation: states.reduce(
        (n, s) => n + s.prepared.reservedTokens,
        0,
      ),
      new_kimi_generations: 0,
      generation_calls_sent: 0,
    }),
  );
  process.exit(0);
}
loadEnvFile();
const key = process.env.JEV_API_KEY;
if (!key) throw new Error("JEV_API_KEY is missing");
const budgetPath = join(out, "budget.json");
let budget = await readJson(budgetPath);
if (!budget) {
  budget = {
    identity,
    limits: manifest.limits,
    calls: 0,
    used_tokens: 0,
    entries: [],
    pending: null,
    blocked: null,
  };
  await atomicJson(budgetPath, budget);
}
if (budget.identity !== identity || budget.pending || budget.blocked)
  throw new Error(
    "Inspect the existing replay budget or pending request before continuing",
  );
const results = [];
for (const state of states) {
  const { prepared } = state;
  const id = hash({ body: prepared.body, long_context: prepared.longContext });
  const responsePath = join(out, "responses", `${id}.json`);
  let saved = await readJson(responsePath),
    cached = Boolean(saved);
  if (!saved) {
    if (
      budget.calls >= budget.limits.calls ||
      budget.used_tokens + prepared.reservedTokens > budget.limits.tokens
    )
      throw new Error("JEV replay budget reached; no request sent");
    const requestPath = join(out, "requests", `${id}.json`);
    if (await readJson(requestPath))
      throw new Error(
        "Prior request has no completed response; no automatic retry",
      );
    budget.calls++;
    budget.pending = {
      id,
      stage: state.attempt.request.stage,
      reserved_tokens: prepared.reservedTokens,
      started_at: new Date().toISOString(),
    };
    await atomicJson(budgetPath, budget);
    await atomicJson(requestPath, {
      ...budget.pending,
      original_request_hash: state.original_hash,
      endpoint: JEV_ENDPOINT,
      headers: {
        "Content-Type": "application/json",
        ...(prepared.longContext
          ? { "TypeSafe-Danger-Zone-Long-Context": "true" }
          : {}),
      },
      body: prepared.body,
      source_request: state.attempt.request,
    });
    const started = performance.now();
    console.error(`JEV ${budget.calls}/10: ${state.attempt.request.stage}`);
    try {
      const response = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...(prepared.longContext
            ? { "TypeSafe-Danger-Zone-Long-Context": "true" }
            : {}),
        },
        body: JSON.stringify(prepared.body),
        signal: AbortSignal.timeout(60000),
      });
      const raw = await response.text();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      saved = {
        status: response.status,
        completed_at: new Date().toISOString(),
        elapsed_ms: Math.round(performance.now() - started),
        body,
        raw,
      };
      await atomicJson(responsePath, saved);
      if (body === null)
        throw new Error(
          `JEV HTTP ${response.status} returned non-JSON content; exact response saved`,
        );
      if (!response.ok)
        throw new Error(
          `JEV HTTP ${response.status}; request and response saved, no automatic retry`,
        );
      if (
        !Number.isInteger(body.usage?.input_tokens) ||
        body.usage.input_tokens < 0 ||
        !Number.isInteger(body.usage?.output_tokens) ||
        body.usage.output_tokens < 0
      )
        throw new Error(
          "JEV usage is unknown; no further requests will be sent",
        );
      const total = body.usage.input_tokens + body.usage.output_tokens;
      budget.used_tokens += total;
      budget.entries.push({
        ...budget.pending,
        ...body.usage,
        total_tokens: total,
        response_model: body.model,
        elapsed_ms: saved.elapsed_ms,
      });
      budget.pending = null;
      if (total > prepared.reservedTokens)
        budget.blocked = "Reported usage exceeded the conservative reservation";
      await atomicJson(budgetPath, budget);
      if (budget.blocked) throw new Error(budget.blocked);
    } catch (error) {
      budget.blocked = error.message;
      await atomicJson(budgetPath, budget);
      throw error;
    }
  }
  const decoded = decodeDecision(prepared, saved.body);
  const memoryGaps = (state.attempt.request.data.memory ?? []).flatMap(
    (note) => note.unresolved ?? [],
  );
  results.push({
    stage: state.attempt.request.stage,
    original_request_hash: state.original_hash,
    jev_request_hash: id,
    reused_jev_response: cached,
    kimi: {
      control: state.baseline.value,
      input_tokens: state.baseline.input_tokens,
      output_tokens: state.baseline.output_tokens,
      elapsed_ms: state.baseline_elapsed_ms,
    },
    jev: {
      ...decoded,
      model: saved.body.model,
      ...saved.body.usage,
      elapsed_ms: saved.elapsed_ms,
      answers: saved.body.answers,
    },
    action_agreement: decoded.control.action === state.baseline.value.action,
    available_memory_notes: state.attempt.request.data.memory.length,
    unresolved_memory_items: memoryGaps,
    finish_with_unresolved_memory:
      decoded.control.action === "finish" && memoryGaps.length > 0,
  });
  await atomicJson(join(out, "results.json"), {
    kind: manifest.kind,
    identity,
    complete: results.length === states.length,
    results,
  });
}
const totals = (provider) =>
  results.reduce(
    (a, row) => ({
      input_tokens: a.input_tokens + row[provider].input_tokens,
      output_tokens: a.output_tokens + row[provider].output_tokens,
      elapsed_ms: a.elapsed_ms + row[provider].elapsed_ms,
    }),
    { input_tokens: 0, output_tokens: 0, elapsed_ms: 0 },
  );
const jev = totals("jev"),
  kimi = totals("kimi");
const summary = {
  completed_at: new Date().toISOString(),
  complete: true,
  kind: manifest.kind,
  decisions: results.length,
  valid_decisions: results.length,
  action_agreement: results.filter((r) => r.action_agreement).length,
  low_confidence: results.filter((r) => r.jev.low_confidence).length,
  finish_with_unresolved_memory: results.filter(
    (r) => r.finish_with_unresolved_memory,
  ).length,
  jev,
  kimi_cached_baseline: kimi,
  new_kimi_generations: 0,
  jev_estimated_usd: (jev.input_tokens / 1000000) * 0.042,
  limitations: [
    "A replay of Kimi's states, not a JEV-led trajectory or new full pipeline output.",
    "JEV chooses among existing focus questions; search query text is copied deterministically, not generated.",
    "Agreement with Kimi is not accuracy. Confidence is not calibrated ground truth for this task.",
    "Latency is observational, from different requests at different times.",
    "The final four Kimi devlogs and their budget were not changed.",
  ],
};
await atomicJson(join(out, "summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
