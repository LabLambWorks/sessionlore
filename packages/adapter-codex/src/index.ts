import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import {
  type IngestBatch,
  IngestBatchSchema,
  type LineageEdge,
  type NormalizedEvent,
  SCHEMA_VERSION,
} from "@sessionlore/contracts";

export const ADAPTER_VERSION = "codex-0.3.0";
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    const text = string(object(part).text);
    return text === null ? [] : [text];
  });
  return parts.length ? parts.join("\n") : null;
}

type ParsedLine = {
  start: number;
  end: number;
  digest: string;
  record: Record<string, unknown>;
  malformed: boolean;
  classification: Classification;
};

function parseLine(bytes: Buffer, start: number, end: number): ParsedLine {
  let record: Record<string, unknown> = {};
  let malformed = false;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    record = object(value);
    malformed =
      value === null || typeof value !== "object" || Array.isArray(value);
  } catch {
    malformed = true;
  }
  const classification = classify(record);
  const payload = object(record.payload);
  const item = object(payload.item);
  // Retain the normalized text and fields needed for identity/lineage, not base64 media.
  const compact = {
    type: record.type,
    timestamp: record.timestamp,
    id: record.id,
    payload: {
      type: payload.type,
      id: payload.id,
      role: payload.role,
      turn_id: payload.turn_id,
      forked_from_id: payload.forked_from_id,
      parent_thread_id: payload.parent_thread_id,
      attached_thread_parent_id: payload.attached_thread_parent_id,
      source: record.type === "session_meta" ? payload.source : undefined,
      item: { type: item.type, id: item.id },
      internal_chat_message_metadata_passthrough: {
        turn_id: object(payload.internal_chat_message_metadata_passthrough)
          .turn_id,
      },
    },
  };
  return {
    start,
    end,
    digest: hash(bytes),
    record: compact,
    malformed,
    classification,
  };
}

function lines(bytes: Buffer): ParsedLine[] {
  const result: ParsedLine[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    const contentEnd = newline === -1 ? end : newline;
    const lineBytes = bytes.subarray(
      start,
      contentEnd > start && bytes[contentEnd - 1] === 13
        ? contentEnd - 1
        : contentEnd,
    );
    result.push(parseLine(lineBytes, start, end));
    start = end;
  }
  return result;
}

type Classification = Pick<
  NormalizedEvent,
  "actor" | "event_kind" | "is_human_turn" | "text" | "parse_status"
>;

