import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Evidence, project } from "../src/evidence.js";
import {
  prepareGuardedReading,
  type ReadingBatch,
  ReadingLedger,
} from "../src/long/guarded-reading.js";
import { NOTE } from "../src/long/pipelines.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const batches: ReadingBatch[] = [
  { id: "first", source_ids: ["s1", "s2"], chunks: [], fingerprint: "set-12" },
  { id: "second", source_ids: ["s3"], chunks: [], fingerprint: "set-3" },
];
it("rejects early completion even after a valid reading step", () => {
  const ledger = new ReadingLedger(["s1", "s2", "s3"], batches);
  expect(() => ledger.finish()).toThrow("Early finish blocked");
  ledger.complete("first");
  expect(() => ledger.finish()).toThrow("Early finish blocked");
  expect(ledger.available().map((batch) => batch.id)).toEqual(["second"]);
});
it("rejects repeated or invented evidence selections before another read", () => {
  const ledger = new ReadingLedger(["s1", "s2", "s3"], batches);
  ledger.complete("first");
  expect(() => ledger.claim("first")).toThrow("repeated");
  expect(() => ledger.claim("finish")).toThrow("Unknown");
  expect(ledger.events).toHaveLength(1);
});
it("allows different decision orders while enforcing complete source coverage", () => {
  const ledger = new ReadingLedger(["s1", "s2", "s3"], batches);
  ledger.complete("second");
  ledger.complete("first");
  expect(ledger.finish()).toEqual({
    covered_sources: 3,
    remaining_sources: 0,
    duplicate_reads: 0,
  });
});
it("rejects evidence batches with omissions or overlap", () => {
  expect(() => new ReadingLedger(["s1", "s2", "s3", "s4"], batches)).toThrow(
    "exactly once",
  );
  expect(
    () =>
      new ReadingLedger(
        ["s1", "s2", "s3"],
        [batches[0]!, { ...batches[1]!, source_ids: ["s2", "s3"] }],
      ),
  ).toThrow("exactly once");
});
it("reuses a cached note only when complete original source text matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guarded-cache-"));
  roots.push(dir);
  await mkdir(join(dir, "model-cache"));
  const evidence = [
    {
      id: "s1",
      text: "An original result.",
      kind: "event",
      actor: "assistant",
      thread_id: "chat",
      event_kind: "message",
      timestamp: "2026-01-01T00:00:00Z",
      is_human_turn: false,
      source: {},
      text_start: 0,
      text_end: 19,
    },
  ] as Evidence[];
  await writeFile(
    join(dir, "model-cache", "note.json"),
    JSON.stringify({
      key: "seed",
      request: {
        stage: "tree/leaf-1-of-1",
        instruction: NOTE,
        data: { evidence: project(evidence) },
      },
      response: {
        value: { summary: "An original result.", facts: [], unresolved: [] },
      },
    }),
  );
  const chunks = [{ id: "c1", thread_id: "chat", refs: ["s1"], tokens: 20 }];
  const tokenizer = {
    name: "fixture",
    count: (text: string) => Math.ceil(text.length / 4),
  };
  expect(
    (await prepareGuardedReading(evidence, chunks, tokenizer, dir)).byChunk
      .size,
  ).toBe(1);
  const changed = evidence.map((item) => ({
    ...item,
    text: "A different result.",
  }));
  await expect(
    prepareGuardedReading(changed, chunks, tokenizer, dir),
  ).rejects.toThrow("No exact cached source summary");
});
