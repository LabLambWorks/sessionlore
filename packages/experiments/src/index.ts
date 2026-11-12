import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ingest,
  ingestFiles,
  loadEvidence,
  type Project,
} from "@sessionlore/core";
import { artifact, sessionArtifacts } from "./artifacts.js";
import { Context, PipelineLimit, saveJson } from "./context.js";
import {
  conversationView,
  type EvidenceView,
  selectEvidenceView,
} from "./conversation.js";
import { corpusFromBatches, sha256, unique } from "./evidence.js";
import type { Model } from "./model.js";
import { pivot } from "./pivot.js";
import { retrieval } from "./retrieval.js";
import {
  APPROACH_NAMES,
  type Approach,
  type Artifact,
  ArtifactFileSchema,
  OptionsSchema,
  type PipelineOptions,
} from "./schema.js";
import { direct, hierarchical } from "./shared.js";
import { workstream } from "./workstream.js";
import { plain, writeAndVerify } from "./writing.js";

export { gitArtifacts, readArtifacts } from "./artifacts.js";
export {
  conversationView,
  readArchivedEvidence,
  selectEvidenceView,
} from "./conversation.js";
export { DemoModel } from "./demo.js";
export { runConversationNarrative } from "./long/conversation-narrative.js";
export {
  auditDetails,
  makeDetailLedger,
  reviseWithDetails,
} from "./long/detail-check.js";
export { runEvidenceDiagnostic } from "./long/diagnostic.js";
export {
  LONG_APPROACHES,
  LONG_NAMES,
  type LongApproach,
  runLongComparison,
} from "./long/index.js";
export { prepareConversationCapture } from "./long/prepare-conversation.js";
export { RequestResultIndex } from "./long/request-result.js";
export { runRetrievalComparison } from "./long/retrieval-comparison.js";
export {
  HttpModel,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "./model.js";
export {
  APPROACH_NAMES,
  APPROACHES,
  type Approach,
  type Artifact,
  type PipelineOptions,
} from "./schema.js";

const pipelines = {
  direct,
  hierarchical,
  pivot,
  workstream,
  retrieval,
  artifact,
};
type QualityMetrics = Awaited<ReturnType<typeof writeAndVerify>>;
export type ApproachResult = {
  approach: Approach;
  status: "complete" | "failed" | "skipped";
  reason: string | null;
  directory: string;
  elapsed_ms: number;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  quality: QualityMetrics | null;
  warnings: string[];
};
export type RunOptions = {
  input: string;
  output: string;
  approaches: Approach[];
  model: Model;
  artifacts?: Artifact[];
  includeSessionArtifacts?: boolean;
  evidenceView?: EvidenceView;
  project?: Project;
  options?: Partial<PipelineOptions>;
  progress?: (message: string) => void;
};

export async function runExperiment(
  input: RunOptions,
): Promise<{ directory: string; demo: boolean; results: ApproachResult[] }> {
  const options = OptionsSchema.parse(input.options ?? {});
  if (
    options.since &&
    options.until &&
    Date.parse(options.since) >= Date.parse(options.until)
  )
    throw new Error("--since must be earlier than --until.");
  const withinWindow = (timestamp: string | null) =>
    !(options.since || options.until) ||
    (timestamp !== null &&
      (!options.since || Date.parse(timestamp) >= Date.parse(options.since)) &&
      (!options.until || Date.parse(timestamp) < Date.parse(options.until)));
  if (options.block_chars > options.context_chars * 0.5)
    throw new Error(
      "--block-chars must be at most half of --context-chars to leave space for instructions and output schemas.",
    );
  const approaches = unique(input.approaches);
  if (!approaches.length || approaches.some((name) => !(name in pipelines)))
    throw new Error("Select at least one valid approach.");
  const suppliedArtifacts = ArtifactFileSchema.parse({
    version: 1,
    artifacts: input.artifacts ?? [],
  }).artifacts;
  const artifacts = suppliedArtifacts.filter((artifact) =>
    withinWindow(artifact.timestamp),
  );
  if (
    unique(suppliedArtifacts.map((item) => item.id)).length !==
    suppliedArtifacts.length
  )
    throw new Error("Artifact IDs must be unique across all inputs.");
  const directory = join(
    resolve(input.output),
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  input.progress?.("Capturing input evidence");
  const report = input.project
    ? await ingestFiles(
        input.project.rollouts.map((item) => item.path),
        join(directory, "evidence"),
      )
    : await ingest(input.input, join(directory, "evidence"));
  const batches = await loadEvidence(
    join(directory, "evidence"),
    report.source_ids,
  );
  const selectedBatches = batches.map((batch) => ({
    ...batch,
    events: batch.events.filter((event) => withinWindow(event.timestamp)),
  }));
  if (input.includeSessionArtifacts)
    artifacts.push(...sessionArtifacts(selectedBatches));
  if (unique(artifacts.map((item) => item.id)).length !== artifacts.length)
    throw new Error(
      "Artifact IDs must be unique across exports and captured observations.",
    );
  const archive = corpusFromBatches(
    selectedBatches,
    artifacts,
    Math.max(250, Math.floor(options.block_chars * 0.6)),
  );
  archive.excluded_events.push(
    ...batches.flatMap((batch) =>
      batch.events
        .filter((event) => !withinWindow(event.timestamp))
        .map((event) => ({
          event_id: event.event_id,
          reason:
            "Outside the explicitly selected time window, or missing a timestamp.",
        })),
    ),
  );
  if (!archive.evidence.length)
    throw new Error(
      "Input has no text evidence. Inspect the ingestion report and raw snapshots.",
    );
  const evidenceView = input.evidenceView ?? "conversation";
  const corpus = selectEvidenceView(archive, evidenceView);
  if (!corpus.evidence.length)
    throw new Error(
      "No conversation messages or explicit artifacts in the selected input.",
    );
  await saveJson(join(directory, "corpus.json"), archive);
  await saveJson(join(directory, "primary-corpus.json"), corpus);
  await saveJson(join(directory, "input-view.json"), {
    selected: evidenceView,
    ...conversationView(archive).stats,
  });
  await saveJson(join(directory, "artifacts.json"), { version: 1, artifacts });
  await saveJson(join(directory, "artifact-input.json"), {
    version: 1,
    artifacts: suppliedArtifacts,
  });
  await saveJson(join(directory, "manifest.json"), {
    version: "experiments-0.1.0",
    created_at: new Date().toISOString(),
    input: resolve(input.input),
    project: input.project ?? null,
    source_ids: report.source_ids,
    corpus_sha256: sha256(JSON.stringify(archive)),
    evidence_view: evidenceView,
    primary_corpus_sha256: sha256(JSON.stringify(corpus)),
    model: {
      provider: input.model.name,
      model: input.model.model,
      demo: input.model.demo,
      configuration: input.model.configuration ?? {},
    },
    options,
    approaches,
    artifacts: artifacts.map((item) => item.id),
    include_session_artifacts: input.includeSessionArtifacts ?? false,
    evidence_fragments: corpus.evidence.length,
    excluded_events: corpus.excluded_events.length,
    excluded_artifact_ids: suppliedArtifacts
      .filter((artifact) => !withinWindow(artifact.timestamp))
      .map((artifact) => artifact.id),
  });
  const sourceMarkdown = corpus.evidence
    .map((item) => {
      const fence = "`".repeat(
        Math.max(
          3,
          ...[...item.text.matchAll(/`+/g)].map((match) => match[0].length + 1),
        ),
      );
      const safe = item.text.replace(/\p{Cc}/gu, (c) =>
        ["\n", "\r", "\t"].includes(c) ? c : "�",
      );
      return `## ${item.id}\n\n${plain(JSON.stringify({ ...item, text: undefined }))}\n\n${fence}text\n${safe}\n${fence}`;
    })
    .join("\n\n");
  await writeFile(
    join(directory, "sources.md"),
    `# Source evidence\n\nPrivate input excerpts. Offsets refer to the normalized text projection; raw locators are in corpus.json.\n\n${sourceMarkdown}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const results: ApproachResult[] = [];
  for (const approach of approaches) {
    const path = join(directory, approach);
    await mkdir(path, { mode: 0o700 });
    const started = Date.now();
    const ctx = new Context(corpus, options, input.model, path, (message) =>
      input.progress?.(`${approach}: ${message}`),
    );
    let quality: QualityMetrics | null = null;
    let status: ApproachResult["status"] = "complete";
    let reason: string | null = null;
    if (approach === "artifact" && !artifacts.length && approaches.length > 1) {
      status = "skipped";
      reason =
        "No artifacts supplied. Use --artifacts or --git with --git-range.";
    } else {
      try {
        quality = await writeAndVerify(ctx, await pipelines[approach](ctx));
      } catch (error) {
        status =
          error instanceof PipelineLimit &&
          approach === "direct" &&
          ctx.calls.length === 0
            ? "skipped"
            : "failed";
        reason =
          error instanceof Error
            ? error.message
            : "Unexpected pipeline failure";
      }
    }
    const result: ApproachResult = {
      approach,
      status,
      reason,
      directory: path,
      elapsed_ms: Date.now() - started,
      calls: ctx.calls.length,
      input_tokens:
        ctx.calls.length &&
        ctx.calls.every((call) => call.input_tokens !== null)
          ? ctx.calls.reduce((sum, call) => sum + (call.input_tokens ?? 0), 0)
          : null,
      output_tokens:
        ctx.calls.length &&
        ctx.calls.every((call) => call.output_tokens !== null)
          ? ctx.calls.reduce((sum, call) => sum + (call.output_tokens ?? 0), 0)
          : null,
      quality,
      warnings: ctx.warnings,
    };
    await ctx.save("result", result);
    results.push(result);
    input.progress?.(`${approach}: ${status}${reason ? ` — ${reason}` : ""}`);
  }
  const comparison = { directory, demo: input.model.demo, results };
  await saveJson(join(directory, "comparison.json"), comparison);
  await saveJson(join(directory, "review-scorecard.json"), {
    instructions:
      "Have a reviewer compare narratives with source evidence. Enter counts and notes; null means not reviewed. No automated overall quality score is computed. Review unmatched-conversation.json for artifact omissions. For blinded review, copy drafts with randomized filenames first.",
    reviews: results.map((result) => ({
      approach: result.approach,
      incorrect_claims: null,
      important_omissions: null,
      wrong_task_groupings: null,
      usefulness_1_to_5: null,
      correction_minutes: null,
      notes: "",
    })),
  });
  const rows = results.map(
    (result) =>
      `| ${APPROACH_NAMES[result.approach]} | ${result.status} | ${result.calls} | ${result.input_tokens ?? "—"} / ${result.output_tokens ?? "—"} | ${result.quality?.draft_words ?? "—"} | ${(result.elapsed_ms / 1000).toFixed(1)} | [files](${result.approach}/result.json) |`,
  );
  await writeFile(
    join(directory, "comparison.md"),
    [
      "# Pipeline comparison",
      "",
      input.model.demo
        ? "**OFFLINE DEMONSTRATION. Do not use these results to rank narrative quality.**"
        : `Model: ${plain(input.model.model)}. All methods received the same source corpus, writer, word target, and verifier.`,
      "",
      "| Approach | Status | Calls | Input / output tokens | Draft words | Seconds | Results |",
      "| --- | --- | ---: | ---: | ---: | ---: | --- |",
      ...rows,
      "",
      "Open each approach's narrative.md for the reviewed output, draft.md for the full draft, and verification.json for claim checks. Open review-scorecard.json for manual comparison. A source citation is not a correctness proof; the same-model verifier can miss errors. Token usage is provider-reported and excludes any unreported retries. Word count is measured, not assumed equal. No monetary cost is estimated without model pricing.",
      "",
      ...results
        .filter((result) => result.reason)
        .map((result) => `- ${result.approach}: ${plain(result.reason!)}`),
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  return comparison;
}
