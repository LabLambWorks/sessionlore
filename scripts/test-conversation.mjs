// One full-conversation answer, with a strict one-generation budget.
// Run `pnpm build` first. --prepare-only makes no generation requests.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { SYSTEM } from "../packages/experiments/dist/context.js";
import { conversationView } from "../packages/experiments/dist/conversation.js";
import {
  DIAGNOSTIC_INSTRUCTION,
  DiagnosticAnswer,
} from "../packages/experiments/dist/long/diagnostic.js";
import {
  atomicJson,
  hash,
  loadTokenizer,
  RunContext,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import { HttpModel } from "../packages/experiments/dist/model.js";

loadEnvFile();
const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: ".sessionlore/peekatrack-kimi-conversation-pilot-v1",
    },
    case: { type: "string", default: "placement_speed" },
    "prepare-only": { type: "boolean", default: false },
  },
});
const output = resolve(values.out);
const source = resolve(".sessionlore/peekatrack-full-deepseek-v1");
const prepared = resolve(".sessionlore/peekatrack-conversation-v1");
const previous = resolve(".sessionlore/peekatrack-kimi-request-result-v1");
const baseUrl = "https://api.kimi.com/coding/v1";
const modelId = "k3.1-pro";
const key = process.env.KIMI_CODE_API_KEY;
if (!key) throw new Error("KIMI_CODE_API_KEY is missing.");
await mkdir(output, { recursive: true, mode: 0o700 });

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
  const result = await metadata("usages");
  // Keep quota fields only, never account details or credentials.
  const snapshot = {
    observed_at: new Date().toISOString(),
    limits: result.limits ?? [],
  };
  await atomicJson(join(output, `${name}.json`), snapshot);
  return snapshot;
}

const before = await quota("quota-before");
for (const limit of before.limits) {
  const detail = limit.detail ?? {};
  if (
    (detail.remaining !== undefined && Number(detail.remaining) <= 0) ||
    (detail.used !== undefined && Number(detail.used) >= Number(detail.limit))
  )
    throw new Error(
      `Kimi quota unavailable; reset ${detail.resetTime ?? "unknown"}. No generation sent.`,
    );
}
const catalog = await metadata("models");
const advertised = catalog.data?.find((entry) => entry.id === modelId);
assert(advertised, "Kimi did not list the requested model.");
const contextTokens = advertised.context_length ?? advertised.limit?.context;
assert(
  Number.isInteger(contextTokens) && contextTokens > 0,
  "Kimi did not return a context limit.",
);
await atomicJson(join(output, "model-metadata.json"), {
  endpoint: `${baseUrl}/models`,
  observed_at: new Date().toISOString(),
  model: advertised,
});

const archive = await readJson(join(source, "corpus.json"));
const capture = await readJson(join(source, "manifest.json"));
assert.equal(capture.time_filter, null);
assert.equal(hash(archive), capture.corpus_sha256);
const view = conversationView(archive);
const compact = await readJson(join(prepared, "conversation.json"));
const primary = await readJson(join(prepared, "primary-corpus.json"));
assert.equal(hash(compact), hash(view.compact));
assert.equal(hash(primary), hash(view.corpus));
assert.equal(compact.threads.length, capture.thread_ids.length);
const benchmark = await readJson(join(previous, "frozen-benchmark.json"));
const test = benchmark.cases.find((entry) => entry.id === values.case);
assert(test, "Unknown prior benchmark case.");
const oldComparison = await readJson(join(previous, "comparison.json"));
const oldRows = oldComparison.rows.filter((row) => row.case_id === test.id);
assert(
  oldRows.some((row) => row.status === "complete" && row.variant === "current"),
);

const tokenizer = await loadTokenizer(
  resolve(".sessionlore/models/deepseek-v4-tokenizer"),
);
const http = new HttpModel({
  model: modelId,
  baseUrl,
  apiKey: key,
  apiStyle: "kimi-code",
  jsonMode: "object",
  timeoutMs: 600000,
  maxOutputTokens: 16384,
  reasoningEffort: "high",
  contextTokens,
  maxAttempts: 1,
});
const data = {
  question: test.question,
  refs: primary.evidence.map((entry) => entry.id),
  conversation: compact,
};
// No rubric, expected answer, retrieval queries or gold source IDs enter data.
const request = {
  task: "reconstruct",
  stage: `conversation/${test.id}`,
  system: SYSTEM,
  instruction: DIAGNOSTIC_INSTRUCTION,
  data,
  schema: DiagnosticAnswer.toJSONSchema({ target: "draft-7" }),
};
const messages = [
  { role: "system", content: request.system },
  {
    role: "user",
    content: JSON.stringify({
      task: request.task,
      instruction: request.instruction,
      output_schema: request.schema,
      data: request.data,
    }),
  },
];
const byteUpperBound =
  Buffer.byteLength(JSON.stringify(messages)) + 1024 + 16384;