function classify(record: Record<string, unknown>): Classification {
  const payload = object(record.payload);
  const unknown: Classification = {
    actor: "unknown",
    event_kind: "unknown",
    is_human_turn: false,
    text: null,
    parse_status: "unsupported_record",
  };
  const parsed = { ...unknown, parse_status: "parsed" as const };
  switch (record.type) {
    case "session_meta":
    case "turn_context":
      return { ...parsed, actor: "system", event_kind: "metadata" };
    case "compacted":
      return {
        ...parsed,
        actor: "system",
        event_kind: "compaction",
        text: string(payload.message),
      };
    case "event_msg": {
      if (payload.type === "item_completed") {
        const item = object(payload.item);
        if (item.type === "UserMessage") {
          return {
            ...parsed,
            actor: "human",
            event_kind: "message",
            is_human_turn: true,
            text: textContent(item.content),
          };
        }
        if (item.type === "AgentMessage") {
          return {
            ...parsed,
            actor: "assistant",
            event_kind: "message",
            text: textContent(item.content),
          };
        }
        if (item.type === "CommandExecution") {
          return {
            ...parsed,
            actor: "tool",
            event_kind: "result",
            text: JSON.stringify({
              command: item.command,
              cwd: item.cwd,
              status: item.status,
              exit_code: item.exit_code,
              output: item.aggregated_output,
            }),
          };
        }
        if (item.type === "FileChange") {
          return {
            ...parsed,
            actor: "tool",
            event_kind: "result",
            text: JSON.stringify({
              status: item.status,
              changes: item.changes,
              stdout: item.stdout,
              stderr: item.stderr,
            }),
          };
        }
        if (item.type === "ContextCompaction")
          return {
            ...parsed,
            actor: "system",
            event_kind: "compaction",
            text: textContent(item.content),
          };
      }
      const text = string(payload.message) ?? string(payload.text);
      if (payload.type === "user_message" && text !== null) {
        // A user-role response item alone is never enough to identify a human turn.
        const explicitOrigin = payload.source ?? payload.origin;
        const human =
          payload.role !== "developer" &&
          payload.role !== "system" &&
          payload.synthetic !== true &&
          (explicitOrigin === undefined ||
            explicitOrigin === "user" ||
            explicitOrigin === "human");
        return {
          ...parsed,
          actor: human ? "human" : "unknown",
          event_kind: "message",
          is_human_turn: human,
          text,
        };
      }
      if (payload.type === "agent_message" && text !== null)
        return { ...parsed, actor: "assistant", event_kind: "message", text };
      if (payload.type === "agent_reasoning" && text !== null)
        return { ...parsed, actor: "assistant", event_kind: "thought", text };
      return unknown;
    }
    case "response_item": {
      if (payload.type === "message") {
        const role = payload.role;
        const actor =
          role === "assistant" || role === "developer" || role === "system"
            ? role
            : "unknown";
        return {
          ...parsed,
          actor,
          event_kind: "message",
          text: textContent(payload.content),
        };
      }
      if (
        payload.type === "function_call" ||
        payload.type === "custom_tool_call"
      ) {
        return {
          ...parsed,
          actor: "assistant",
          event_kind: "action",
          text: string(payload.arguments) ?? string(payload.input),
        };
      }
      if (
        payload.type === "function_call_output" ||
        payload.type === "custom_tool_call_output"
      ) {
        return {
          ...parsed,
          actor: "tool",
          event_kind: "result",
          text: textContent(payload.output),
        };
      }
      if (payload.type === "reasoning")
        return {
          ...parsed,
          actor: "assistant",
          event_kind: "thought",
          text: textContent(payload.summary),
        };
      return unknown;
    }
    default:
      return unknown;
  }
}

export type NormalizeInput = {
  bytes: Buffer;
  sourcePath: string;
  mtime: string;
  ingestedAt: string;
  compression?: "none" | "zstd";
};

export function normalizeRollout(input: NormalizeInput): IngestBatch {
  if (input.bytes.length > MAX_SOURCE_BYTES)
    throw new Error("Source exceeds the 128 MiB snapshot limit");
  const compression =
    input.compression ?? (input.sourcePath.endsWith(".zst") ? "zstd" : "none");
  const decoded =
    compression === "zstd"
      ? zstdDecompressSync(input.bytes, { maxOutputLength: MAX_SOURCE_BYTES })
      : input.bytes;
  const sourceId = hash(input.bytes);
  const records = lines(decoded);
  return normalizeRecords(
    {
      ...input,
      sourceId,
      compression,
      rawSize: input.bytes.length,
      decodedHash: hash(decoded),
      endsInNewline: decoded.at(-1) === 10,
    },
    records,
  );
}

