import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  normalizeCapturedRollout,
  normalizeRollout,
  readCodexRollout,
} from "../src/index.js";

const fixture = resolve("fixtures/codex/v1/rollout-basic.jsonl");
const timestamp = "2026-11-10T09:00:00.000Z";
const normalize = (bytes: Buffer, sourcePath = fixture) =>
  normalizeRollout({
    bytes,
    sourcePath,
    mtime: timestamp,
    ingestedAt: timestamp,
  });

describe("Codex normalization", () => {
  it("streams large records, compressed sources, and malformed UTF-8 with the same IDs and offsets as buffer normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-stream-"));
    try {
      const content = Buffer.from(
        `${JSON.stringify({ type: "session_meta", payload: { id: "stream" } })}\r\n${JSON.stringify(
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url:
                    "data:image/png;base64," + "A".repeat(2 * 1024 * 1024),
                },
                { type: "input_text", text: "保留文字" },
              ],
            },
          },
        )}\r\n{"unfinished":`,
      );
      for (const compression of ["none", "zstd"] as const) {
        const bytes =
          compression === "zstd" ? zstdCompressSync(content) : content;
        const path = join(root, compression);
        await writeFile(path, bytes);
        const expected = normalizeRollout({
          bytes,
          compression,
          sourcePath: path,
          mtime: timestamp,
          ingestedAt: timestamp,
        });
        const streamed = await normalizeCapturedRollout(path, {
          sourceId: expected.source.source_id,
          rawSize: bytes.length,
          compression,
          sourcePath: path,
          mtime: timestamp,
          ingestedAt: timestamp,
        });
        expect(streamed).toEqual(expected);
        expect(streamed.events[1]?.text).toBe("保留文字");
        await expect(
          normalizeCapturedRollout(
            path,
            {
              sourceId: expected.source.source_id,
              rawSize: bytes.length,
              compression,
              sourcePath: path,
              mtime: timestamp,
              ingestedAt: timestamp,
            },
            { maxLineBytes: 1024 },
          ),
        ).rejects.toThrow("record exceeds");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes delegated agent input from human requests and records explicit spawn lineage", () => {
    const bytes = Buffer.from(
      [
        {
          type: "session_meta",
          payload: {
            id: "child",
            source: {
              subagent: {
                thread_spawn: { parent_thread_id: "parent", depth: 1 },
              },
            },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "t",
            item: {
              type: "UserMessage",
              id: "u",
              content: [{ type: "text", text: "Delegated task" }],
            },
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    const batch = normalize(bytes);
    expect(batch.events[1]).toMatchObject({
      actor: "assistant",
      is_human_turn: false,
    });
    expect(batch.events[1]?.parse_warnings).toContain("delegated_agent_input");
    expect(batch.lineage[0]).toMatchObject({
      child_thread_id: "child",
      parent_thread_id: "parent",
      relationship: "spawned_by",
      status: "observed",
    });
  });
  it("recognizes desktop completion records without mistaking internal context or message mirrors for human turns", async () => {
    const { batch } = await readCodexRollout(
      resolve("fixtures/codex/v2/rollout-completed-items.jsonl"),
    );
    expect(batch.events).toHaveLength(10);
    expect(
      batch.events
        .filter((event) => event.is_human_turn)
        .map((event) => event.text),
    ).toEqual(["Fix the product cache."]);
    expect(batch.events[1]?.parse_warnings).toContain("mirrored_message");
    expect(batch.events[4]?.parse_warnings).toContain("mirrored_message");
    expect(batch.events[5]).toMatchObject({
      actor: "tool",
      event_kind: "result",
      original_type: "event_msg.item_completed.FileChange",
      original_event_id: "patch-one",
    });
    expect(JSON.parse(batch.events[6]!.text!)).toMatchObject({
      command: ["/bin/zsh", "-lc", "pnpm test"],
      exit_code: 0,
      output: "14 tests passed",
    });
    expect(batch.events[8]?.is_human_turn).toBe(false);
    expect(batch.events[9]?.parse_status).toBe("unsupported_record");
  });
  it("preserves all records, exact UTF-8 source ranges, and physical ordering", async () => {
    const { batch, bytes } = await readCodexRollout(fixture);
    expect(batch.events).toHaveLength(9);
    for (const event of batch.events) {
      const ref = event.payload_ref;
      const original = JSON.parse(
        bytes.subarray(ref.byte_start, ref.byte_end).toString("utf8"),
      );
      expect(event.original_type.split(".")[0]).toBe(original.type);
      expect(ref.source_id).toBe(batch.source.source_id);
    }
    expect(batch.events[3]?.text).toContain("保留原始證據");
    expect(batch.events[6]?.parse_status).toBe("unsupported_record");
    expect(batch.events[7]?.event_kind).toBe("compaction");
    expect(batch.events[8]?.parse_warnings).toContain(
      "non_monotonic_timestamp",
    );
  });

  it("does not mistake developer context or a user-role response for a human turn", async () => {
    const { batch } = await readCodexRollout(fixture);
    expect(
      batch.events
        .filter((event) => event.is_human_turn)
        .map((event) => event.payload_ref.line_number),
    ).toEqual([4]);
    expect(batch.events[1]?.actor).toBe("developer");
    expect(batch.events[2]?.parse_warnings).toContain("unverified_user_role");
    const bytes = Buffer.from(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Internal prompt",
          source: "developer",
        },
      }),
    );
    expect(normalize(bytes).events[0]?.is_human_turn).toBe(false);
  });

  it("normalizes compressed copies to the same event identities and decoded offsets", async () => {
    const bytes = await readFile(fixture);
    const plain = normalize(bytes);
    const compressed = normalize(zstdCompressSync(bytes), `${fixture}.zst`);
    expect(compressed.source.decoded_sha256).toBe(plain.source.decoded_sha256);
    expect(compressed.source.source_id).not.toBe(plain.source.source_id);
    expect(
      compressed.events.map((event) => [
        event.event_id,
        event.payload_ref.byte_start,
        event.payload_ref.byte_end,
      ]),
    ).toEqual(
      plain.events.map((event) => [
        event.event_id,
        event.payload_ref.byte_start,
        event.payload_ref.byte_end,
      ]),
    );
    const checkedIn = await readCodexRollout(`${fixture}.zst`);
    expect(checkedIn.batch.source.decoded_sha256).toBe(
      plain.source.decoded_sha256,
    );
  });

  it("keeps complete event IDs stable after append without collapsing repeated lines", async () => {
    const bytes = await readFile(fixture);
    const line = Buffer.from(
      '{"type":"future_record","timestamp":"2026-11-10T10:00:00Z"}\n',
    );
    const before = normalize(bytes);
    const after = normalize(Buffer.concat([bytes, line, line]));
    expect(after.events.slice(0, 9).map((event) => event.event_id)).toEqual(
      before.events.map((event) => event.event_id),
    );
    expect(after.events[9]?.event_id).not.toBe(after.events[10]?.event_id);
  });

  it("retains malformed tails, invalid UTF-8, and missing metadata as explicit records", async () => {
    const { batch } = await readCodexRollout(
      resolve("fixtures/codex/v1/rollout-malformed-tail.jsonl"),
    );
    expect(batch.events).toHaveLength(3);
    expect(batch.events[2]?.parse_status).toBe("malformed_record");
    expect(batch.events[2]?.parse_warnings).toContain("malformed_tail");
    const invalid = normalize(Buffer.from([0xff, 10]));
    expect(invalid.events).toHaveLength(1);
    expect(invalid.events[0]?.parse_warnings).toContain(
      "missing_session_metadata",
    );
    expect(invalid.events[0]?.parse_status).toBe("malformed_record");
  });

  it("records distinct official lineage types without merging inherited events", async () => {
    const { batch } = await readCodexRollout(
      resolve("fixtures/codex/v1/rollout-fork.jsonl"),
    );
    const main = await readCodexRollout(fixture);
    expect(batch.lineage[0]).toMatchObject({
      relationship: "fork_of",
      parent_thread_id: "fixture-main",
      status: "observed",
    });
    expect(batch.events[1]?.event_id).not.toBe(main.batch.events[3]?.event_id);
    const child = normalize(
      Buffer.from(
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "child",
            parent_thread_id: "parent",
            attached_thread_parent_id: "attached",
          },
        }),
      ),
    );
    expect(child.lineage.map((edge) => edge.relationship)).toEqual([
      "spawned_by",
      "attached_to",
    ]);
  });
});
