import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCodexRollout } from "@sessionlore/adapter-codex";
import { afterEach, describe, expect, it } from "vitest";
import { ingest, renderTimeline, replay } from "../src/index.js";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sessionlore-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("offline pipeline", () => {
  it("deduplicates copies, replays every snapshot, and is idempotent on rerun", async () => {
    const output = await temporary();
    const input = resolve("fixtures/codex/v1");
    const first = await ingest(input, output);
    expect(first).toMatchObject({
      sources: 4,
      new_snapshots: 4,
      events: 15,
      duplicate_events: 9,
      malformed_records: 1,
      unsupported_records: 1,
    });
    for (const sourceId of first.source_ids) {
      expect(await replay(sourceId, output)).toMatchObject({ matched: true });
    }
    const timeline = await readFile(first.timeline_path, "utf8");
    const second = await ingest(input, output);
    expect(second.new_snapshots).toBe(0);
    expect(second.events).toBe(first.events);
    expect(await readFile(second.timeline_path, "utf8")).toBe(timeline);
    expect(await readdir(join(output, "raw"))).toHaveLength(4);
    if (process.platform !== "win32")
      expect((await stat(second.timeline_path)).mode & 0o777).toBe(0o600);
  });

  it("keeps earlier snapshots replayable after the source grows or disappears", async () => {
    const root = await temporary();
    const path = join(root, "rollout.jsonl");
    const output = join(root, "data");
    await writeFile(
      path,
      await readFile(resolve("fixtures/codex/v1/rollout-basic.jsonl")),
    );
    const before = await ingest(path, output);
    await writeFile(
      path,
      `${await readFile(path, "utf8")}{"type":"future_record"}\n`,
    );
    const after = await ingest(root, output);
    expect(after.sources).toBe(1);
    expect(after.events).toBe(before.events + 1);
    await rm(path);
    for (const sourceId of [...before.source_ids, ...after.source_ids]) {
      expect((await replay(sourceId, output)).matched).toBe(true);
    }
  });

  it("detects raw corruption during replay and repeated ingestion", async () => {
    const output = await temporary();
    const input = resolve("fixtures/codex/v1/rollout-basic.jsonl");
    const report = await ingest(input, output);
    const sourceId = report.source_ids[0];
    if (!sourceId) throw new Error("Missing source ID");
    await writeFile(join(output, "raw", sourceId), "corrupted");
    await expect(replay(sourceId, output)).rejects.toThrow("integrity check");
    await expect(ingest(input, output)).rejects.toThrow("integrity check");
  });

  it("prevents transcript Markdown or HTML from escaping its code block", async () => {
    const { batch } = await readCodexRollout(
      resolve("fixtures/codex/v1/rollout-basic.jsonl"),
    );
    const event = batch.events[3];
    if (!event) throw new Error("Missing fixture event");
    const hostile =
      '```\n<img src="https://example.invalid/tracker">\n[link](javascript:alert(1))\n\u001b[31m';
    const markdown = renderTimeline([
      { ...event, text: hostile, thread_id: "```\n# Fake heading" },
    ]);
    expect(markdown).toContain("````text\n```\n<img");
    expect(markdown).toContain("````text\nThread:");
    expect(markdown).not.toContain("\u001b");
    expect(markdown).toContain(event.event_id);
  });

  it("fails clearly on empty input and invalid source identifiers", async () => {
    const root = await temporary();
    await expect(ingest(root, join(root, "data"))).rejects.toThrow(
      "No rollout files",
    );
    await expect(replay("../outside", root)).rejects.toThrow();
  });
});
