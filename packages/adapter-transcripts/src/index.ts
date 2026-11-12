import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type IngestBatch,
  IngestBatchSchema,
  type NormalizedEvent,
  SCHEMA_VERSION,
} from "@sessionlore/contracts";

export type TranscriptHost = "claude" | "opencode";
export const adapterVersion = (host: TranscriptHost) => `${host}-0.1.0`;
const maxBytes = 128 * 1024 * 1024;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const time = (value: unknown): string | null => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15
    ? new Date(n).toISOString()
    : null;
};

type Part = Pick<
  NormalizedEvent,
  "actor" | "event_kind" | "text" | "is_human_turn"
> & { type: string; id: string | null; warnings?: string[] };
const part = (
  actor: Part["actor"],
  event_kind: Part["event_kind"],
  text: string | null,
  type: string,
  id: string | null = null,
): Part => ({
  actor,
  event_kind,
  text,
  type,
  id,
  is_human_turn: actor === "human" && event_kind === "message",
});
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => str(obj(item).text) ?? []).join("\n");
}

function claudeParts(record: Record<string, unknown>): Part[] {
  const message = obj(record.message);
  const id = str(record.uuid) ?? str(message.id);
  if (record.type === "system" && record.subtype === "compact_boundary")
    return [
      part(
        "system",
        "compaction",
        str(record.content),
        "system.compact_boundary",
        id,
      ),
    ];
  if (record.type !== "user" && record.type !== "assistant")
    return [
      part(
        "system",
        [
          "system",
          "summary",
          "progress",
          "file-history-snapshot",
          "queue-operation",
        ].includes(String(record.type))
          ? "metadata"
          : "unknown",
        null,
        str(record.type) ?? "unknown",
        id,
      ),
    ];
  const actor =
    record.type === "assistant"
      ? "assistant"
      : record.isMeta === true || record.isCompactSummary === true
        ? "system"
        : record.isSidechain === true
          ? "assistant"
          : "human";
  const content = message.content ?? record.content;
  if (typeof content === "string")
    return [
      part(
        actor,
        record.isCompactSummary === true ? "compaction" : "message",
        content,
        `${record.type}.text`,
        id,
      ),
    ];
  if (!Array.isArray(content))
    return [part("unknown", "unknown", null, "unknown", id)];
  return content.map((value, index) => {
    const block = obj(value);
    const blockId = str(block.id) ?? (id ? `${id}:${index}` : null);
    if (block.type === "text")
      return part(
        actor,
        record.isCompactSummary === true ? "compaction" : "message",
        str(block.text),
        `${record.type}.text`,
        blockId,
      );
    if (block.type === "tool_use")
      return part(
        "assistant",
        "action",
        JSON.stringify({
          name: block.name,
          input: block.input,
          call_id: block.id,
        }),
        "assistant.tool_use",
        blockId,
      );
    if (block.type === "tool_result")
      return part(
        "tool",
        "result",
        JSON.stringify({
          call_id: block.tool_use_id,
          is_error: block.is_error ?? false,
          output: contentText(block.content),
          answers: obj(record.toolUseResult).answers,
        }),
        "user.tool_result",
        blockId,
      );
    if (block.type === "thinking" || block.type === "redacted_thinking")
      return part(
        "assistant",
        "thought",
        null,
        `assistant.${block.type}`,
        blockId,
      );
    return part(
      "unknown",
      "unknown",
      null,
      `attachment.${str(block.type) ?? "unknown"}`,
      blockId,
    );
  });
}

function openCodeParts(record: Record<string, unknown>): Part[] {
  const info = obj(record.info);
  const role = info.role ?? record.role ?? record.type;
  const actor =
    role === "user" ? "human" : role === "assistant" ? "assistant" : "system";
  const messageId = str(info.id) ?? str(record.id);
  const parts = Array.isArray(record.parts) ? record.parts : [];
  if (!parts.length)
    return [
      part(
        "system",
        role === "compaction" ? "compaction" : "metadata",
        null,
        str(role) ?? "unknown",
        messageId,
      ),
    ];
  return parts.flatMap((value, index) => {
    const block = obj(value);
    const id = str(block.id) ?? (messageId ? `${messageId}:${index}` : null);
    if (block.type === "text")
      return [
        part(
          block.synthetic === true || block.ignored === true ? "system" : actor,
          "message",
          str(block.text),
          `${role}.text`,
          id,
        ),
      ];
    if (block.type === "reasoning")
      return [part("assistant", "thought", null, "assistant.reasoning", id)];
    if (block.type === "compaction")
      return [part("system", "compaction", null, "compaction", id)];
    if (block.type === "tool") {
      const state = obj(block.state);
      const result = [
        part(
          "assistant",
          "action",
          JSON.stringify({
            name: block.tool,
            input: state.input,
            call_id: block.callID,
          }),
          "assistant.tool",
          id ? `${id}:call` : null,
        ),
      ];
      if (state.status === "completed" || state.status === "error")
        result.push(
          part(
            "tool",
            "result",
            JSON.stringify({
              name: block.tool,
              call_id: block.callID,
              status: state.status,
              output: state.output,
              error: state.error,
            }),
            "tool.result",
            id ? `${id}:result` : null,
          ),
        );
      return result;
    }
    return [part("unknown", "unknown", null, str(block.type) ?? "unknown", id)];
  });
}

