import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ingest,
  ingestFiles,
  loadEvidence,
  type Project,
} from "@sessionlore/core";
import {
  conversationView,
  type EvidenceView,
  selectEvidenceView,
} from "../conversation.js";
import { type Corpus, corpusFromBatches, project } from "../evidence.js";
import type { Model, ModelResponse } from "../model.js";
import { plain } from "../writing.js";
import {
  GUARDED_READING_VERSION,
  type GuardedReadingOptions,
  guardedReadingPipeline,
} from "./guarded-reading.js";
import {
  type Chunk,
  chunkEvidence,
  hierarchyPipeline,
  hybridPipeline,
  LONG_APPROACHES,
  LONG_NAMES,
  type LongApproach,
  recursivePipeline,
} from "./pipelines.js";
import { writeComparisonHtml } from "./report.js";
import {
  atomicJson,
  type CallRecord,
  hash,
  loadTokenizer,
  RunContext,
  readJson,
  type TokenCounter,
} from "./runtime.js";
import {
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  type Embedder,
  HybridIndex,
  localEmbedder,
} from "./search.js";
import { type LongDraft, type Review, writeLongNarrative } from "./writing.js";

export type { LongApproach };
export { LONG_APPROACHES, LONG_NAMES };
export type LongOptions = {
  input: string;
  sourceDirectory?: string;
  cleanedDirectory?: string;
  output: string;
  model: Model;
  guardedRecursive?: GuardedReadingOptions;
  project?: Project;
  approaches?: LongApproach[];
  tokenizerPath?: string;
  chunkTokens?: number;
  inputTokens?: number;
  concurrency?: number;
  maxCalls?: number;
  maxRepairs?: number;
  cacheDirectories?: string[];
  targetWords?: number;
  prepareOnly?: boolean;
  evidenceView?: EvidenceView;
  tokenizer?: TokenCounter;
  embedder?: Embedder;
  progress?: (message: string) => void;
};
export type LongResult = {
  approach: LongApproach;
  status: "complete" | "failed";
  reason: string | null;
  elapsed_ms: number;
  calls: number;
  cached_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  usage_unknown_calls: number;
  cost_usd_range: [number, number] | null;
  metrics: Awaited<ReturnType<typeof writeLongNarrative>>["metrics"] | null;
};
export function usage(records: CallRecord[]) {
  // Preserve every network attempt, including an unknown outcome before a
  // successful retry. Count cache-only history once, without charging replays.
  const paid = records.filter((call) => !call.cache_hit);
  const paidKeys = new Set(
    paid
      .filter(
        (call) => call.input_tokens !== null && call.output_tokens !== null,
      )
      .map((call) => call.key),
  );
  const replayed = new Map(
    records
      .filter((call) => call.cache_hit && !paidKeys.has(call.key))
      .map((call) => [call.key, call]),
  );
  const calls = [...paid, ...replayed.values()];
  const input = calls.reduce((sum, call) => sum + (call.input_tokens ?? 0), 0);
  const output = calls.reduce(
    (sum, call) => sum + (call.output_tokens ?? 0),
    0,
  );
  const hit = calls.reduce((sum, call) => sum + call.cache_hit_tokens, 0);
  const unknown = calls.filter(
    (call) => call.input_tokens === null || call.output_tokens === null,
  ).length;
  return {
    calls: calls.length,
    cached_calls: calls.filter((call) => call.cache_hit).length,
    input_tokens: input,
    output_tokens: output,
    cache_hit_tokens: hit,
    usage_unknown_calls: unknown,
  };
}
export function flashCost(
  input: number,
  output: number,
  hits: number,
): [number, number] {
  const low =
    (Math.max(0, input - hits) * 0.15 + hits * 0.003 + output * 0.6) / 1e6;
  return [low, low * 2];
}

