import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ADAPTER_VERSION,
  discoverRollouts,
  normalizeCapturedRollout,
} from "@sessionlore/adapter-codex";
import {
  adapterVersion,
  discoverTranscripts,
  normalizeTranscript,
} from "@sessionlore/adapter-transcripts";
import type {
  IngestBatch,
  NormalizedEvent,
  SessionHost,
} from "@sessionlore/contracts";
import { EvidenceStore } from "@sessionlore/evidence-store";

export { listProjects, type Project, selectProject } from "./projects.js";

export const versionForHost = (host: SessionHost) =>
  host === "codex" ? ADAPTER_VERSION : adapterVersion(host);
export const discoverSessions = (
  input: string,
  host: SessionHost,
  excluded: string[] = [],
) =>
  host === "codex"
    ? discoverRollouts(input, excluded)
    : discoverTranscripts(input, host, excluded);

async function normalizeSession(
  path: string,
  host: SessionHost,
  input: Parameters<typeof normalizeCapturedRollout>[1],
) {
  return host === "codex"
    ? normalizeCapturedRollout(path, input)
    : normalizeTranscript(path, { ...input, host });
}

export type IngestReport = {
  source_ids: string[];
  sources: number;
  new_snapshots: number;
  events: number;
  duplicate_events: number;
  human_turns: number;
  unsupported_records: number;
  malformed_records: number;
  warning_count: number;
  timeline_path: string;
};

function codeBlock(text: string): string {
  const sanitized = text.replace(/\p{Cc}/gu, (character) =>
    ["\t", "\n", "\r"].includes(character) ? character : "�",
  );
  const runs = [...sanitized.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)));
  return `${fence}text\n${sanitized}\n${fence}`;
}

export function renderTimeline(events: readonly NormalizedEvent[]): string {
  const sections = events.map((event, index) => {
    const metadata = [
      `Thread: ${event.thread_id}`,
      `Time: ${event.timestamp ?? "unknown"}`,
      `Actor: ${event.actor}`,
      `Kind: ${event.event_kind}`,
      `Original type: ${event.original_type}`,
      `Parse status: ${event.parse_status}`,
      `Warnings: ${event.parse_warnings.join(", ") || "none"}`,
    ].join("\n");
    return [
      `## Event ${index + 1}`,
      codeBlock(metadata),
      `Event ID: \`${event.event_id}\``,
      `Source: \`${event.payload_ref.source_id}\`, line ${event.payload_ref.line_number}, decompressed bytes ${event.payload_ref.byte_start}–${event.payload_ref.byte_end} (end exclusive).`,
      codeBlock(
        event.text ??
          "No text projection. Read the retained raw record using the source reference.",
      ),
    ].join("\n\n");
  });
  return [
    "# Session timeline",
    "Private local preview. Records follow source-file and line order; this view makes no causal claims. Transcript text appears as inert code blocks.",
    ...sections,
    "",
  ].join("\n\n");
}

async function replaceOutput(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}

export async function ingest(
  inputPath: string,
  outputDirectory: string,
  host: SessionHost = "codex",
): Promise<IngestReport> {
  const output = resolve(outputDirectory);
  const paths = await discoverSessions(inputPath, host, [output]);
  return ingestFiles(paths, output, host);
}

