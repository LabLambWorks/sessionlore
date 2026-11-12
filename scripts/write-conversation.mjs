import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { runConversationNarrative } from "../packages/experiments/dist/long/conversation-narrative.js";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  HttpModel,
  ModelQuotaError,
} from "../packages/experiments/dist/model.js";

loadEnvFile();
const { values } = parseArgs({
  options: {
    source: {
      type: "string",
      default: ".sessionlore/peekatrack-full-deepseek-v1",
    },
    out: {
      type: "string",
      default: ".sessionlore/peekatrack-kimi-full-narrative-v1",
    },
    words: { type: "string", default: "1800" },
  },
});
const output = resolve(values.out);
await mkdir(output, { recursive: true, mode: 0o700 });
const key = process.env.KIMI_CODE_API_KEY;
if (!key) throw new Error("KIMI_CODE_API_KEY is missing.");
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
async function quota(name) {
  const body = await metadata("usages");
  const snapshot = {
    observed_at: new Date().toISOString(),
    limits: body.limits ?? [],
  };
  await atomicJson(join(output, `${name}.json`), snapshot);
  return snapshot;
}
const before = await quota("quota-before");
if (
  before.limits.some(
    ({ detail = {} }) =>
      (detail.remaining !== undefined && Number(detail.remaining) <= 0) ||
      (detail.used !== undefined &&
        Number(detail.used) >= Number(detail.limit)),
  )
)
  throw new Error("Kimi quota is unavailable. No generation was sent.");
const catalog = await metadata("models");
const advertised = catalog.data?.find((model) => model.id === "k3.1-pro");
const contextTokens = advertised?.context_length ?? advertised?.limit?.context;
if (!Number.isInteger(contextTokens) || contextTokens <= 0)
  throw new Error("Kimi did not report the requested model's context limit.");
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
    if (++generations > 2)
      throw new Error("Two-generation run budget exhausted.");
    const attempt = join(output, "attempts", `${hash(request)}.json`);
    if (await readJson(attempt))
      throw new Error(
        "A previous attempt has no reusable response. Inspect its outcome before repeating it.",
      );
    await atomicJson(attempt, {
      started_at: new Date().toISOString(),
      request,
    });
    try {
      return await http.complete(request);
    } catch (error) {
      if (error instanceof ModelQuotaError) await rm(attempt);
      throw error;
    }
  },
};
try {
  const result = await runConversationNarrative({
    sourceDirectory: values.source,
    output,
    model,
    targetWords: Number(values.words),
    progress: (message) => console.error(message),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await quota("quota-after").catch((error) => console.error(error.message));
}