export async function runLongComparison(input: LongOptions) {
  const progress = input.progress ?? (() => {});
  const output = resolve(input.output);
  const approaches = input.approaches ?? [...LONG_APPROACHES];
  if (
    !approaches.length ||
    approaches.some((name) => !LONG_APPROACHES.includes(name))
  )
    throw new Error("Invalid full-history approach");
  const options = {
    chunkTokens: input.chunkTokens ?? 16000,
    inputTokens: input.inputTokens ?? 60000,
    concurrency: input.concurrency ?? 8,
    maxCalls: input.maxCalls ?? 3000,
    targetWords: input.targetWords ?? 1800,
  };
  const evidenceView = input.evidenceView ?? "conversation";
  if (evidenceView !== "conversation" && evidenceView !== "execution")
    throw new Error("Unknown evidence view.");
  for (const [name, value] of Object.entries(options))
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
  if (options.chunkTokens < 4000 || options.chunkTokens > 18000)
    throw new Error(
      "chunkTokens must be 4000–18000; source fragments and two-chunk reader calls must fit.",
    );
  if (options.inputTokens < 50000)
    throw new Error(
      "Full-history comparison requires a per-call input budget of at least 50000 tokens, plus model output space.",
    );
  if (options.concurrency > 32)
    throw new Error("Use at most 32 concurrent model calls.");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const tokenizer =
    input.tokenizer ??
    (await loadTokenizer(
      resolve(
        input.tokenizerPath ?? ".sessionlore/models/deepseek-v4-tokenizer",
      ),
    ));
  const signature = hash({
    version: "full-history-v3-first-person-batched",
    evidenceView,
    input: resolve(input.input),
    sourceDirectory: input.sourceDirectory
      ? resolve(input.sourceDirectory)
      : null,
    cleanedDirectory: input.cleanedDirectory
      ? resolve(input.cleanedDirectory)
      : null,
    project: input.project?.id,
    model: input.model.model,
    provider: input.model.name,
    configuration: input.model.configuration,
    ...(input.guardedRecursive
      ? {
          guarded_reading: {
            version: GUARDED_READING_VERSION,
            seed_directory: resolve(input.guardedRecursive.seedDirectory),
            controller: input.guardedRecursive.controller.model,
            controller_configuration:
              input.guardedRecursive.controller.configuration,
          },
        }
      : {}),
    tokenizer: tokenizer.name,
    chunkTokens: options.chunkTokens,
    inputTokens: options.inputTokens,
    targetWords: options.targetWords,
    embedding:
      input.embedder?.identity ?? `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}`,
  });
  type Manifest = {
    signature: string;
    source_ids: string[];
    corpus_sha256: string;
    created_at: string;
    [key: string]: unknown;
  };
  let manifest = await readJson<Manifest>(join(output, "manifest.json"));
  if (manifest && manifest.signature !== signature)
    throw new Error(
      "This output directory belongs to different inputs or model settings. Use a new --out directory. Existing results were preserved.",
    );
  let corpus: Corpus;
  if (!manifest) {
    progress("Capturing the complete project, with no time filter");
    if (input.sourceDirectory) {
      const source = resolve(input.sourceDirectory);
      const frozen = await readJson<Manifest>(join(source, "manifest.json"));
      const captured = await readJson<Corpus>(join(source, "corpus.json"));
      if (
        !frozen ||
        !captured ||
        frozen.time_filter !== null ||
        hash(captured) !== frozen.corpus_sha256
      )
        throw new Error(
          "An intact full-history capture without a time filter is required",
        );
      corpus = captured;
      manifest = {
        ...frozen,
        signature,
        version: "full-history-v3-first-person-batched",
        evidence_view: evidenceView,
        created_at: new Date().toISOString(),
        source_capture: source,
        model: {
          provider: input.model.name,
          model: input.model.model,
          configuration: input.model.configuration,
        },
        tokenizer: tokenizer.name,
        options,
      };
      await atomicJson(join(output, "corpus.json"), corpus);
      await atomicJson(join(output, "manifest.json"), manifest);
    } else {
      const report = input.project
        ? await ingestFiles(
            input.project.rollouts.map((item) => item.path),
            join(output, "evidence"),
          )
        : await ingest(input.input, join(output, "evidence"));
      const batches = await loadEvidence(
        join(output, "evidence"),
        report.source_ids,
      );
      // Recorded changes and test outputs already occur in events; do not append a second artifact copy.
      corpus = corpusFromBatches(batches, [], 6000);
      if (!corpus.evidence.length)
        throw new Error("No projected text in the full project");
      await atomicJson(join(output, "corpus.json"), corpus);
      manifest = {
        signature,
        version: "full-history-v3-first-person-batched",
        evidence_view: evidenceView,
        created_at: new Date().toISOString(),
        input: resolve(input.input),
        project: input.project ?? null,
        source_ids: report.source_ids,
        corpus_sha256: hash(corpus),
        total_events: batches.reduce(
          (sum, batch) => sum + batch.events.length,
          0,
        ),
        thread_ids: [
          ...new Set(
            batches.flatMap((batch) =>
              batch.events.map((event) => event.thread_id),
            ),
          ),
        ],
        model: {
          provider: input.model.name,
          model: input.model.model,
          configuration: input.model.configuration,
        },
        tokenizer: tokenizer.name,
        options,
        time_filter: null,
        extra_artifact_copies: false,
        embedding_model: EMBEDDING_MODEL,
        embedding_revision: EMBEDDING_REVISION,
      };
      await atomicJson(join(output, "manifest.json"), manifest);
    }
  } else {
    // Verify captured raw hashes and adapter version before reusing results.
    if (!manifest.source_capture)
      await loadEvidence(join(output, "evidence"), manifest.source_ids);
    corpus = (await readJson<Corpus>(join(output, "corpus.json")))!;
    if (!corpus || hash(corpus) !== manifest.corpus_sha256)
      throw new Error("Frozen corpus integrity check failed");
  }
  const archive = corpus;
  const view = conversationView(archive);
  corpus = selectEvidenceView(archive, evidenceView);
  if (input.cleanedDirectory) {
    const cleaned = await readJson<Corpus>(
      join(resolve(input.cleanedDirectory), "primary-corpus.json"),
    );
    const compact = await readJson<unknown>(
      join(resolve(input.cleanedDirectory), "conversation.json"),
    );
    if (
      evidenceView !== "conversation" ||
      !cleaned ||
      !compact ||
      hash(cleaned) !== hash(corpus) ||
      hash(compact) !== hash(view.compact)
    )
      throw new Error(
        "The selected input does not match the requested frozen cleaned conversation",
      );
  }
  if (!corpus.evidence.length)
    throw new Error(
      "No conversation messages or explicit artifacts in the selected input.",
    );
  await atomicJson(join(output, "primary-corpus.json"), corpus);
  await atomicJson(join(output, "conversation.json"), view.compact);
  await atomicJson(join(output, "input-view.json"), {
    selected: evidenceView,
    ...view.stats,
  });
  let chunks = await readJson<Chunk[]>(join(output, "chunks.json"));
  if (!chunks) {
    progress(`Tokenizing all ${corpus.evidence.length} source fragments`);
    chunks = chunkEvidence(corpus.evidence, tokenizer, options.chunkTokens);
    await atomicJson(join(output, "chunks.json"), chunks);
  }
  const preflight = {
    primary_corpus_sha256: hash(corpus),
    conversation_sha256: hash(view.compact),
    token_estimate_note:
      "Local tokenizer proxy; provider usage is the measured Kimi token count.",
    evidence_view: evidenceView,
    archived_fragments: archive.evidence.length - corpus.evidence.length,
    raw_fragments: archive.evidence.length,
    source_files: manifest.source_ids.length,
    thread_ids: manifest.thread_ids,
    total_events: manifest.total_events,
    fragments: corpus.evidence.length,
    text_characters: corpus.evidence.reduce(
      (sum, item) => sum + item.text.length,
      0,
    ),
    tool_result_characters: corpus.evidence
      .filter((item) => item.actor === "tool" && item.event_kind === "result")
      .reduce((sum, item) => sum + item.text.length, 0),
    projected_input_tokens: chunks.reduce(
      (sum, chunk) => sum + chunk.tokens,
      0,
    ),
    chunks: chunks.length,
    largest_chunk_tokens: Math.max(...chunks.map((chunk) => chunk.tokens)),
    excluded_events: corpus.excluded_events.length,
    time_filter: null,
    complete_chunk_coverage:
      chunks.flatMap((chunk) => chunk.refs).length === corpus.evidence.length,
  };
  await atomicJson(join(output, "preflight.json"), preflight);
  progress(
    `Primary ${evidenceView} input: ${preflight.fragments} fragments, ${preflight.chunks} chunks, ${preflight.projected_input_tokens} projected tokens; ${preflight.archived_fragments} fragments kept in the local archive`,
  );
  if (input.prepareOnly) return { directory: output, preflight, results: [] };
  const embedder =
    input.embedder ??
    (await localEmbedder(resolve(".sessionlore/models/huggingface")));
  const index = await HybridIndex.build(
    corpus.evidence,
    embedder,
    join(output, "embedding-cache"),
    progress,
  );
  await atomicJson(join(output, "index.json"), {
    method: "BM25 + dense cosine, reciprocal-rank fusion (k=60)",
    embedding: embedder.identity,
    source_count: corpus.evidence.length,
    all_source_text_embedded: true,
    embedding_limitations:
      "English MiniLM encoder. Every 240-wordpiece window is embedded and pooled; Unicode BM25 also indexes Chinese terms. Mean pooling can dilute a small detail in a large source fragment.",
  });
  await writeFile(
    join(output, "sources.md"),
    [
      "# Complete projected source evidence",
      "",
      ...corpus.evidence.map((source) => {
        const fence = "`".repeat(
          Math.max(
            3,
            ...[...source.text.matchAll(/`+/g)].map(
              (match) => match[0].length + 1,
            ),
          ),
        );
        return `## ${source.id}\n\n${plain(JSON.stringify({ ...source, text: undefined }))}\n\n${fence}text\n${source.text}\n${fence}\n`;
      }),
    ].join("\n"),
    { mode: 0o600 },
  );
  const results: LongResult[] = [];
  for (const approach of approaches) {
    const directory = join(output, approach);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const previous = await readJson<LongResult>(join(directory, "result.json"));
    if (previous?.status === "complete") {
      results.push(previous);
      progress(`${approach}: reusing completed result`);
      continue;
    }
    const ctx = new RunContext(
      approach,
      directory,
      join(output, "model-cache"),
      input.model,
      tokenizer,
      {
        ...options,
        ...(input.maxRepairs === undefined
          ? {}
          : { maxRepairs: input.maxRepairs }),
        ...(input.cacheDirectories
          ? { cacheDirectories: input.cacheDirectories }
          : {}),
      },
      progress,
    );
    const started = Date.now();
    let metrics: LongResult["metrics"] = null;
    let reason: string | null = null;
    try {
      const prepared =
        approach === "hierarchy" || approach === "hierarchy-retrieval"
          ? await hierarchyPipeline(
              ctx,
              chunks,
              index,
              approach === "hierarchy-retrieval",
            )
          : approach === "hybrid"
            ? await hybridPipeline(ctx, index)
            : input.guardedRecursive
              ? await guardedReadingPipeline(
                  ctx,
                  chunks,
                  index,
                  input.guardedRecursive,
                )
              : await recursivePipeline(ctx, chunks, index);
      await ctx.save("prepared", prepared);
      metrics = (
        await writeLongNarrative(ctx, prepared, index, options.targetWords)
      ).metrics;
    } catch (error) {
      reason =
        error instanceof Error ? error.message : "Unknown pipeline error";
      await ctx.save("coverage-incomplete", {
        read_source_ids: [...ctx.readSources],
        total_sources: corpus.evidence.length,
      });
    }
    const history = (
      await readFile(join(directory, "calls.jsonl"), "utf8").catch(() => "")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CallRecord);
    const counts = usage(history);
    counts.usage_unknown_calls = history.filter(
      (call) =>
        !call.cache_hit &&
        (call.input_tokens === null || call.output_tokens === null),
    ).length;
    const result: LongResult = {
      approach,
      status: reason ? "failed" : "complete",
      reason,
      elapsed_ms: (previous?.elapsed_ms ?? 0) + Date.now() - started,
      ...counts,
      cost_usd_range:
        input.model.model === "deepseek-flash"
          ? flashCost(
              counts.input_tokens,
              counts.output_tokens,
              counts.cache_hit_tokens,
            )
          : null,
      metrics,
    };
    await ctx.save("result", result);
    results.push(result);
    progress(`${approach}: ${result.status}${reason ? `: ${reason}` : ""}`);
    await atomicJson(join(output, "comparison.json"), {
      directory: output,
      preflight,
      results,
    });
  }
  // Include previously completed methods when resuming only a failed subset.
  for (const approach of LONG_APPROACHES)
    if (!results.some((result) => result.approach === approach)) {
      const previous = await readJson<LongResult>(
        join(output, approach, "result.json"),
      );
      if (previous) results.push(previous);
    }
  const cacheFiles = await readdir(join(output, "model-cache")).catch(
    () => [] as string[],
  );
  const paid: ModelResponse[] = [];
  for (const file of cacheFiles.filter((file) => file.endsWith(".json"))) {
    const entry = await readJson<{ response: ModelResponse }>(
      join(output, "model-cache", file),
    );
    if (entry) paid.push(entry.response);
  }
  const total = {
    successful_http_responses: paid.length,
    input_tokens: paid.reduce((sum, item) => sum + (item.input_tokens ?? 0), 0),
    output_tokens: paid.reduce(
      (sum, item) => sum + (item.output_tokens ?? 0),
      0,
    ),
    cache_hit_tokens: paid.reduce(
      (sum, item) => sum + (item.cache_hit_tokens ?? 0),
      0,
    ),
    unreported_usage_attempts: 0,
  };
  for (const approach of LONG_APPROACHES) {
    const log = await readFile(
      join(output, approach, "calls.jsonl"),
      "utf8",
    ).catch(() => "");
    total.unreported_usage_attempts += log
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CallRecord)
      .filter(
        (call) =>
          !call.cache_hit &&
          (call.input_tokens === null || call.output_tokens === null),
      ).length;
  }
  const comparison = {
    directory: output,
    model: input.model.model,
    preflight,
    results,
    paid_usage: {
      ...total,
      cost_usd_range:
        input.model.model === "deepseek-flash"
          ? flashCost(
              total.input_tokens,
              total.output_tokens,
              total.cache_hit_tokens,
            )
          : null,
    },
    pricing_source:
      input.model.configuration?.api_style === "kimi-code"
        ? "https://www.kimi.com/code/docs/en/kimi-code/membership.html"
        : "https://api-docs.deepseek.com/quick_start/pricing/",
    billing:
      input.model.configuration?.api_style === "kimi-code"
        ? "Kimi Code subscription quota; no per-call dollar invoice returned."
        : "Provider usage; price estimates available for DeepSeek Flash only.",
    limits:
      "Costs are a peak/off-peak range from reported usage, not an invoice. Per-method figures include repairs, restarted attempts, and reusable cached calls; total paid usage counts each saved HTTP response once. Unreported-usage attempts are counted separately. Runtime sums method execution attempts and includes cache effects, but excludes shared capture/index preparation. This is one run per method, with unequal actual word counts. Automated verification is not independent ground truth.",
  };
  await atomicJson(join(output, "comparison.json"), comparison);
  const rows = results.map(
    (result) =>
      `| [${LONG_NAMES[result.approach]}](${result.approach}/narrative.md) | ${result.status} | ${result.calls} (${result.cached_calls} reused) | ${result.input_tokens.toLocaleString()} / ${result.output_tokens.toLocaleString()} | ${result.cost_usd_range?.map((n) => `$${n.toFixed(3)}`).join("–") ?? "unknown"} | ${result.metrics?.draft_words ?? "—"} / ${result.metrics?.reviewed_words ?? "—"} | ${result.metrics ? `${result.metrics.supported}/${result.metrics.draft_claims}` : "—"} | ${result.metrics ? `${(result.metrics.source_characters_read_fraction * 100).toFixed(1)}%` : "—"} | ${(result.elapsed_ms / 60000).toFixed(1)} |`,
  );
  await writeFile(
    join(output, "comparison.md"),
    [
      "# Full PeekaTrack history: model comparison",
      "",
      `Model: ${input.model.model}. ${preflight.source_files} source files; ${preflight.fragments} projected fragments; ${preflight.projected_input_tokens.toLocaleString()} projected tokens. No time filter. Extra artifact copies are omitted because their original events remain in the corpus.`,
      "",
      "| Approach | Status | Calls | Input / output tokens | Recorded method cost range | Draft / reviewed words | Supported / drafted claims | Source characters read before review | Minutes |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      comparison.limits,
      comparison.billing,
      "",
      `Total saved paid responses: ${total.successful_http_responses}; input ${total.input_tokens.toLocaleString()}, output ${total.output_tokens.toLocaleString()}. Estimated total: ${comparison.paid_usage.cost_usd_range?.map((n) => `$${n.toFixed(3)}`).join("–") ?? "unknown"}. Attempts with unreported usage: ${total.unreported_usage_attempts}. [Pricing source](${comparison.pricing_source}).`,
      "",
      "Open comparison.html for the side-by-side reader. Each method retains draft.md, narrative.md, verification.json, coverage.json, prepared.json, and calls.jsonl. model-cache contains the exact prompts and responses. Coverage measures source processing, not recall of important events.",
      "",
      ...results
        .filter((result) => result.reason)
        .map((result) => `- ${result.approach}: ${result.reason}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const documents = await Promise.all(
    results
      .filter((result) => result.status === "complete")
      .map(async (result) => ({
        result,
        draft: (await readJson<LongDraft>(
          join(output, result.approach, "draft.json"),
        ))!,
        reviews: (await readJson<{ reviews: Review[] }>(
          join(output, result.approach, "verification.json"),
        ))!.reviews,
      })),
  );
  await writeComparisonHtml(output, comparison, documents, corpus.evidence);
  return comparison;
}