export async function ingestFiles(
  paths: string[],
  outputDirectory: string,
  host: SessionHost = "codex",
): Promise<IngestReport> {
  const output = resolve(outputDirectory);
  if (!paths.length)
    throw new Error("No rollout files found in the input path");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const store = new EvidenceStore(output);
  const batches: IngestBatch[] = [];
  let newSnapshots = 0;
  for (const path of paths) {
    const captured = await store.captureFile(path);
    const batch = await normalizeSession(captured.path, host, {
      sourceId: captured.sourceId,
      rawSize: captured.rawSize,
      sourcePath: path,
      mtime: captured.mtime,
      ingestedAt: new Date().toISOString(),
      compression: path.endsWith(".zst") ? "zstd" : "none",
    });
    if (await store.saveBatch(batch)) newSnapshots++;
    batches.push(batch);
  }
  const uniqueEvents = new Map<string, NormalizedEvent>();
  let totalEvents = 0;
  for (const batch of batches) {
    for (const event of batch.events) {
      totalEvents++;
      // Snapshot-specific source pointers remain in every immutable batch.
      if (!uniqueEvents.has(event.event_id))
        uniqueEvents.set(event.event_id, event);
    }
  }
  const events = [...uniqueEvents.values()];
  const report: IngestReport = {
    source_ids: [...new Set(batches.map((batch) => batch.source.source_id))],
    sources: batches.length,
    new_snapshots: newSnapshots,
    events: events.length,
    duplicate_events: totalEvents - events.length,
    human_turns: events.filter((event) => event.is_human_turn).length,
    unsupported_records: events.filter(
      (event) => event.parse_status === "unsupported_record",
    ).length,
    malformed_records: events.filter(
      (event) => event.parse_status === "malformed_record",
    ).length,
    warning_count: events.reduce(
      (count, event) => count + event.parse_warnings.length,
      0,
    ),
    timeline_path: join(output, "timeline.md"),
  };
  await replaceOutput(report.timeline_path, renderTimeline(events));
  await replaceOutput(
    join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

export async function replay(
  sourceId: string,
  outputDirectory: string,
  host: SessionHost = "codex",
): Promise<{ source_id: string; events: number; matched: boolean }> {
  const store = new EvidenceStore(outputDirectory);
  const batch = await store.loadBatch(sourceId, versionForHost(host));
  const normalized = await normalizeSession(store.rawPath(sourceId), host, {
    sourceId,
    rawSize: batch.source.size_bytes,
    sourcePath: batch.source.discovered_path,
    compression: batch.source.compression,
    mtime: batch.source.mtime,
    ingestedAt: batch.source.ingested_at,
  });
  const matched = JSON.stringify(normalized) === JSON.stringify(batch);
  if (!matched)
    throw new Error("Replay differs from the stored normalized snapshot");
  return { source_id: sourceId, events: normalized.events.length, matched };
}

/** Load exactly the snapshots in an ingestion report, including source integrity checks. */
export async function loadEvidence(
  outputDirectory: string,
  sourceIds: readonly string[],
  host: SessionHost = "codex",
): Promise<IngestBatch[]> {
  const store = new EvidenceStore(outputDirectory);
  const batches: IngestBatch[] = [];
  for (const id of sourceIds) {
    batches.push(await store.loadBatch(id, versionForHost(host)));
  }
  return batches;
}

/** Freeze an input set so separate experimental runs can use exactly the same bytes. */
export async function captureCase(inputPath: string, caseDirectory: string) {
  return captureFiles(
    await discoverRollouts(inputPath, [caseDirectory]),
    caseDirectory,
    resolve(inputPath),
  );
}

export async function captureFiles(
  paths: string[],
  caseDirectory: string,
  inputDescription: string,
) {
  const output = resolve(caseDirectory);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // Refuse to overwrite a named case, including one another process is creating.
  await mkdir(output, { mode: 0o700 });
  const evidencePath = join(output, "evidence");
  const report = await ingestFiles(paths, evidencePath);
  const sessionsPath = join(output, "sessions");
  await mkdir(sessionsPath, { mode: 0o700 });
  const store = new EvidenceStore(evidencePath);
  const threadIds = new Set<string>();
  let characters = 0;
  for (const id of report.source_ids) {
    const batch = await store.loadBatch(id, ADAPTER_VERSION);
    const extension =
      batch.source.compression === "zstd" ? ".jsonl.zst" : ".jsonl";
    await copyFile(
      store.rawPath(id),
      join(sessionsPath, `${id}${extension}`),
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    for (const event of batch.events) {
      threadIds.add(event.thread_id);
      characters += event.text?.length ?? 0;
    }
  }
  const manifest = {
    captured_at: new Date().toISOString(),
    input: inputDescription,
    sessions_path: sessionsPath,
    adapter_version: ADAPTER_VERSION,
    thread_ids: [...threadIds],
    projected_text_characters: characters,
    report,
  };
  await writeFile(
    join(output, "case.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return manifest;
}
