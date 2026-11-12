import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Corpus, type Evidence, project } from "../evidence.js";
import { type Model, ModelQuotaError } from "../model.js";
import {
  AUDIT_INSTRUCTION,
  type Audit,
  auditDetails,
  auditPassed,
  DETAIL_CHECK_VERSION,
  LEDGER_INSTRUCTION,
  type Ledger,
  makeDetailLedger,
  REVISION_INSTRUCTION,
  reviseWithDetails,
} from "./detail-check.js";
import {
  DIAGNOSTIC_INSTRUCTION,
  DiagnosticAnswer,
  type DiagnosticAnswerValue,
  DiagnosticCases,
  diagnosticInput,
  evidenceRecall,
} from "./diagnostic.js";
import { usage } from "./index.js";
import {
  REQUEST_RESULT_VERSION,
  RequestResultIndex,
} from "./request-result.js";
import { writeRetrievalComparisonHtml } from "./retrieval-report.js";
import {
  atomicJson,
  type CallRecord,
  hash,
  loadTokenizer,
  mapConcurrent,
  RunContext,
  readJson,
  type TokenCounter,
} from "./runtime.js";
import { type Embedder, HybridIndex, localEmbedder } from "./search.js";

export const RETRIEVAL_VARIANTS = [
  "current",
  "request-result",
  "checked",
] as const;
export type RetrievalVariant = (typeof RETRIEVAL_VARIANTS)[number];
export type ComparisonRow = {
  case_id: string;
  variant: RetrievalVariant;
  status: "complete" | "failed" | "blocked";
  error: string | null;
  answer: DiagnosticAnswerValue | null;
  source_ids: string[];
  input_sha256: string;
  elapsed_ms: number;
  audit?: Audit;
  model_check_passed?: boolean;
};
export type RetrievalComparisonOptions = {
  sourceDirectory: string;
  benchmarkPath: string;
  output: string;
  model: Model;
  tokenizer?: TokenCounter;
  embedder?: Embedder;
  concurrency?: number;
  prepareOnly?: boolean;
  progress?: (message: string) => void;
};
export async function runRetrievalComparison(
  options: RetrievalComparisonOptions,
) {
  if (options.model.configuration?.api_style !== "kimi-code")
    throw new Error("This retrieval comparison requires Kimi Code only.");
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Retrieval comparison concurrency must be 1–4.");
  const progress = options.progress ?? (() => {});
  const source = resolve(options.sourceDirectory),
    output = resolve(options.output);
  const benchmark = DiagnosticCases.parse(
    await readJson(options.benchmarkPath),
  );
  const manifest = await readJson<{
    corpus_sha256: string;
    time_filter: unknown;
    thread_ids: string[];
  }>(join(source, "manifest.json"));
  const corpus = await readJson<Corpus>(join(source, "corpus.json"));
  if (
    !corpus ||
    !manifest ||
    manifest.time_filter !== null ||
    hash(corpus) !== manifest.corpus_sha256
  )
    throw new Error(
      "An intact full-history capture without a time filter is required.",
    );
  if (new Set(benchmark.cases.map((c) => c.id)).size !== benchmark.cases.length)
    throw new Error("Duplicate case IDs.");
  const sourceIds = new Set(corpus.evidence.map((e) => e.id));
  for (const test of benchmark.cases)
    for (const id of [
      ...test.oracle_refs,
      ...test.groups.flatMap((g) => g.any_of),
    ])
      if (!sourceIds.has(id)) throw new Error("Unknown evaluator source " + id);
  const tokenizer =
    options.tokenizer ??
    (await loadTokenizer(resolve(".sessionlore/models/deepseek-v4-tokenizer")));
  const embedder =
    options.embedder ??
    (await localEmbedder(resolve(".sessionlore/models/huggingface")));
  const implementation = Object.fromEntries(
    await Promise.all(
      ["request-result", "detail-check"].map(async (file) => [
        file,
        hash(
          await readFile(
            new URL(
              "./" + file + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"),
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ]),
    ),
  );
  const identity = {
    version: "kimi-retrieval-comparison-v1",
    corpus_sha256: manifest.corpus_sha256,
    benchmark_sha256: hash(benchmark),
    model: options.model.model,
    configuration: options.model.configuration,
    tokenizer: tokenizer.name,
    embedding: embedder.identity,
    retrieval_budget: 24000,
    retrieval: REQUEST_RESULT_VERSION,
    checking: DETAIL_CHECK_VERSION,
    implementation,
    extraction_instruction: DIAGNOSTIC_INSTRUCTION,
    ledger_instruction: LEDGER_INSTRUCTION,
    revision_instruction: REVISION_INSTRUCTION,
    audit_instruction: AUDIT_INSTRUCTION,
  };
  const signature = hash(identity);
  type TransportChange = {
    changed_at: string;
    from_signature: string;
    to_signature: string;
    from_timeout_ms: number;
    to_timeout_ms: number;
  };
  const previous = await readJson<
    typeof identity & {
      signature: string;
      transport_changes?: TransportChange[];
    }
  >(join(output, "manifest.json"));
  const transportChanges = [...(previous?.transport_changes ?? [])];
  if (previous && previous.signature !== signature) {
    const oldIdentity = Object.fromEntries(
      Object.keys(identity).map((key) => [
        key,
        previous[key as keyof typeof identity],
      ]),
    );
    const before = previous.configuration?.timeout_ms;
    const after = identity.configuration?.timeout_ms;
    const withoutTimeout = (value: Record<string, unknown>) => ({
      ...value,
      configuration: {
        ...(value.configuration as Record<string, unknown>),
        timeout_ms: 0,
      },
    });
    if (
      typeof before !== "number" ||
      typeof after !== "number" ||
      after <= before ||
      hash(withoutTimeout(oldIdentity)) !== hash(withoutTimeout(identity))
    )
      throw new Error(
        "Comparison configuration changed; use a new output directory.",
      );
    await atomicJson(
      join(output, "manifest-history", previous.signature + ".json"),
      previous,
    );
    transportChanges.push({
      changed_at: new Date().toISOString(),
      from_signature: previous.signature,
      to_signature: signature,
      from_timeout_ms: before,
      to_timeout_ms: after,
    });
    progress(
      "Resuming with a longer HTTP timeout; model inputs and completed responses are unchanged.",
    );
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  await atomicJson(join(output, "manifest.json"), {
    signature,
    ...identity,
    transport_changes: transportChanges,
    source_directory: source,
    source_count: corpus.evidence.length,
    thread_count: manifest.thread_ids.length,
    time_filter: null,
  });
  await atomicJson(join(output, "frozen-benchmark.json"), benchmark);
  const index = await HybridIndex.build(
    corpus.evidence,
    embedder,
    join(source, "embedding-cache"),
    progress,
  );
  const episodes = new RequestResultIndex(index, corpus);
  await atomicJson(join(output, "episode-index.json"), {
    source_count: corpus.evidence.length,
    episode_count: episodes.episodes.length,
    links: episodes.links,
    episodes: episodes.episodes.map((e) => ({
      id: e.id,
      thread_id: e.thread_id,
      source_ids: e.events.flatMap((event) =>
        event.items.map((item) => item.id),
      ),
    })),
  });
  const retrieval = [];
  const bundles = new Map<
    string,
    {
      current: Evidence[];
      revised: Awaited<ReturnType<RequestResultIndex["select"]>>;
    }
  >();
  // Retrieval is complete and frozen before any new answer is generated.
  for (const test of benchmark.cases) {
    const queries = [
      ...test.queries,
      test.question + " latest correction final result verification unresolved",
    ];
    const current = await index.select(queries, [], tokenizer, 24000);
    const revised = await episodes.select(queries, [], tokenizer, 24000);
    const record = {
      case_id: test.id,
      queries,
      current: {
        ...current,
        evidence: undefined,
        source_ids: current.evidence.map((e) => e.id),
        recall: evidenceRecall(test, current.evidence, corpus.evidence),
      },
      revised: {
        ...revised,
        evidence: undefined,
        source_ids: revised.evidence.map((e) => e.id),
        recall: evidenceRecall(test, revised.evidence, corpus.evidence),
      },
    };
    await atomicJson(join(output, "retrieval", test.id + ".json"), record);
    retrieval.push(record);
    bundles.set(test.id, { current: current.evidence, revised });
    progress(
      "Prepared " +
        test.id +
        ": " +
        current.evidence.length +
        " current / " +
        revised.evidence.length +
        " request-to-result fragments",
    );
  }
  if (options.prepareOnly)
    return {
      directory: output,
      prepared: true,
      rows: [] as ComparisonRow[],
      retrieval,
    };
  const contexts = Object.fromEntries(
    RETRIEVAL_VARIANTS.map((variant) => [
      variant,
      new RunContext(
        variant,
        join(output, variant),
        join(output, "model-cache"),
        options.model,
        tokenizer,
        {
          inputTokens: 60000,
          maxCalls: 300,
          concurrency,
          cacheTimeouts: transportChanges.map(
            (change) => change.from_timeout_ms,
          ),
        },
        progress,
      ),
    ]),
  ) as Record<RetrievalVariant, RunContext>;
  const rows: ComparisonRow[] = [];
  let quotaFailure: ModelQuotaError | undefined;
  const checkQuota = () => {
    if (quotaFailure) throw quotaFailure;
  };
  await mapConcurrent(benchmark.cases, concurrency, async (test) => {
    const bundle = bundles.get(test.id)!;
    const evidence = bundle.revised.evidence;
    const detailContext = {
      question: test.question,
      evidence,
      roles: bundle.revised.roles,
      links: bundle.revised.links,
    };
    for (const variant of RETRIEVAL_VARIANTS) {
      const path = join(output, variant, test.id + ".json");
      const saved = await readJson<ComparisonRow>(path);
      if (saved?.status === "complete") {
        rows.push(saved);
        continue;
      }
      const supplied = variant === "current" ? bundle.current : evidence;
      const input = diagnosticInput(test, supplied);
      const started = Date.now();
      let answer: DiagnosticAnswerValue | null = null,
        error: string | null = null;
      let audit: Audit | undefined;
      let quotaBlocked = false;
      try {
        checkQuota();
        const ctx = contexts[variant];
        if (variant !== "checked")
          answer = await ctx.ask(
            "reconstruct",
            variant + "/" + test.id,
            DiagnosticAnswer,
            input,
            DIAGNOSTIC_INSTRUCTION,
          );
        else {
          const draft = rows.find(
            (r) => r.case_id === test.id && r.variant === "request-result",
          )?.answer;
          if (!draft)
            throw new Error("Request-to-result draft is unavailable.");
          const ledgerPath = join(output, "checks", test.id, "ledger.json");
          const ledger =
            (await readJson<Ledger>(ledgerPath)) ??
            (await makeDetailLedger(ctx, "ledger/" + test.id, detailContext));
          await atomicJson(ledgerPath, ledger);
          checkQuota();
          const revisionPath = join(output, "checks", test.id, "revision.json");
          const revision =
            (await readJson<Awaited<ReturnType<typeof reviseWithDetails>>>(
              revisionPath,
            )) ??
            (await reviseWithDetails(
              ctx,
              "revise/" + test.id,
              detailContext,
              ledger,
              draft,
            ));
          await atomicJson(revisionPath, revision);
          answer = revision.answer;
          checkQuota();
          audit = await auditDetails(
            ctx,
            "audit/" + test.id,
            detailContext,
            ledger,
            answer,
          );
          await atomicJson(
            join(output, "checks", test.id, "audit.json"),
            audit,
          );
        }
      } catch (failure) {
        if (failure instanceof ModelQuotaError) {
          quotaFailure = failure;
          quotaBlocked = true;
        }
        error = failure instanceof Error ? failure.message : "Unknown failure";
      }
      const row: ComparisonRow = {
        case_id: test.id,
        variant,
        status: quotaBlocked ? "blocked" : error ? "failed" : "complete",
        error,
        answer,
        source_ids: supplied.map((e) => e.id),
        input_sha256: hash(input),
        elapsed_ms: Date.now() - started,
        ...(audit ? { audit, model_check_passed: auditPassed(audit) } : {}),
      };
      await atomicJson(path, row);
      rows.push(row);
      progress(
        variant +
          " " +
          test.id +
          ": " +
          row.status +
          (audit
            ? " (detail check " +
              (auditPassed(audit) ? "clear" : "needs review") +
              ")"
            : ""),
      );
    }
  });
  rows.sort(
    (a, b) =>
      benchmark.cases.findIndex((c) => c.id === a.case_id) -
        benchmark.cases.findIndex((c) => c.id === b.case_id) ||
      RETRIEVAL_VARIANTS.indexOf(a.variant) -
        RETRIEVAL_VARIANTS.indexOf(b.variant),
  );
  const costs = [];
  for (const variant of RETRIEVAL_VARIANTS) {
    let calls: CallRecord[] = [];
    try {
      calls = (await readFile(join(output, variant, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CallRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    costs.push({
      variant,
      ...usage(calls),
      billing: "Kimi Code subscription quota; unknown usage is not zero.",
    });
  }
  const result = {
    identity,
    source_count: corpus.evidence.length,
    thread_count: manifest.thread_ids.length,
    time_filter: null,
    rows,
    retrieval,
    costs,
    limitations:
      "Known-topic diagnostic, not automatic discovery of every workstream. Full frozen corpus indexed. Identical questions, model, 24k source budgets and extraction instruction. Checked variant adds a source-only checklist, revision and separate final model audit. That audit is not independent ground truth. Episode omissions and adjacency-only links are explicit.",
  };
  await atomicJson(join(output, "comparison.json"), result);
  const selected = new Set(rows.flatMap((r) => r.source_ids));
  const originals = corpus.evidence.filter((e) => selected.has(e.id));
  await atomicJson(join(output, "selected-originals.json"), originals);
  const lines = ["# Kimi retrieval comparison", "", result.limitations, ""];
  for (const test of benchmark.cases) {
    lines.push("## " + test.id, "", test.question, "");
    for (const row of rows.filter((r) => r.case_id === test.id)) {
      lines.push(
        "### " + row.variant,
        "",
        row.answer?.summary ?? "Failed: " + row.error,
        "",
      );
      for (const fact of row.answer?.facts ?? [])
        lines.push("- " + fact.text + " [" + fact.refs.join(", ") + "]");
      for (const unknown of row.answer?.unknowns ?? [])
        lines.push("- Unknown: " + unknown);
      lines.push("");
    }
  }
  await writeFile(join(output, "answers.md"), lines.join("\n"), {
    mode: 0o600,
  });
  await writeRetrievalComparisonHtml(
    output,
    result,
    benchmark.cases,
    originals,
  );
  return { directory: output, prepared: false, ...result };
}
