import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Corpus, Evidence } from "../src/evidence.js";
import {
  auditPassed,
  validateCoverage,
  validateLedger,
} from "../src/long/detail-check.js";
import { RequestResultIndex, recordRole } from "../src/long/request-result.js";
import { runRetrievalComparison } from "../src/long/retrieval-comparison.js";
import { atomicJson, hash } from "../src/long/runtime.js";
import { HybridIndex } from "../src/long/search.js";
import {
  type Model,
  ModelQuotaError,
  type ModelRequest,
} from "../src/model.js";

const source = (
  id: string,
  text: string,
  actor = "tool",
  event_kind = "result",
  thread = "chat",
): Evidence => ({
  id,
  text,
  actor,
  event_kind,
  thread_id: thread,
  is_human_turn: actor === "human",
  kind: "event",
  timestamp:
    "2026-01-" +
    String(1 + Number(id.slice(1))).padStart(2, "0") +
    "T00:00:00Z",
  event_id: id,
  artifact_id: null,
  source: { artifact_sha256: "fixture" },
  text_start: 0,
  text_end: text.length,
});
const embedder = {
  identity: "fixture",
  async encode(texts: string[]) {
    return texts.map(() => [1, 0]);
  },
};
const tokenizer = {
  name: "fixture",
  count: (text: string) => Math.ceil(text.length / 4),
};
const corpusOf = (evidence: Evidence[]): Corpus => ({
  evidence,
  lineage: [],
  excluded_events: [],
});

it("follows actual replies and late results without treating delivery as approval", async () => {
  const evidence = [
    source("s1", "Please replace the turbine sound.", "human", "message"),
    source(
      "s2",
      '{"questions":[{"id":"confirm","question":"Use an original sound?"}]}',
      "assistant",
      "action",
    ),
    source("s3", '{"accepted":true}'),
    source(
      "s4",
      '<send_user_message_question_reply>[{"question":"Use an original sound?","answer":"Yes"}]</send_user_message_question_reply>',
      "human",
      "message",
    ),
    source("s5", "Researching recordings.", "assistant", "message"),
    source("s6", "A large unrelated tool log ".repeat(200)),
    source(
      "s7",
      '{"command":"test","status":"completed","exit_code":0,"output":"17 checks passed"}',
    ),
    source(
      "s8",
      "Implemented an original turbine loop. Tests passed; listening remains.",
      "assistant",
      "message",
    ),
    source("s9", "Please change the sky.", "human", "message", "other"),
  ];
  const base = new HybridIndex(
    evidence,
    evidence.map(() => [1, 0]),
    embedder,
  );
  const index = new RequestResultIndex(base, corpusOf(evidence));
  expect(index.episodeBySource.get("s1")).toBe(index.episodeBySource.get("s4"));
  expect(recordRole(evidence[2]!)).toBe("delivery_acknowledgement");
  expect(index.links).toContainEqual({
    from: "s2",
    to: "s4",
    relationship: "question_answer",
    basis: "matching_question",
  });
  expect(
    index.links.some(
      (l) => l.to === "s3" && l.relationship === "question_answer",
    ),
  ).toBe(false);
  const result = await index.select(["turbine sound"], [], tokenizer, 4000);
  expect(result.evidence.map((e) => e.id)).toEqual(
    expect.arrayContaining(["s1", "s2", "s4", "s7", "s8"]),
  );
  expect(result.coverage.indexed_sources).toBe(evidence.length);
  expect(result.coverage.time_filter).toBeNull();
  const small = await index.select(["turbine sound"], [], tokenizer, 160);
  expect(small.estimated_tokens).toBeLessThanOrEqual(160);
  expect(small.omitted_candidate_ids.length).toBeGreaterThan(0);
  expect(small.episodes.some((e) => e.missing_spine_ids.length > 0)).toBe(true);
});