assert(
  byteUpperBound <= contextTokens,
  "Conservative byte bound exceeds the provider's reported context.",
);
const cacheDirectories = [
  resolve(".sessionlore/peekatrack-diagnostic-v1/model-cache"),
  resolve(".sessionlore/peekatrack-placement-adjudication-v2/model-cache"),
  join(previous, "model-cache"),
];
const identity = {
  version: "conversation-pilot-v1",
  model: modelId,
  configuration: http.configuration,
  corpus_sha256: capture.corpus_sha256,
  conversation_sha256: hash(compact),
  request_sha256: hash(request),
  case_id: test.id,
};
const existing = await readJson(join(output, "manifest.json"));
if (existing)
  assert.equal(
    existing.signature,
    hash(identity),
    "Changed pilot; use another output directory.",
  );
await atomicJson(join(output, "manifest.json"), {
  ...identity,
  signature: hash(identity),
  time_filter: null,
  thread_count: compact.threads.length,
  record_count: view.stats.primary_records,
  source_count: primary.evidence.length,
  source_directory: source,
  input_view: "conversation",
  generation_budget: 1,
  http_attempt_budget: 1,
  source_text_truncated: false,
  cache_directories: cacheDirectories,
  evaluation_note:
    "Known difficult case chosen before generation. Historical answers are reused, not regenerated. The rubric is evaluation-only.",
});
await atomicJson(join(output, "request.json"), request);
await atomicJson(join(output, "wire-request.json"), {
  model: modelId,
  messages,
  response_format: { type: "json_object" },
  max_completion_tokens: 16384,
  reasoning_effort: "high",
  stream: true,
  stream_options: { include_usage: true },
});
await atomicJson(join(output, "benchmark-case.json"), test);
await atomicJson(join(output, "previous-answers.json"), oldRows);
await atomicJson(join(output, "sources.json"), primary.evidence);
const preflight = {
  ...view.stats,
  time_filter: null,
  thread_count: compact.threads.length,
  proxy_input_tokens:
    tokenizer.count(request.system) +
    tokenizer.count(messages[1].content) +
    128,
  proxy_tokenizer: tokenizer.name,
  exact_kimi_count_available: false,
  provider_context_tokens: contextTokens,
  conservative_input_plus_output_byte_bound: byteUpperBound,
  generation_budget: 1,
  cached_baseline_answers: oldRows.filter((row) => row.status === "complete")
    .length,
};
await atomicJson(join(output, "preflight.json"), preflight);
console.log(
  JSON.stringify(
    { directory: output, case_id: test.id, ...preflight },
    null,
    2,
  ),
);
if (values["prepare-only"]) process.exit(0);

let generationCalls = 0;
const model = {
  name: http.name,
  model: http.model,
  demo: false,
  configuration: http.configuration,
  async complete(actual) {
    assert.equal(
      hash(actual),
      hash(request),
      "Unexpected request or repair blocked.",
    );
    if (
      generationCalls++ ||
      (await readJson(join(output, "generation-started.json")))
    )
      throw new Error(
        "This pilot already attempted generation; inspect saved responses before retrying.",
      );
    await atomicJson(join(output, "generation-started.json"), {
      started_at: new Date().toISOString(),
      request_sha256: hash(actual),
    });
    return http.complete(actual);
  },
};
const context = new RunContext(
  "conversation-pilot",
  output,
  join(output, "model-cache"),
  model,
  tokenizer,
  {
    inputTokens: 120000,
    maxCalls: 1,
    concurrency: 1,
    cacheDirectories,
    cacheTimeouts: [180000, 600000],
  },
  (message) => console.error(message),
);
try {
  const answer = await context.ask(
    request.task,
    request.stage,
    DiagnosticAnswer,
    request.data,
    request.instruction,
  );
  await atomicJson(join(output, "answer.json"), answer);
  await writeFile(
    join(output, "answer.md"),
    [
      `# ${test.question}`,
      "",
      answer.summary,
      "",
      ...answer.facts.map(
        (fact) => `- **${fact.kind}:** ${fact.text} [${fact.refs.join(", ")}]`,
      ),
      "",
      "## Unknowns",
      "",
      ...answer.unknowns.map((text) => `- ${text}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await atomicJson(join(output, "result.json"), {
    status: "complete",
    completed_at: new Date().toISOString(),
    case_id: test.id,
    generation_calls_this_execution: generationCalls,
    calls: context.calls,
    answer,
  });
} catch (error) {
  await atomicJson(join(output, "result.json"), {
    status: "failed",
    failed_at: new Date().toISOString(),
    case_id: test.id,
    generation_calls_this_execution: generationCalls,
    calls: context.calls,
    error: error.message,
  });
  throw error;
} finally {
  await quota("quota-after").catch((error) => console.error(error.message));
}