type FileNormalization = Omit<NormalizeInput, "bytes" | "compression"> & {
  sourceId: string;
  rawSize: number;
  compression: "none" | "zstd";
  decodedHash: string;
  endsInNewline: boolean;
};
function normalizeRecords(
  input: FileNormalization,
  records: ParsedLine[],
): IngestBatch {
  const { sourceId, compression } = input;
  const metadata = records.find(
    (line) =>
      line.record.type === "session_meta" &&
      string(object(line.record.payload).id),
  );
  const threadId =
    string(object(metadata?.record.payload).id) ??
    `unidentified:${hash(resolve(input.sourcePath))}`;
  const spawn = object(
    object(object(object(metadata?.record.payload).source).subagent)
      .thread_spawn,
  );
  let previousTimestamp: string | null = null;
  const lineage: LineageEdge[] = [];
  const completedUserMessages = new Set(
    records.flatMap(({ record, classification }) => {
      const payload = object(record.payload);
      const item = object(payload.item);
      return record.type === "event_msg" &&
        payload.type === "item_completed" &&
        item.type === "UserMessage"
        ? [JSON.stringify([payload.turn_id, classification.text])]
        : [];
    }),
  );
  const responseMessageIds = new Set(
    records.flatMap(({ record }) => {
      const payload = object(record.payload);
      return record.type === "response_item" &&
        payload.type === "message" &&
        typeof payload.id === "string"
        ? [payload.id]
        : [];
    }),
  );
  const events: NormalizedEvent[] = records.map((line, index) => {
    const payload = object(line.record.payload);
    const warnings: string[] = [];
    const classification =
      spawn.parent_thread_id && line.classification.is_human_turn
        ? {
            ...line.classification,
            actor: "assistant" as const,
            is_human_turn: false,
          }
        : line.classification;
    if (spawn.parent_thread_id && line.classification.is_human_turn)
      warnings.push("delegated_agent_input");
    // Keep every physical record, but flag explicit message mirrors for corpus projection.
    if (
      line.record.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "user"
    ) {
      const turn = object(
        payload.internal_chat_message_metadata_passthrough,
      ).turn_id;
      if (
        turn &&
        completedUserMessages.has(JSON.stringify([turn, classification.text]))
      )
        warnings.push("mirrored_message");
    }
    const completed =
      payload.type === "item_completed" ? object(payload.item) : {};
    if (
      completed.type === "AgentMessage" &&
      typeof completed.id === "string" &&
      responseMessageIds.has(completed.id)
    )
      warnings.push("mirrored_message");
    if (!metadata) warnings.push("missing_session_metadata");
    if (line.malformed)
      warnings.push(
        index === records.length - 1 && !input.endsInNewline
          ? "malformed_tail"
          : "malformed_record",
      );
    if (classification.parse_status === "unsupported_record" && !line.malformed)
      warnings.push("unsupported_record");
    if (line.record.type === "response_item" && payload.role === "user")
      warnings.push("unverified_user_role");
    if (line.record.type === "session_meta" && payload.id !== threadId)
      warnings.push("conflicting_thread_metadata");
    const rawTimestamp = string(line.record.timestamp);
    const timestamp =
      rawTimestamp !== null &&
      /^\d{4}-\d{2}-\d{2}T/.test(rawTimestamp) &&
      Number.isFinite(Date.parse(rawTimestamp))
        ? new Date(rawTimestamp).toISOString()
        : null;
    if (!timestamp) warnings.push("missing_or_invalid_timestamp");
    if (timestamp && previousTimestamp && timestamp < previousTimestamp)
      warnings.push("non_monotonic_timestamp");
    if (timestamp) previousTimestamp = timestamp;
    const eventId = hash(`${threadId}\0${index + 1}\0${line.digest}`);
    const event: NormalizedEvent = {
      schema_version: SCHEMA_VERSION,
      event_id: eventId,
      source: "codex",
      thread_id: threadId,
      logical_session_id: threadId,
      timestamp,
      ...classification,
      original_type: [
        string(line.record.type) ?? "unknown",
        string(payload.type),
        payload.type === "item_completed" ? string(completed.type) : null,
      ]
        .filter(Boolean)
        .join("."),
      original_event_id:
        string(payload.id) ?? string(completed.id) ?? string(line.record.id),
      payload_ref: {
        source_id: sourceId,
        line_number: index + 1,
        byte_start: line.start,
        byte_end: line.end,
        byte_context: "decompressed",
      },
      parent_event_refs: [],
      parse_status: line.malformed
        ? "malformed_record"
        : classification.parse_status,
      parse_warnings: warnings,
      adapter_version: ADAPTER_VERSION,
    };
    if (line.record.type === "session_meta" && payload.id === threadId) {
      const relationships = {
        forked_from_id: "fork_of",
        parent_thread_id: "spawned_by",
        attached_thread_parent_id: "attached_to",
      } as const;
      if (
        !payload.parent_thread_id &&
        typeof spawn.parent_thread_id === "string"
      )
        payload.parent_thread_id = spawn.parent_thread_id;
      for (const [field, relationship] of Object.entries(relationships)) {
        const parent = string(payload[field]);
        if (parent && parent !== threadId) {
          lineage.push({
            child_thread_id: threadId,
            parent_thread_id: parent,
            relationship,
            status: "observed",
            evidence_event_ids: [eventId],
            method_version: ADAPTER_VERSION,
          });
        } else if (parent === threadId) {
          warnings.push("self_referencing_lineage");
        }
      }
    }
    return event;
  });
  return IngestBatchSchema.parse({
    source: {
      schema_version: SCHEMA_VERSION,
      source_id: sourceId,
      decoded_sha256: input.decodedHash,
      source: "codex",
      discovered_path: resolve(input.sourcePath),
      compression,
      size_bytes: input.rawSize,
      mtime: input.mtime,
      ingested_at: input.ingestedAt,
      adapter_version: ADAPTER_VERSION,
    },
    events,
    lineage,
  });
}

