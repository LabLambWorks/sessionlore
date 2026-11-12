import { join } from "node:path";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  HttpModel,
  ModelBudgetError,
  ModelQuotaError,
} from "../packages/experiments/dist/model.js";
import { JEV_ENDPOINT, JEV_MODEL } from "./jev-controller.mjs";
import { KimiRunBudget } from "./kimi-run-budget.mjs";

export const MIXED_LIMITS = {
  tokens: 250000,
  calls: 8,
  quota_percentage_points: 25,
};
export const JEV_LIMITS = { tokens: 250000, calls: 8 };

export async function createMixedModels(output) {
  const key = process.env.KIMI_CODE_API_KEY,
    jevKey = process.env.JEV_API_KEY;
  if (!key || !jevKey)
    throw new Error("KIMI_CODE_API_KEY and JEV_API_KEY are required");
  const base = "https://api.kimi.com/coding/v1";
  const metadata = async (path) => {
    const response = await fetch(`${base}/${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "sessionlore/0.1.0",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Kimi ${path} HTTP ${response.status}`);
    return response.json();
  };
  const quota = async (label = "quota-latest") => {
    const response = await metadata("usages");
    const snapshot = {
      observed_at: new Date().toISOString(),
      limits: response.limits ?? [],
    };
    if (!snapshot.limits.length)
      throw new ModelBudgetError("Kimi quota is unknown");
    await atomicJson(join(output, `${label}.json`), snapshot);
    return snapshot;
  };
  const snapshot = await quota("quota-before");
  const percentages = snapshot.limits.map(
    ({ detail }) =>
      (Number(detail.used ?? Number(detail.limit) - Number(detail.remaining)) /
        Number(detail.limit)) *
      100,
  );
  if (percentages.some((value) => !Number.isFinite(value) || value >= 100))
    throw new ModelBudgetError("Kimi quota unavailable; no generation sent");
  const budget = new KimiRunBudget(output);
  if (!(await readJson(budget.path)))
    await atomicJson(budget.path, {
      created_at: new Date().toISOString(),
      authorization:
        "User requested a new full JEV-decision/Kimi-writing comparison with a usage cap. This is a separate experiment; prior budgets remain unchanged.",
      limits: MIXED_LIMITS,
      quota_start_percent: Math.max(...percentages),
      calls: 0,
      used_tokens: 0,
      entries: [],
      pending: null,
      blocked: null,
    });
  const jevBudgetPath = join(output, "jev-budget.json");
  if (!(await readJson(jevBudgetPath)))
    await atomicJson(jevBudgetPath, {
      created_at: new Date().toISOString(),
      limits: JEV_LIMITS,
      calls: 0,
      used_tokens: 0,
      entries: [],
      pending: null,
      blocked: null,
    });
  async function assertSettled() {
    for (const path of [budget.path, jevBudgetPath]) {
      const state = await readJson(path);
      if (state.pending || state.blocked)
        throw new ModelBudgetError(
          "An earlier provider request is unresolved or blocked; no further calls allowed",
        );
    }
  }
  await assertSettled();
  const catalog = await metadata("models");
  const advertised = catalog.data?.find((model) => model.id === "k3.1-pro");
  const contextTokens =
    advertised?.context_length ?? advertised?.limit?.context;
  if (!Number.isInteger(contextTokens) || contextTokens <= 0)
    throw new Error("Kimi context accounting is unavailable");
  await atomicJson(join(output, "model-metadata.json"), {
    observed_at: new Date().toISOString(),
    model: advertised,
  });
  const http = new HttpModel({
    model: "k3.1-pro",
    baseUrl: base,
    apiKey: key,
    apiStyle: "kimi-code",
    jsonMode: "object",
    reasoningEffort: "high",
    maxOutputTokens: 16384,
    timeoutMs: 600000,
    contextTokens,
    maxAttempts: 1,
  });
  const model = {
    name: http.name,
    model: http.model,
    demo: false,
    configuration: http.configuration,
    async complete(request) {
      // All reading notes must come from exact caches. Kimi only plans, writes,
      // and checks this new article; it cannot restart recursive reading.
      if (!/^(guarded\/outline|write\/|verify\/)/.test(request.stage))
        throw new ModelBudgetError(
          `Required cache missing for ${request.stage}; no replacement generation allowed`,
        );
      await assertSettled();
      const id = hash(request),
        path = join(output, "attempts", `${id}.json`);
      if (await readJson(path))
        throw new ModelBudgetError(
          "A matching attempt has no reusable cache; inspect it before retrying",
        );
      const current = await quota();
      if (current.limits.some(({ detail }) => Number(detail.remaining) <= 0))
        throw new ModelBudgetError("Kimi quota exhausted; no generation sent");
      const countPath = join(output, "token-counts", `${id}.json`);
      let count = await readJson(countPath);
      if (!count) {
        const body = {
          model: "k3.1-pro",
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
        const response = await fetch(`${base}/messages/count_tokens`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "User-Agent": "sessionlore/0.1.0",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw new ModelBudgetError(
            `Kimi count_tokens HTTP ${response.status}; no generation sent`,
          );
        const value = await response.json();
        if (!Number.isInteger(value.input_tokens) || value.input_tokens < 0)
          throw new ModelBudgetError("Kimi input count is invalid");
        count = {
          counted_at: new Date().toISOString(),
          request: body,
          input_tokens: value.input_tokens,
          protocol_reserve: 2048,
        };
        await atomicJson(countPath, count);
      }
      await budget.reserve(
        request,
        current,
        16384,
        count.input_tokens,
        "jev-kimi-full",
      );
      await atomicJson(path, {
        started_at: new Date().toISOString(),
        model: http.configuration,
        request,
      });
      console.error(
        `${new Date().toISOString()} KIMI ${request.stage}: ${count.input_tokens} counted input tokens`,
      );
      let response;
      try {
        response = await http.complete(request);
      } catch (error) {
        await budget.settle(
          error instanceof ModelQuotaError
            ? { input_tokens: 0, output_tokens: 0 }
            : error.response,
          error.message,
        );
        await atomicJson(join(output, "failures", `${id}.json`), {
          at: new Date().toISOString(),
          stage: request.stage,
          error: error.message,
          automatic_retry: false,
        });
        throw error;
      }
      await atomicJson(join(output, "responses", `${id}.json`), {
        completed_at: new Date().toISOString(),
        request_hash: id,
        response,
      });
      await budget.settle(response);
      return response;
    },
  };
  const controller = {
    name: "typesafe",
    model: JEV_MODEL,
    demo: false,
    configuration: {
      api_style: "systemone-choice",
      policy: "unread-evidence-batches-v2",
      timeout_ms: 60000,
    },
    async complete(request) {
      if (!/^guarded\/decision-\d+$/.test(request.stage))
        throw new ModelBudgetError(
          "JEV is restricted to guarded reading decisions",
        );
      await assertSettled();
      const candidates = request.data.candidates;
      if (
        !Array.isArray(candidates) ||
        !candidates.length ||
        candidates.length > 255
      )
        throw new ModelBudgetError("Invalid JEV candidate set");
      const criteria = Object.fromEntries(
        candidates.map((candidate) => [candidate.batch_id, candidate]),
      );
      const body = {
        model: JEV_MODEL,
        state: request.data,
        questions: {
          next_batch: {
            type: "choice",
            instructions: [request.system, request.instruction],
            criteria,
          },
        },
      };
      const bytes = Buffer.byteLength(JSON.stringify(body), "utf8") + 2048;
      if (bytes > 262000)
        throw new ModelBudgetError(
          "Complete JEV decision exceeds the context bound; nothing truncated",
        );
      const longContext = bytes > 32000;
      const reserved = bytes + 8192;
      const id = hash({ body, longContext });
      const state = await readJson(jevBudgetPath);
      if (
        state.calls >= state.limits.calls ||
        state.used_tokens + reserved > state.limits.tokens
      )
        throw new ModelBudgetError(
          "JEV decision budget reached; no request sent",
        );
      const requestPath = join(output, "jev", "requests", `${id}.json`);
      if (await readJson(requestPath))
        throw new ModelBudgetError(
          "Earlier JEV attempt has no reusable cache; no automatic retry",
        );
      state.calls++;
      state.pending = {
        id,
        stage: request.stage,
        started_at: new Date().toISOString(),
        reserved_tokens: reserved,
      };
      await atomicJson(jevBudgetPath, state);
      await atomicJson(requestPath, {
        ...state.pending,
        endpoint: JEV_ENDPOINT,
        long_context: longContext,
        body,
      });
      console.error(
        `${new Date().toISOString()} JEV ${request.stage}: ${candidates.length} unread batches`,
      );
      const start = performance.now();
      try {
        const response = await fetch(JEV_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jevKey}`,
            "Content-Type": "application/json",
            ...(longContext
              ? { "TypeSafe-Danger-Zone-Long-Context": "true" }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        const raw = await response.text();
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          value = null;
        }
        const elapsed = Math.round(performance.now() - start);
        await atomicJson(join(output, "jev", "responses", `${id}.json`), {
          completed_at: new Date().toISOString(),
          status: response.status,
          raw,
          body: value,
          elapsed_ms: elapsed,
        });
        if (
          !response.ok ||
          !Number.isInteger(value?.usage?.input_tokens) ||
          value.usage.input_tokens < 0 ||
          !Number.isInteger(value.usage.output_tokens) ||
          value.usage.output_tokens < 0
        )
          throw new Error(
            `JEV HTTP ${response.status}, or unknown usage; response saved`,
          );
        const total = value.usage.input_tokens + value.usage.output_tokens;
        state.used_tokens += total;
        state.entries.push({
          ...state.pending,
          ...value.usage,
          total_tokens: total,
          elapsed_ms: elapsed,
          response_model: value.model,
        });
        state.pending = null;
        const answer = value.answers?.next_batch;
        if (total > reserved)
          throw new Error("JEV usage exceeded its conservative reservation");
        if (
          value.model !== JEV_MODEL ||
          answer?.type !== "choice" ||
          !Object.hasOwn(criteria, answer.choice) ||
          !Number.isFinite(answer.confidence) ||
          answer.confidence < 0 ||
          answer.confidence > 1
        )
          throw new Error("Invalid JEV model, choice, or confidence");
        await atomicJson(jevBudgetPath, state);
        return {
          value: { batch_id: answer.choice },
          input_tokens: value.usage.input_tokens,
          output_tokens: value.usage.output_tokens,
          response_model: value.model,
          response_transport: "json",
        };
      } catch (error) {
        state.blocked = error.message;
        await atomicJson(jevBudgetPath, state);
        throw error;
      }
    },
  };
  return { model, controller, quota };
}
