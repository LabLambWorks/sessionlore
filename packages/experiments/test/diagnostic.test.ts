import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Corpus, Evidence } from "../src/evidence.js";
import {
  diagnosticInput,
  evidenceRecall,
  runEvidenceDiagnostic,
} from "../src/long/diagnostic.js";
import { atomicJson, hash } from "../src/long/runtime.js";
import type { Model, ModelRequest } from "../src/model.js";

const source = (id: string, text: string): Evidence => ({
  id,
  text,
  thread_id: "chat",
  timestamp: "2026-01-01T00:00:00Z",
  actor: "human",
  event_kind: "message",
  is_human_turn: true,
  kind: "event",
  event_id: id,
  artifact_id: null,
  source: { artifact_sha256: "fixture" },
  text_start: 0,
  text_end: text.length,
});
it("isolates evaluator data, shares evidence across models, and resumes without paying again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessionlore-diagnostic-"));
  try {
    const evidence = [
      source("s1", "Cache was enlarged."),
      source("s2", "Cache was enlarged."),
      source("s3", "Later cache test passed."),
    ];
    const corpus = { evidence, lineage: [], excluded_events: [] } as Corpus;
    const test = {
      id: "cache",
      question: "What happened to the cache?",
      queries: ["cache"],
      oracle_refs: ["s1", "s3"],
      groups: [{ label: "EVALUATOR_ONLY", any_of: ["s1"] }],
      rubric: ["SECRET_EXPECTED_ANSWER"],
    };
    const sourceDir = join(dir, "source"),
      out = join(dir, "out"),
      cases = join(dir, "cases.json");
    await atomicJson(join(sourceDir, "corpus.json"), corpus);
    await atomicJson(join(sourceDir, "manifest.json"), {
      corpus_sha256: hash(corpus),
      time_filter: null,
      thread_ids: ["chat"],
    });
    await atomicJson(cases, {
      version: 1,
      description: "fixture",
      cases: [test],
    });
    expect(diagnosticInput(test, evidence)).not.toHaveProperty("rubric");
    expect(
      evidenceRecall(test, [evidence[1]!], evidence).groups[0]?.found,
    ).toBe(true);
    expect(
      evidenceRecall(test, [evidence[1]!], evidence).exact_id_hits,
    ).toEqual([]);
    const calls: ModelRequest[] = [];
    const model = (id: string): Model => ({
      name: "fixture",
      model: id,
      demo: false,
      async complete(request) {
        calls.push(request);
        expect(JSON.stringify(request)).not.toMatch(
          /SECRET_EXPECTED_ANSWER|EVALUATOR_ONLY|oracle_refs/,
        );
        const d = request.data as { evidence: Evidence[] };
        return {
          value: {
            summary: "Cache changed.",
            facts: [
              {
                kind: "change",
                text: "Cache changed.",
                refs: [d.evidence[0]!.id],
              },
            ],
            unknowns: [],
          },
          input_tokens: 20,
          output_tokens: 10,
        };
      },
    });
    const options = {
      sourceDirectory: sourceDir,
      benchmarkPath: cases,
      output: out,
      models: [
        { id: "first", model: model("one") },
        { id: "second", model: model("two") },
      ],
      tokenizer: { name: "fixture", count: (text: string) => text.length },
      embedder: {
        identity: "fixture",
        async encode(texts: string[]) {
          return texts.map(() => [1, 0]);
        },
      },
    };
    const result = await runEvidenceDiagnostic(options);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((row) => row.status === "complete")).toBe(true);
    for (const phase of ["oracle", "retrieved"])
      expect(
        new Set(
          result.rows
            .filter((row) => row.phase === phase)
            .map((row) => row.prompt_sha256),
        ).size,
      ).toBe(1);
    expect(calls.map((call) => call.stage)).toEqual([
      "oracle/cache",
      "oracle/cache",
      "retrieved/cache",
      "retrieved/cache",
    ]);
    await runEvidenceDiagnostic(options);
    expect(calls).toHaveLength(4);
    expect(await readFile(join(out, "answers.md"), "utf8")).toContain(
      "SECRET_EXPECTED_ANSWER",
    );
    await atomicJson(cases, {
      version: 1,
      description: "changed",
      cases: [test],
    });
    await expect(runEvidenceDiagnostic(options)).rejects.toThrow(
      "configuration changed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