/** Stream an immutable captured file. Large media stays in raw evidence, not parser memory. */
export async function normalizeCapturedRollout(
  path: string,
  input: Omit<FileNormalization, "decodedHash" | "endsInNewline">,
  limits: { maxDecodedBytes?: number; maxLineBytes?: number } = {},
): Promise<IngestBatch> {
  const raw = createReadStream(path);
  const stream =
    input.compression === "zstd" ? raw.pipe(createZstdDecompress()) : raw;
  raw.on("error", (error) => stream.destroy(error));
  const digest = createHash("sha256");
  const records: ParsedLine[] = [];
  let pieces: Buffer[] = [];
  let pending = 0;
  let position = 0;
  let total = 0;
  let endsInNewline = false;
  const maxDecoded = limits.maxDecodedBytes ?? 2 * 1024 ** 3;
  const maxLine = limits.maxLineBytes ?? 256 * 1024 ** 2;
  const finish = (newline: boolean) => {
    const line = Buffer.concat(pieces, pending);
    const contentEnd = line.at(-1) === 13 ? line.length - 1 : line.length;
    const end = position + pending + (newline ? 1 : 0);
    records.push(parseLine(line.subarray(0, contentEnd), position, end));
    position = end;
    pending = 0;
    pieces = [];
  };
  try {
    for await (const value of stream) {
      const chunk = Buffer.from(value as Uint8Array);
      total += chunk.length;
      if (total > maxDecoded)
        throw new Error(
          `Decoded source exceeds ${maxDecoded} bytes; no records were dropped.`,
        );
      digest.update(chunk);
      endsInNewline = chunk.at(-1) === 10;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        pieces.push(part);
        pending += part.length;
        if (pending > maxLine)
          throw new Error(
            `A JSONL record exceeds ${maxLine} bytes; no records were dropped.`,
          );
        if (newline !== -1) finish(true);
        offset = newline === -1 ? chunk.length : newline + 1;
      }
    }
    if (pending) finish(false);
  } finally {
    raw.destroy();
    stream.destroy();
  }
  return normalizeRecords(
    { ...input, decodedHash: digest.digest("hex"), endsInNewline },
    records,
  );
}

export async function readCodexRollout(
  path: string,
): Promise<{ bytes: Buffer; batch: IngestBatch }> {
  const metadata = await stat(path);
  if (metadata.size > MAX_SOURCE_BYTES)
    throw new Error("Source exceeds the 128 MiB snapshot limit");
  const bytes = await readFile(path);
  return {
    bytes,
    batch: normalizeRollout({
      bytes,
      sourcePath: path,
      mtime: metadata.mtime.toISOString(),
      ingestedAt: new Date().toISOString(),
    }),
  };
}

export async function discoverRollouts(
  inputPath: string,
  excludedPaths: string[] = [],
): Promise<string[]> {
  const path = resolve(inputPath);
  if (excludedPaths.some((excluded) => path === resolve(excluded))) return [];
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return [];
  if (metadata.isFile()) {
    if (!/\.jsonl(?:\.zst)?$/.test(path))
      throw new Error("Expected a .jsonl or .jsonl.zst file");
    return [path];
  }
  if (!metadata.isDirectory()) return [];
  const paths: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    if (
      entry.isSymbolicLink() ||
      [".git", "node_modules", ".sessionlore"].includes(entry.name)
    )
      continue;
    if (
      entry.isDirectory() ||
      (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name))
    ) {
      paths.push(
        ...(await discoverRollouts(join(path, entry.name), excludedPaths)),
      );
    }
  }
  return paths;
}
