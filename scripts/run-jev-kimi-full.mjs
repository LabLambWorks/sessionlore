import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { prepareGuardedReading } from "../packages/experiments/dist/long/guarded-reading.js";
import { runLongComparison } from "../packages/experiments/dist/long/index.js";
import { chunkEvidence } from "../packages/experiments/dist/long/pipelines.js";
import {
  atomicJson,
  loadTokenizer,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  createMixedModels,
  JEV_LIMITS,
  MIXED_LIMITS,
} from "./mixed-provider-models.mjs";

const { values } = parseArgs({
  options: { run: { type: "boolean", default: false } },
});
const seed = resolve(".sessionlore/peekatrack-kimi-four-cleaned-v1");
const output = resolve(".sessionlore/peekatrack-jev-kimi-full-v1");
await mkdir(output, { recursive: true, mode: 0o700 });
const completed = await readJson(join(seed, "COMPLETED.json"));
if (completed?.status !== "all_four_complete")
  throw new Error("The Kimi-only baseline is not complete");
const corpusBytes = await readFile(join(seed, "primary-corpus.json"));
if (
  createHash("sha256").update(corpusBytes).digest("hex") !==
  completed.inputs.primary_corpus_sha256
)
  throw new Error("Frozen primary corpus changed");
const corpus = JSON.parse(corpusBytes);
const tokenizer = await loadTokenizer(
  resolve(".sessionlore/models/deepseek-v4-tokenizer"),
);
const chunks = chunkEvidence(corpus.evidence, tokenizer, 16000);
const preflight = await prepareGuardedReading(
  corpus.evidence,
  chunks,
  tokenizer,
  seed,
);
if (preflight.batches.length > JEV_LIMITS.calls)
  throw new Error(
    "Complete history needs more decisions than the fixed allowance",
  );
const settings = {
  version: "guarded-jev-kimi-v2",
  seed,
  inputs: completed.inputs,
  models: {
    decisions: "jev-1.14.0",
    writing: "k3.1-pro",
    reasoning_effort: "high",
  },
  limits: { kimi: MIXED_LIMITS, jev: JEV_LIMITS },
  source_notes: preflight.byChunk.size,
  reading_batches: preflight.batches.length,
  new_source_summary_generations_allowed: 0,
  target_words: 1800,
  caveat:
    "This changes the controller and adds full-coverage guards while reusing existing source summaries. It is not an isolated model swap. Incremental usage is reported separately from reused work.",
};
await atomicJson(join(output, "preflight.json"), settings);
console.log(JSON.stringify(settings, null, 2));
if (!values.run) process.exit(0);
const lockPath = join(output, "run.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(
  JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
);
let clients;
try {
  loadEnvFile();
  clients = await createMixedModels(output);
  const result = await runLongComparison({
    input: ".sessionlore/cases/peekatrack/sessions",
    sourceDirectory: ".sessionlore/peekatrack-full-deepseek-v1",
    cleanedDirectory: ".sessionlore/peekatrack-conversation-v1",
    output,
    model: clients.model,
    guardedRecursive: { controller: clients.controller, seedDirectory: seed },
    approaches: ["recursive"],
    evidenceView: "conversation",
    targetWords: 1800,
    chunkTokens: 16000,
    inputTokens: 140000,
    concurrency: 1,
    maxCalls: 50,
    maxRepairs: 1,
    cacheDirectories: [join(seed, "model-cache")],
    tokenizer,
    progress: (message) =>
      console.error(`${new Date().toISOString()} ${message}`),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (clients)
    await clients
      .quota("quota-after")
      .catch((error) => console.error(error.message));
  await lock.close();
  await rm(lockPath);
}