it("reassembles event fragments, retains duplicate provenance, and links answer keys", async () => {
  const question = source(
    "s1",
    '{"questions":[{"id":"pace","question":"How fast?"}]}',
    "assistant",
    "action",
  );
  const a = source("s2", '{"answers":{"pace":');
  const b = {
    ...source("s3", '{"answers":["slow"]}}}'),
    event_id: "s2",
    text_start: a.text.length,
  };
  const duplicate = {
    ...a,
    id: "s4",
    event_id: "s4",
    thread_id: "fork",
    text: a.text + b.text,
  };
  const evidence = [question, a, b, duplicate];
  const index = new RequestResultIndex(
    new HybridIndex(
      evidence,
      evidence.map(() => [1, 0]),
      embedder,
    ),
    corpusOf(evidence),
  );
  expect(index.eventBySource.get("s2")!.role).toBe("user_answer");
  expect(index.eventBySource.get("s3")).toBe(index.eventBySource.get("s2"));
  expect(index.links).toContainEqual({
    from: "s1",
    to: "s2",
    relationship: "question_answer",
    basis: "matching_answer_keys",
  });
});

it("rejects invented quote anchors and incomplete detail coverage", () => {
  const evidence = [
    source("s1", "Ordinary items never grant a second reward."),
  ];
  const ledger = {
    details: [
      {
        id: "d1",
        kind: "exception" as const,
        text: "Ordinary items grant no repeat reward.",
        refs: ["s1"],
        anchors: [{ ref: "s1", quote: "never grant a second reward" }],
      },
    ],
  };
  expect(() => validateLedger(ledger, evidence)).not.toThrow();
  expect(() =>
    validateLedger(
      {
        details: [
          {
            ...ledger.details[0]!,
            anchors: [{ ref: "s1", quote: "Always grant another reward" }],
          },
        ],
      },
      evidence,
    ),
  ).toThrow("quote is not present");
  expect(() => validateCoverage([], ledger)).toThrow("exactly once");
  expect(
    auditPassed({
      coverage: [
        {
          detail_id: "d1",
          status: "partial",
          explanation: "Exception missing.",
        },
      ],
      issues: [],
    }),
  ).toBe(false);
});

