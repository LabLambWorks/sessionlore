import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import {
  atomicJson,
  hash,
  loadTokenizer,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  HttpModel,
  ModelQuotaError,
} from "../packages/experiments/dist/model.js";
import {
  assembleInventory,
  inventoryRecords,
  inventoryRequest,
  prepareInventory,
  validateInventory,
} from "../packages/experiments/dist/request-inventory.js";
import { KimiRunBudget } from "./kimi-run-budget.mjs";

export const INVENTORY_LIMITS = Object.freeze({
  tokens: 180000,
  calls: 24,
  quota_percentage_points: 15,
});
const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: ".sessionlore/peekawild-request-inventory-v1",
    },
    run: { type: "boolean", default: false },
  },
});
const out = resolve(values.out);
await mkdir(out, { recursive: true, mode: 0o700 });
const lockPath = join(out, "run.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(
  JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    live: values.run,
  }),
);
try {
  const capture = await readJson(join(out, "capture.json"));
  const corpus = await readJson(join(out, "primary-corpus.json"));
  if (
    !capture ||
    !corpus ||
    hash(corpus) !== capture.primary_corpus_sha256 ||
    capture.time_filter !== null
  )
    throw new Error("An intact full-project conversation capture is required");
  const tokenizer = await loadTokenizer(
    resolve(".sessionlore/models/deepseek-v4-tokenizer"),
  );
  const records = inventoryRecords(corpus);
  const batches = prepareInventory(records, tokenizer);
  const requests = batches.map(inventoryRequest);
  const config = {
    model: "k3.1-pro",
    reasoning_effort: "low",
    max_output_tokens: 8192,
    max_http_attempts: 1,
  };
  const signature = hash({
    capture: capture.primary_corpus_sha256,
    requests,
    config,
  });
  const prior = await readJson(join(out, "preflight.json"));
  if (prior && prior.signature !== signature)
    throw new Error(
      "Frozen inventory configuration changed; do not mix paid results",
    );
  const plan = {
    signature,
    project: capture.project,
    chat_ids: capture.chat_ids,
    request_records: records.filter((r) => r.role === "user_request").length,
    answer_records: records.filter((r) => r.role === "user_answer").length,
    batches: batches.map((b, i) => ({
      id: b.id,
      targets: b.target_ids.length,
      context_records: b.records.filter((r) => !b.target_ids.includes(r.id))
        .length,
      input_proxy: tokenizer.count(JSON.stringify(requests[i])),
    })),
    input_proxy: requests.reduce(
      (n, r) => n + tokenizer.count(JSON.stringify(r)),
      0,
    ),
    limits: INVENTORY_LIMITS,
    model: config,
    accounting:
      "Local tokenizer counts are estimates. Live calls reserve Kimi count_tokens plus framing and full output space.",
    implementation_checking: false,
    time_filter: null,
    source_text_truncated: false,
  };
  await atomicJson(join(out, "preflight.json"), plan);
  await atomicJson(join(out, "records.json"), records);
  await atomicJson(join(out, "batches.json"), batches);
  console.log(JSON.stringify(plan, null, 2));
  if (values.run) {
    loadEnvFile();
    const key = process.env.KIMI_CODE_API_KEY;
    if (!key) throw new Error("KIMI_CODE_API_KEY is missing");
    const base = "https://api.kimi.com/coding/v1";
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "sessionlore/0.1.0",
    };
    const metadata = async (path) => {
      const response = await fetch(`${base}/${path}`, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error(`Kimi metadata HTTP ${response.status}`);
      return response.json();
    };
    const quota = async (label) => {
      const raw = await metadata("usages");
      const snapshot = {
        observed_at: new Date().toISOString(),
        limits: raw.limits ?? [],
      };
      await atomicJson(join(out, `${label}.json`), snapshot);
      if (!snapshot.limits.length)
        throw new Error("Unknown quota; no generation sent");
      if (snapshot.limits.some((x) => Number(x.detail.remaining) <= 0))
        throw new Error(
          `Kimi quota exhausted; reset ${snapshot.limits.map((x) => x.detail.resetTime).join(", ")}`,
        );
      return snapshot;
    };
    const snapshot = await quota("quota-before");
    const budget = new KimiRunBudget(out);
    if (!(await readJson(budget.path)))
      await atomicJson(budget.path, {
        created_at: new Date().toISOString(),
        signature,
        authorization:
          "User requested the exhaustive PeekaWild request inventory after the local estimate. Fixed allowance for this distinct extraction run; no prior budget was changed.",
        limits: INVENTORY_LIMITS,
        calls: 0,
        used_tokens: 0,
        entries: [],
        pending: null,
        blocked: null,
        quota_start_percent: Math.max(
          ...snapshot.limits.map(
            (x) =>
              ((Number(x.detail.limit) - Number(x.detail.remaining)) /
                Number(x.detail.limit)) *
              100,
          ),
        ),
      });
    const initialBudget = await readJson(budget.path);
    if (
      initialBudget.signature !== signature ||
      initialBudget.pending ||
      initialBudget.blocked
    )
      throw new Error(
        "Budget configuration changed, blocked, or has an unresolved request",
      );
    const catalog = await metadata("models");
    const model = catalog.data?.find((m) => m.id === config.model);
    const contextTokens = model?.context_length ?? model?.limit?.context;
    if (!Number.isInteger(contextTokens))
      throw new Error("Unknown Kimi context bound");
    await atomicJson(join(out, "model-metadata.json"), {
      observed_at: new Date().toISOString(),
      model,
    });
    const http = new HttpModel({
      model: config.model,
      apiKey: key,
      baseUrl: base,
      apiStyle: "kimi-code",
      jsonMode: "object",
      reasoningEffort: "low",
      maxOutputTokens: config.max_output_tokens,
      timeoutMs: 600000,
      contextTokens,
      maxAttempts: 1,
    });
    const completed = [];
    let failure = null;
    try {
      for (const [i, batch] of batches.entries()) {
        const request = requests[i],
          id = hash({ config, request });
        const responsePath = join(out, "responses", `${id}.json`);
        let cached = await readJson(responsePath);
        if (!cached) {
          const attemptPath = join(out, "attempts", `${id}.json`);
          if (await readJson(attemptPath))
            throw new Error(
              "Matching unresolved attempt exists; no blind retry",
            );
          const current = await quota("quota-latest");
          const countBody = {
            model: config.model,
            system: request.system,
            messages: [
              {
                role: "user",
                content: JSON.stringify({
                  task: request.task,
                  instruction: request.instruction,
                  output_schema: request.schema,
                  data: request.data,
                }),
              },
            ],
          };
          const countPath = join(out, "token-counts", `${id}.json`);
          let count = await readJson(countPath);
          if (!count) {
            const counted = await fetch(`${base}/messages/count_tokens`, {
              method: "POST",
              headers: { ...headers, "anthropic-version": "2023-06-01" },
              body: JSON.stringify(countBody),
              signal: AbortSignal.timeout(20000),
            });
            if (!counted.ok)
              throw new Error(
                `Token count HTTP ${counted.status}; no generation sent`,
              );
            count = {
              counted_at: new Date().toISOString(),
              request: countBody,
              ...(await counted.json()),
            };
            await atomicJson(countPath, count);
          }
          await budget.reserve(
            request,
            current,
            config.max_output_tokens,
            count.input_tokens,
            "request-inventory",
          );
          await atomicJson(attemptPath, {
            started_at: new Date().toISOString(),
            request_hash: hash(request),
            config,
            request,
          });
          console.error(
            `${new Date().toISOString()} Extracting ${batch.id}/${batches.length}: ${batch.target_ids.length} records, ${count.input_tokens} counted input tokens`,
          );
          try {
            const response = await http.complete(request);
            cached = {
              request_hash: hash(request),
              config,
              request,
              response,
              completed_at: new Date().toISOString(),
            };
            await atomicJson(responsePath, cached);
            await budget.settle(response);
          } catch (error) {
            await budget.settle(
              error instanceof ModelQuotaError
                ? { input_tokens: 0, output_tokens: 0 }
                : error.response,
              error.message,
            );
            await atomicJson(join(out, "failures", `${id}.json`), {
              error: error.message,
              response: error.response ?? null,
              automatic_retry: false,
            });
            throw error;
          }
        }
        if (
          cached.request_hash !== hash(request) ||
          hash(cached.config) !== hash(config)
        )
          throw new Error("Response cache identity mismatch");
        const valid = validateInventory(cached.response.value, batch);
        await atomicJson(join(out, "results", `${batch.id}.json`), {
          request_hash: hash(request),
          cache_key: id,
          ...valid,
        });
        completed.push({ batch, value: valid.response });
        const inventory = assembleInventory(records, completed);
        await atomicJson(join(out, "inventory.json"), inventory);
        await atomicJson(join(out, "checkpoint.json"), {
          at: new Date().toISOString(),
          status: inventory.status,
          processed: inventory.coverage.processed_records,
          total: inventory.coverage.target_records,
          items: inventory.items.length,
          usage: await readJson(budget.path),
        });
        console.error(
          `Saved ${inventory.items.length} items from ${inventory.coverage.processed_records}/${inventory.coverage.target_records} target records`,
        );
      }
    } catch (error) {
      failure = error.message;
    }
    const inventory = assembleInventory(records, completed);
    await atomicJson(join(out, "inventory.json"), inventory);
    const finalQuota = await quota("quota-after").catch((error) => ({
      error: error.message,
    }));
    await atomicJson(join(out, "run-result.json"), {
      status: inventory.status,
      failure,
      finished_at: new Date().toISOString(),
      items: inventory.items.length,
      coverage: inventory.coverage,
      budget: await readJson(budget.path),
      quota: finalQuota,
      limitations: [
        "Record coverage is checked; semantic completeness still requires review.",
        "Requests referring to unseen images or missing context are marked uncertain.",
        "Implementation status was not checked.",
      ],
    });
    console.log(
      JSON.stringify({
        status: inventory.status,
        failure,
        items: inventory.items.length,
        processed: inventory.coverage.processed_records,
        total: inventory.coverage.target_records,
      }),
    );
    if (failure) process.exitCode = 1;
  }
} finally {
  await lock.close();
  await rm(lockPath);
}