/** Claude JSONL and the JSON document produced by `opencode export`. */
export async function normalizeTranscript(
  path: string,
  input: {
    host: TranscriptHost;
    sourceId: string;
    rawSize: number;
    sourcePath: string;
    mtime: string;
    ingestedAt: string;
  },
): Promise<IngestBatch> {
  if (input.rawSize > maxBytes)
    throw new Error(
      "Transcript exceeds the 128 MiB import limit; export smaller sessions.",
    );
  const bytes = await readFile(path);
  if (bytes.length !== input.rawSize || hash(bytes) !== input.sourceId)
    throw new Error("Captured transcript failed its integrity check.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  type RecordSpan = {
    record: Record<string, unknown>;
    start: number;
    end: number;
    line: number;
    malformed: boolean;
    digest: string;
  };
  const records: RecordSpan[] = [];
  let session: Record<string, unknown> = {};
  if (input.host === "opencode") {
    const document = obj(JSON.parse(decoder.decode(bytes)));
    session = obj(document.info ?? document.session);
    if (!Array.isArray(document.messages))
      throw new Error(
        "Expected an OpenCode export with info and messages. Run opencode export <session-id>.",
      );
    document.messages.forEach((value, index) =>
      records.push({
        record: obj(value),
        start: 0,
        end: bytes.length,
        line: 1,
        malformed: false,
        digest: hash(`${index}\0${JSON.stringify(value)}`),
      }),
    );
  } else {
    let start = 0;
    let line = 1;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline + 1;
      const raw = bytes.subarray(start, end);
      let record: Record<string, unknown> = {};
      let malformed = false;
      try {
        const value: unknown = JSON.parse(decoder.decode(raw));
        record = obj(value);
        malformed = !value || typeof value !== "object" || Array.isArray(value);
      } catch {
        malformed = true;
      }
      records.push({ record, start, end, line, malformed, digest: hash(raw) });
      start = end;
      line++;
    }
  }
  const fallback = `unidentified:${hash(resolve(input.sourcePath))}`;
  const events: NormalizedEvent[] = [];
  for (const record of records) {
    const info = obj(record.record.info);
    const sessionId =
      str(record.record.sessionId) ??
      str(info.sessionID) ??
      str(session.id) ??
      fallback;
    const thread =
      record.record.isSidechain === true
        ? `${sessionId}/${str(record.record.agentId) ?? hash(resolve(input.sourcePath)).slice(0, 16)}`
        : sessionId;
    const timestamp = time(
      record.record.timestamp ??
        obj(info.time).created ??
        obj(record.record.time).created,
    );
    const parts = record.malformed
      ? [part("unknown", "unknown", null, "malformed")]
      : input.host === "claude"
        ? claudeParts(record.record)
        : openCodeParts(record.record);
    parts.forEach((item, index) =>
      events.push({
        schema_version: SCHEMA_VERSION,
        event_id: hash(
          `${input.host}\0${thread}\0${record.line}\0${record.digest}\0${index}`,
        ),
        source: input.host,
        thread_id: thread,
        logical_session_id: thread,
        timestamp,
        actor: item.actor,
        event_kind: item.event_kind,
        text: item.text,
        is_human_turn: item.is_human_turn,
        original_type: item.type,
        original_event_id: item.id,
        payload_ref: {
          source_id: input.sourceId,
          line_number: record.line,
          byte_start: record.start,
          byte_end: record.end,
          byte_context: "decompressed",
        },
        parent_event_refs: [],
        parse_status: record.malformed
          ? "malformed_record"
          : item.event_kind === "unknown"
            ? "unsupported_record"
            : "parsed",
        parse_warnings: [
          ...(thread === fallback ? ["missing_session_metadata"] : []),
          ...(timestamp ? [] : ["missing_or_invalid_timestamp"]),
          ...(item.event_kind === "unknown" && !record.malformed
            ? ["unsupported_record"]
            : []),
          ...(record.malformed
            ? [
                record.end === bytes.length && bytes.at(-1) !== 10
                  ? "malformed_tail"
                  : "malformed_record",
              ]
            : []),
          ...(input.host === "opencode"
            ? ["source_pointer_covers_export_document"]
            : []),
          ...(record.record.isSidechain === true
            ? ["delegated_agent_input"]
            : []),
        ],
        adapter_version: adapterVersion(input.host),
      }),
    );
  }
  return IngestBatchSchema.parse({
    source: {
      schema_version: SCHEMA_VERSION,
      source_id: input.sourceId,
      decoded_sha256: input.sourceId,
      source: input.host,
      discovered_path: resolve(input.sourcePath),
      compression: "none",
      size_bytes: bytes.length,
      mtime: input.mtime,
      ingested_at: input.ingestedAt,
      adapter_version: adapterVersion(input.host),
    },
    events,
    lineage: [],
  });
}

export async function discoverTranscripts(
  inputPath: string,
  host: TranscriptHost,
  excludedPaths: string[] = [],
): Promise<string[]> {
  const path = resolve(inputPath);
  if (excludedPaths.some((excluded) => path === resolve(excluded))) return [];
  const meta = await lstat(path);
  if (meta.isSymbolicLink()) return [];
  const accepts = (name: string) =>
    host === "claude" ? name.endsWith(".jsonl") : name.endsWith(".json");
  if (meta.isFile()) {
    if (!accepts(path))
      throw new Error(
        host === "claude"
          ? "Expected a Claude .jsonl transcript."
          : "Expected an OpenCode .json export.",
      );
    return [path];
  }
  if (!meta.isDirectory()) return [];
  const paths: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  )) {
    if (
      entry.isSymbolicLink() ||
      [".git", "node_modules", ".sessionlore"].includes(entry.name)
    )
      continue;
    if (entry.isDirectory() || accepts(entry.name))
      paths.push(
        ...(await discoverTranscripts(
          join(path, entry.name),
          host,
          excludedPaths,
        )),
      );
  }
  return paths;
}