it("runs Kimi-only ablations without evaluator leakage and resumes all stages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessionlore-request-result-"));
  try {
    const sourceDir = join(dir, "source"),
      output = join(dir, "out"),
      cases = join(dir, "cases.json");
    const evidence = [
      source("s1", "Please change the cache.", "human", "message"),
      source(
        "s2",
        "Cache changed; duplicate requests grant no reward.",
        "assistant",
        "message",
      ),
    ];
    const corpus = corpusOf(evidence);
    await atomicJson(join(sourceDir, "corpus.json"), corpus);
    await atomicJson(join(sourceDir, "manifest.json"), {
      corpus_sha256: hash(corpus),
      time_filter: null,
      thread_ids: ["chat"],
    });
    await atomicJson(cases, {
      version: 1,
      description: "fixture",
      cases: [
        {
          id: "cache",
          question: "What changed in the cache?",
          queries: ["cache"],
          oracle_refs: ["s2"],
          groups: [{ label: "EVALUATOR_ONLY", any_of: ["s2"] }],
          rubric: ["SECRET_EXPECTED_ANSWER"],
        },
      ],
    });
    const calls: ModelRequest[] = [];
    const answer = {
      summary: "Cache changed.",
      facts: [{ kind: "change", text: "Cache changed.", refs: ["s2"] }],
      unknowns: [],
    };
    const coverage = [
      { detail_id: "d1", status: "covered", explanation: "Present." },
    ];
    const model: Model = {
      name: "fixture",
      model: "kimi-fixture",
      demo: false,
      configuration: { api_style: "kimi-code", timeout_ms: 180000 },
      async complete(request) {
        calls.push(request);
        expect(JSON.stringify(request)).not.toMatch(
          /EVALUATOR_ONLY|SECRET_EXPECTED_ANSWER|oracle_refs/,
        );
        let value: unknown = answer;
        if (request.stage.startsWith("ledger/")) {
          expect(request.data).not.toHaveProperty("draft");
          value = {
            details: [
              {
                id: "d1",
                kind: "exception",
                text: "Duplicates grant no reward.",
                refs: ["s2"],
                anchors: [
                  { ref: "s2", quote: "duplicate requests grant no reward" },
                ],
              },
            ],
          };
        } else if (request.stage.startsWith("revise/"))
          value = {
            before: [{ ...coverage[0], status: "missing" }],
            issues: [],
            answer: {
              ...answer,
              facts: [
                {
                  kind: "change",
                  text: "Cache changed; duplicates grant no reward.",
                  refs: ["s2"],
                },
              ],
            },
          };
        else if (request.stage.startsWith("audit/"))
          value = { coverage, issues: [] };
        return { value, input_tokens: 30, output_tokens: 20 };
      },
    };
    const options = {
      sourceDirectory: sourceDir,
      benchmarkPath: cases,
      output,
      model,
      tokenizer,
      embedder,
    };
    const result = await runRetrievalComparison(options);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.status === "complete")).toBe(true);
    expect(
      result.rows.find((r) => r.variant === "checked")?.model_check_passed,
    ).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls[0]!.instruction).toBe(calls[1]!.instruction);
    await runRetrievalComparison(options);
    expect(calls).toHaveLength(5);
    // Simulate interrupted assembly after all paid responses reached the cache.
    await rm(join(output, "checked", "cache.json"));
    await rm(join(output, "checks"), { recursive: true });
    const extended = {
      ...options,
      model: {
        ...model,
        configuration: { ...model.configuration, timeout_ms: 600000 },
      },
    };
    const extendedResult = await runRetrievalComparison(extended);
    expect(extendedResult.rows.every((r) => r.status === "complete")).toBe(
      true,
    );
    expect(calls).toHaveLength(5);
    const resumedManifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    expect(resumedManifest.transport_changes).toHaveLength(1);
    expect(resumedManifest.transport_changes[0]).toMatchObject({
      from_timeout_ms: 180000,
      to_timeout_ms: 600000,
    });
    await expect(
      runRetrievalComparison({
        ...extended,
        model: {
          ...model,
          configuration: {
            ...model.configuration,
            timeout_ms: 900000,
            temperature: 1,
          },
        },
      }),
    ).rejects.toThrow("configuration changed");
    expect(await readFile(join(output, "comparison.html"), "utf8")).toContain(
      "KIMI ONLY",
    );
    await expect(
      runRetrievalComparison({
        ...options,
        model: { ...model, configuration: { api_style: "deepseek" } },
      }),
    ).rejects.toThrow("Kimi Code only");
    let quotaCalls = 0;
    const quotaOutput = join(dir, "quota");
    const quotaResult = await runRetrievalComparison({
      ...options,
      output: quotaOutput,
      concurrency: 1,
      model: {
        ...model,
        async complete() {
          quotaCalls++;
          throw new ModelQuotaError("monthly");
        },
      },
    });
    expect(quotaCalls).toBe(1);
    expect(quotaResult.rows.every((row) => row.status === "blocked")).toBe(
      true,
    );
    const quotaRecord = JSON.parse(
      (
        await readFile(join(quotaOutput, "current", "calls.jsonl"), "utf8")
      ).trim(),
    );
    expect(quotaRecord).toMatchObject({
      provider_rejection: "quota",
      input_tokens: 0,
      output_tokens: 0,
    });
    const resumed = await runRetrievalComparison({
      ...options,
      output: quotaOutput,
    });
    expect(resumed.rows.every((row) => row.status === "complete")).toBe(true);
    await atomicJson(cases, {
      version: 1,
      description: "changed",
      cases: [
        {
          id: "cache",
          question: "What changed?",
          queries: ["cache"],
          oracle_refs: ["s2"],
          groups: [{ label: "EVALUATOR_ONLY", any_of: ["s2"] }],
          rubric: ["SECRET_EXPECTED_ANSWER"],
        },
      ],
    });
    await expect(runRetrievalComparison(options)).rejects.toThrow(
      "configuration changed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
