import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTranscript, type TranscriptHost } from "../src/index.js";

async function normalize(path: string, host: TranscriptHost) {
  const bytes = await readFile(path);
  return normalizeTranscript(path, {
    host,
    sourceId: createHash("sha256").update(bytes).digest("hex"),
    rawSize: bytes.length,
    sourcePath: path,
    mtime: "2026-11-12T00:00:00Z",
    ingestedAt: "2026-11-12T00:00:00Z",
  });
}
describe("Claude and OpenCode adapters", () => {
  it.each(["claude", "opencode"] as const)(
    "preserves %s actors, original bytes, and tool results",
    async (host) => {
      const path = resolve(
        `fixtures/${host}/v1/session.${host === "claude" ? "jsonl" : "json"}`,
      );
      const bytes = await readFile(path);
      const batch = await normalize(path, host);
      expect(batch.events.filter((event) => event.is_human_turn)).toHaveLength(
        1,
      );
      expect(batch.events.find((event) => event.is_human_turn)?.text).toContain(
        "保留原有路軌",
      );
      expect(
        batch.events.filter((event) => event.actor === "tool"),
      ).toHaveLength(1);
      expect(
        batch.events.find((event) => event.actor === "tool")?.text,
      ).toContain("3 tests passed");
      expect(
        batch.events.find((event) => event.event_kind === "thought")?.text,
      ).toBeNull();
      for (const event of batch.events) {
        const original = bytes
          .subarray(event.payload_ref.byte_start, event.payload_ref.byte_end)
          .toString("utf8");
        expect(() => JSON.parse(original)).not.toThrow();
        expect(event.payload_ref.source_id).toBe(batch.source.source_id);
      }
    },
  );
  it("retains malformed tails and keeps existing IDs stable when Claude appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-adapter-"));
    try {
      const path = join(root, "source.jsonl");
      const original = await readFile(
        resolve("fixtures/claude/v1/session.jsonl"),
        "utf8",
      );
      await writeFile(path, original);
      const before = await normalize(path, "claude");
      await writeFile(path, original + '{"unfinished":');
      const after = await normalize(path, "claude");
      expect(
        after.events
          .slice(0, before.events.length)
          .map((event) => event.event_id),
      ).toEqual(before.events.map((event) => event.event_id));
      expect(after.events.at(-1)?.parse_status).toBe("malformed_record");
      expect(after.events.at(-1)?.parse_warnings).toContain("malformed_tail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not treat delegated Claude prompts as human instructions or merge them with the parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-child-"));
    try {
      const path = join(root, "agent-child.jsonl");
      await writeFile(
        path,
        JSON.stringify({
          type: "user",
          sessionId: "parent",
          agentId: "child",
          isSidechain: true,
          message: { content: "Inspect the tests." },
        }) + "\n",
      );
      const batch = await normalize(path, "claude");
      expect(batch.events[0]?.thread_id).toBe("parent/child");
      expect(batch.events[0]?.is_human_turn).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
