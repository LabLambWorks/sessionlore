import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runLongComparison } from "../packages/experiments/dist/long/index.js";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import { DEVLOG_BRIEF } from "../packages/experiments/dist/long/writing.js";
import {
  HttpModel,
  ModelBudgetError,
  ModelQuotaError,
} from "../packages/experiments/dist/model.js";
import { KimiRunBudget } from "./kimi-run-budget.mjs";

loadEnvFile();
const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: ".sessionlore/peekatrack-kimi-four-cleaned-v1",
    },
    prepare: { type: "boolean", default: false },
    "wait-for-quota": { type: "boolean", default: false },
    approaches: {
      type: "string",
      default: "hierarchy,hybrid,hierarchy-retrieval,recursive",
    },
  },
});
const output = resolve(values.out);
const budget = new KimiRunBudget(output);
await mkdir(output, { recursive: true, mode: 0o700 });
const key = process.env.KIMI_CODE_API_KEY;
if (!key) throw new Error("KIMI_CODE_API_KEY is missing");
const baseUrl = "https://api.kimi.com/coding/v1";
async function metadata(path) {
  const response = await fetch(`${baseUrl}/${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": "sessionlore/0.1.0",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Kimi ${path} HTTP ${response.status}`);
  return response.json();
}
const exhausted = (snapshot) =>
  snapshot.limits.some(
    ({ detail = {} }) =>
      Number(detail.remaining) <= 0 ||
      (detail.used !== undefined &&
        Number(detail.used) >= Number(detail.limit)),
  );
async function quota(label, enforce = true) {
  const body = await metadata("usages");
  const snapshot = {
    observed_at: new Date().toISOString(),
    limits: body.limits ?? [],
  };
  await atomicJson(join(output, `${label}.json`), snapshot);
  if (enforce && exhausted(snapshot)) {
    const error = new ModelQuotaError("5-hour");
    error.message = `Kimi quota exhausted; reset ${snapshot.limits.map(({ detail }) => detail?.resetTime).join(", ")}. No generation sent.`;
    throw error;
  }
  return snapshot;
}
const runId = new Date().toISOString().replaceAll(":", "-");
async function countInput(request) {
  const id = hash({ model: "k3.1-pro", request });
  const path = join(output, "token-counts", `${id}.json`);
  const cached = await readJson(path);
  if (cached) return cached.input_tokens;
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
  const response = await fetch(`${baseUrl}/messages/count_tokens`, {
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
      `Kimi token count HTTP ${response.status}; no generation sent.`,
    );
  const count = await response.json();
  if (!Number.isInteger(count.input_tokens) || count.input_tokens < 0)
    throw new ModelBudgetError(
      "Kimi returned an invalid input count; no generation sent.",
    );
  await atomicJson(path, {
    counted_at: new Date().toISOString(),
    endpoint: `${baseUrl}/messages/count_tokens`,
    request_hash: hash(request),
    count_request: body,
    input_tokens: count.input_tokens,
    protocol_reserve: 2048,
  });
  return count.input_tokens;
}
let availability = await quota(`quota/${runId}-before`, false);
if (values["wait-for-quota"] && exhausted(availability)) {
  const started = Date.now();
  const wait = {
    started_at: new Date(started).toISOString(),
    expected_reset: availability.limits.map(({ detail }) => detail?.resetTime),
    generation_requests_while_waiting: 0,
  };
  await atomicJson(join(output, "quota-wait.json"), wait);
  console.error(
    `${new Date().toISOString()} Waiting for Kimi quota; reset ${wait.expected_reset.join(", ")}. Saved generations will be reused.`,
  );
  do {
    await delay(60000);
    availability = await quota("quota-wait-latest", false);
  } while (exhausted(availability));
  await atomicJson(join(output, "quota-wait.json"), {
    ...wait,
    ready_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
  });
  console.error(
    `${new Date().toISOString()} Kimi quota is available; resuming cached pipelines.`,
  );
}
const catalog = await metadata("models");
const advertised = catalog.data?.find((model) => model.id === "k3.1-pro");
const contextTokens = advertised?.context_length ?? advertised?.limit?.context;
if (!Number.isInteger(contextTokens) || contextTokens <= 0)
  throw new Error("Kimi did not report a valid context limit");
await atomicJson(join(output, "model-metadata.json"), {
  observed_at: new Date().toISOString(),
  model: advertised,
});
const http = new HttpModel({
  model: "k3.1-pro",
  baseUrl,
  apiKey: key,
  apiStyle: "kimi-code",
  jsonMode: "object",
  reasoningEffort: "high",
  maxOutputTokens: 16384,
  timeoutMs: 600000,
  contextTokens,
  maxAttempts: 1,
});
let generations = 0;
const model = {
  name: http.name,
  model: http.model,
  demo: false,
  configuration: http.configuration,
  async complete(request) {
    if (++generations > 200)
      throw new Error(
        "Run generation budget reached; completed responses are cached",
      );
    const id = hash(request),
      attempt = join(output, "attempts", `${id}.json`);
    if (await readJson(attempt))
      throw new Error(
        `Prior attempt ${id} has no reusable response; inspect before repeating it`,
      );
    let snapshot;
    try {
      snapshot = await quota("quota-latest");
      const inputCount = await countInput(request);
      await budget.reserve(
        request,
        snapshot,
        16384,
        inputCount,
        values.approaches.includes(",") ? undefined : values.approaches,
      );
    } catch (error) {
      if (error instanceof ModelBudgetError || error instanceof ModelQuotaError)
        throw error;
      throw new ModelBudgetError(
        `Kimi preflight failed: ${error.message}. No generation sent.`,
      );
    }
    console.error(
      `${new Date().toISOString()} START ${request.stage}; quota ${snapshot.limits.map(({ detail }) => detail?.remaining).join(",")} remaining`,
    );
    await atomicJson(attempt, {
      started_at: new Date().toISOString(),
      model: http.configuration,
      request,
    });
    try {
      const response = await http.complete(request);
      await atomicJson(join(output, "responses", `${id}.json`), {
        completed_at: new Date().toISOString(),
        request_hash: id,
        response,
      });
      await budget.settle(response);
      return response;
    } catch (error) {
      await budget.settle(
        error instanceof ModelQuotaError
          ? { input_tokens: 0, output_tokens: 0 }
          : error.response,
        error.message,
      );
      await atomicJson(join(output, "failures", `${id}-${Date.now()}.json`), {
        failed_at: new Date().toISOString(),
        request_hash: id,
        stage: request.stage,
        error: error.message,
        cause: error.cause
          ? {
              name: error.cause.name,
              code: error.cause.code,
              message: error.cause.message,
            }
          : null,
        automatic_retry: false,
      });
      if (error instanceof ModelQuotaError) await rm(attempt);
      throw error;
    }
  },
};
const cacheDirectories = (
  await readdir(resolve(".sessionlore"), { withFileTypes: true })
)
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name.includes("kimi") &&
      resolve(".sessionlore", entry.name) !== output,
  )
  .map((entry) => resolve(".sessionlore", entry.name, "model-cache"));
