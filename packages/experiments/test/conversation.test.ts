import { expect, it } from "vitest";
import { conversationView, readArchivedEvidence } from "../src/conversation.js";
import type { Corpus, Evidence } from "../src/evidence.js";

function source(
  id: string,
  text: string,
  actor: string,
  event_kind: string,
): Evidence {
  return {
    id,
    text,
    actor,
    event_kind,
    kind: "event",
    thread_id: "chat",
    timestamp: "2026-01-01T00:00:00Z",
    is_human_turn: actor === "human",
    event_id: id,
    artifact_id: null,
    source: { artifact_sha256: "fixture" },
    text_start: 0,
    text_end: text.length,
  };
}

it("keeps actual communication, including fragmented question replies, and archives execution noise", () => {
  const first = source("s4", '{"answers":{"restart":', "tool", "result");
  const second = {
    ...source("s5", '{"answers":["Automatic"]}}}', "tool", "result"),
    event_id: "s4",
    text_start: first.text.length,
  };
  const archive: Corpus = {
    lineage: [],
    excluded_events: [],
    evidence: [
      source("s1", "Keep my progress.", "human", "message"),
      source(
        "s2",
        '{"questions":[{"id":"restart","question":"How should it restart?","options":[{"label":"Automatic"}]}]}',
        "assistant",
        "action",
      ),
      source("s3", '{"accepted":true}', "tool", "result"),
      first,
      second,
      source("s6", "Reading file... ".repeat(2000), "tool", "result"),
      source("s7", "run tests", "assistant", "action"),
      source("s8", "internal reasoning", "assistant", "thought"),
      source("s9", "injected harness instructions", "developer", "message"),
      source(
        "s10",
        "Implemented automatic restart; I report two passing tests.",
        "assistant",
        "message",
      ),
      source("s11", "Keep my progress.", "human", "message"),
    ],
  };
  const view = conversationView(archive);
  expect(view.corpus.evidence.map((e) => e.id)).toEqual([
    "s1",
    "s2",
    "s4",
    "s5",
    "s10",
    "s11",
  ]);
  expect(view.compact.threads[0]!.records[2]).toEqual([
    ["s4", "s5"],
    "user_answer",
    first.timestamp,
    first.text + second.text,
  ]);
  expect(JSON.stringify(view.compact)).not.toMatch(
    /Reading file|internal reasoning|harness instructions|accepted/,
  );
  // Repeated words in distinct messages are not silently deduplicated.
  expect(
    view.corpus.evidence.filter((e) => e.text === "Keep my progress."),
  ).toHaveLength(2);
  expect(archive.evidence).toHaveLength(11);
  expect(view.stats.archived_fragments).toBe(5);
});

it("reads archived originals only by explicit source ID and enforces a total size limit", () => {
  const item = source(
    "s1",
    "Direct test result: 12/12 passed.",
    "tool",
    "result",
  );
  const archive: Corpus = {
    evidence: [item],
    lineage: [],
    excluded_events: [],
  };
  expect(conversationView(archive).corpus.evidence).toHaveLength(0);
  expect(readArchivedEvidence(archive, ["s1", "s1"])).toEqual([item]);
  expect(() => readArchivedEvidence(archive, ["s1"], 10)).toThrow(
    "read budget",
  );
  expect(() => readArchivedEvidence(archive, ["s2"])).toThrow(
    "Unknown original source",
  );
});