const settings = {
  approaches: values.approaches.split(","),
  source_capture: resolve(".sessionlore/peekatrack-full-deepseek-v1"),
  cleaned_capture: resolve(".sessionlore/peekatrack-conversation-v1"),
  generation_model: "k3.1-pro",
  provider: "Kimi Code",
  reasoning_effort: "high",
  target_words_per_devlog: 1800,
  concurrent_generations: 1,
  resume_limits: await budget.limits(),
  source_text_truncation: false,
  time_filter: null,
  writing_brief: DEVLOG_BRIEF,
  verification:
    "Complete citations, deduplicated in batches of at most 24 paragraphs, with bounded original-message counterevidence. One review pass; no audit loop.",
  cache_directories: cacheDirectories,
};
if (!(await readJson(join(output, "run-settings.json"))))
  await atomicJson(join(output, "run-settings.json"), settings);
await atomicJson(join(output, "invocations", `${runId}.json`), settings);
try {
  const result = await runLongComparison({
    input: ".sessionlore/cases/peekatrack/sessions",
    sourceDirectory: ".sessionlore/peekatrack-full-deepseek-v1",
    cleanedDirectory: ".sessionlore/peekatrack-conversation-v1",
    output,
    model,
    approaches: values.approaches.split(","),
    evidenceView: "conversation",
    targetWords: 1800,
    chunkTokens: 16000,
    inputTokens: 140000,
    concurrency: 1,
    maxCalls: 250,
    maxRepairs: 1,
    cacheDirectories,
    prepareOnly: values.prepare,
    progress: (message) =>
      console.error(`${new Date().toISOString()} ${message}`),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await quota(`quota/${runId}-after`, false).catch((error) =>
    console.error(error.message),
  );
}
