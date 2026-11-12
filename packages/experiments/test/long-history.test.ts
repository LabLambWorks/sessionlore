import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Evidence, referencedIds } from "../src/evidence.js";
import { runLongComparison, usage } from "../src/long/index.js";
import {
  buildHierarchy,
  chunkEvidence,
  LONG_APPROACHES,
  NoteSchema,
  recursivePipeline,
} from "../src/long/pipelines.js";
import {
  type CallRecord,
  mapConcurrent,
  RunContext,
  type TokenCounter,
} from "../src/long/runtime.js";
import { type Embedder, HybridIndex } from "../src/long/search.js";
import { writeLongNarrative } from "../src/long/writing.js";
import {
  type Model,
  type ModelRequest,
  ModelResponseError,
} from "../src/model.js";

const roots: string[] = [];
it("keeps unknown network attempts when the same request later succeeds", () => {
  const failed: CallRecord = {
    key: "same",
    stage: "test",
    cache_hit: false,
    elapsed_ms: 60000,
    estimated_input_tokens: 10,
    input_tokens: null,
    output_tokens: null,
    cache_hit_tokens: 0,
    response_model: null,
    ok: false,
  };
  const success: CallRecord = {
    ...failed,
    elapsed_ms: 100,
    input_tokens: 10,
    output_tokens: 5,
    response_model: "fixture",
    ok: true,
  };
  const replay: CallRecord = { ...success, cache_hit: true };
  expect(usage([failed, success, replay, replay])).toMatchObject({
    calls: 2,
    cached_calls: 0,
    input_tokens: 10,
    output_tokens: 5,
    usage_unknown_calls: 1,
  });
  expect(usage([replay, replay])).toMatchObject({
    calls: 1,
    cached_calls: 1,
    input_tokens: 10,
  });
  expect(usage([failed, replay, replay])).toMatchObject({
    calls: 2,
    cached_calls: 1,
    input_tokens: 10,
    output_tokens: 5,
    usage_unknown_calls: 1,
  });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "sessionlore-long-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const tokenizer: TokenCounter = {
  name: "fixture-character-counter",
  count: (text) => Math.ceil(text.length / 4),
};
it("recovers cached citations in note prose only after the original source was read", async () => {
  const root = await temporary();
  let generations = 0;
  const model: Model = {
    name: "test",
    model: "note-citations",
    demo: false,
    async complete() {
      generations++;
      return { value: { refs: ["s1"] }, input_tokens: 10, output_tokens: 5 };
    },
  };
  const context = () =>
    new RunContext(
      "fixture",
      root,
      join(root, "cache"),
      model,
      tokenizer,
      { inputTokens: 50000, maxCalls: 5, concurrency: 1, maxRepairs: 0 },
      () => {},
    );
  const schema = z.object({ refs: z.array(z.string()) });
  const data = {
    summaries: [
      {
        summary: "A reported check.",
        facts: [],
        unresolved: ["Phone performance still needs a device test (s1)."],
      },
    ],
  };
  await expect(
    context().ask("outline", "plan", schema, data, "Plan"),
  ).rejects.toThrow("Citation s1 is absent");
  const replay = context();
  replay.readSources.add("s1");
  await expect(
    replay.ask("outline", "plan", schema, data, "Plan"),
  ).resolves.toEqual({ refs: ["s1"] });
  expect(generations).toBe(1);
  expect(replay.calls[0]?.cache_hit).toBe(true);
  // A globally read ID must still appear in this call's note, and raw
  // evidence prose is not allowed to grant access to a different source.
  await expect(
    replay.ask(
      "outline",
      "unmentioned",
      schema,
      { summaries: [{ summary: "Other work.", facts: [], unresolved: [] }] },
      "Plan",
    ),
  ).rejects.toThrow("Citation s1 is absent");
  await expect(
    replay.ask(
      "outline",
      "raw-mention",
      schema,
      { evidence: [{ id: "s2", text: "Source text mentions s1." }] },
      "Plan",
    ),
  ).rejects.toThrow("Citation s1 is absent");
});
const embedder: Embedder = {
  identity: "fixture-semantic-vectors",
  async encode(texts) {
    return texts.map((text) =>
      /cache|evict|memory/i.test(text) ? [1, 0] : [0, 1],
    );
  },
};
const source = (i: number, text = "Measured cache result.") =>
  ({
    id: `s${i}`,
    text,
    thread_id: "thread",
    kind: "event",
    timestamp: "2026-01-01T00:00:00Z",
    actor: "tool",
    event_kind: "result",
    is_human_turn: false,
    event_id: `event-${i}`,
    artifact_id: null,
    source: { artifact_sha256: "fixture" },
    text_start: 0,
    text_end: text.length,
  }) satisfies Evidence;
function ids(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(ids);
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object.id === "string" && /^s\d/.test(object.id)
      ? [object.id]
      : []),
    ...referencedIds(value),
    ...Object.values(object).flatMap(ids),
  ];
}
function fixtureModel(requests: ModelRequest[]): Model {
  return {
    name: "test",
    model: "fixture-long",
    demo: false,
    async complete(request) {
      requests.push(request);
      const refs = [...new Set(ids(request.data))].slice(0, 2);
      const fact = {
        text: "The sources discuss changes to the cache and their verification.",
        refs,
        status: "observed",
      };
      let value: unknown;
      if (
        request.schema.properties &&
        "action" in (request.schema.properties as object)
      ) {
        const data = request.data as {
          depth: number;
          chunks: { id: string }[];
          steps_remaining: number;
        };
        const step = Number(request.stage.match(/step-(\d+)$/)?.[1]);
        value = {
          action:
            data.depth === 0 && step === 1
              ? "delegate"
              : step >= (data.depth === 0 ? 6 : 2)
                ? "finish"
                : "read",
          reason: "Fixture reader operation",
          queries: ["cache"],
          chunk_ids: data.chunks.slice(0, 1).map((chunk) => chunk.id),
          question: "What happened to the cache?",
        };
      } else if (request.task === "write") {
        const data = request.data as { sections?: { section_id: string }[] };
        value = data.sections
          ? {
              sections: data.sections.map((section) => ({
                section_id: section.section_id,
                claims: [fact],
              })),
            }
          : { claims: [fact] };
      } else if (request.task === "verify") {
        const data = request.data as { claims?: { id: string }[] };
        const verdict = {
          verdict: "supported",
          reason: "Synthetic test verdict, not semantic evaluation",
        };
        value = data.claims
          ? {
              reviews: data.claims.map((claim) => ({
                ...verdict,
                claim_id: claim.id,
                replacement: null,
              })),
            }
          : verdict;
      } else if (
        request.task === "outline" ||
        request.task === "discover" ||
        request.task === "revise"
      )
        value = {
          title: "Fixture history",
          sections: [
            {
              heading: "Cache changes",
              focus: "Cache decisions and tests",
              refs,
              queries: ["cache test"],
            },
          ],
        };
      else
        value = {
          summary: "Fixture summary of cache changes.",
          facts: refs.length ? [fact] : [],
          unresolved: [],
        };
      return {
        value,
        input_tokens: 100,
        output_tokens: 30,
        cache_hit_tokens: 10,
      };
    },
  };
}

describe("full-history comparison", () => {
  it("lets the recursive controller finish after one useful read instead of forcing extra root operations", async () => {
    const root = await temporary();
    const requests: ModelRequest[] = [];
    const base = fixtureModel(requests);
    const model: Model = {
      ...base,
      async complete(request) {
        if (request.stage.startsWith("recursive/root/step-")) {
          requests.push(request);
          const data = request.data as {
            memory: unknown[];
            chunks: { id: string }[];
          };
          return {
            value: {
              action: data.memory.length ? "finish" : "read",
              reason: "The focused read answered the question.",
              queries: [],
              chunk_ids: data.memory.length ? [] : [data.chunks[0]!.id],
              question: "What changed?",
            },
            input_tokens: 20,
            output_tokens: 10,
          };
        }
        return base.complete(request);
      },
    };
    const evidence = [{ ...source(1), actor: "user", is_human_turn: true }];
    const ctx = new RunContext(
      "recursive",
      root,
      join(root, "cache"),
      model,
      tokenizer,
      { inputTokens: 60000, maxCalls: 12, concurrency: 1, maxRepairs: 0 },
      () => {},
    );
    const prepared = await recursivePipeline(
      ctx,
      chunkEvidence(evidence, tokenizer, 4000),
      new HybridIndex(evidence, [[1, 0]], embedder),
    );
    expect(prepared.sections).toHaveLength(1);
    expect(
      requests.filter((request) =>
        request.stage.startsWith("recursive/root/step-"),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.stage.startsWith("recursive/root/read-"),
      ),
    ).toHaveLength(1);
    expect(
      requests.some((request) => request.stage === "recursive/root/answer"),
    ).toBe(false);
  });
  it("bounds exploration even when the recursive controller keeps asking to read", async () => {
    const root = await temporary();
    const requests: ModelRequest[] = [];
    const base = fixtureModel(requests);
    const model: Model = {
      ...base,
      async complete(request) {
        if (request.stage.startsWith("recursive/root/step-")) {
          requests.push(request);
          const data = request.data as {
            chunks: { id: string }[];
            steps_remaining: number;
          };
          return {
            value: {
              action: "read",
              reason: "Keep investigating",
              queries: [],
              chunk_ids: [data.chunks[0]!.id],
              question: `Investigation ${data.steps_remaining}`,
            },
            input_tokens: 20,
            output_tokens: 10,
          };
        }
        return base.complete(request);
      },
    };
    const evidence = [{ ...source(1), actor: "user", is_human_turn: true }];
    const ctx = new RunContext(
      "recursive",
      root,
      join(root, "cache"),
      model,
      tokenizer,
      { inputTokens: 60000, maxCalls: 30, concurrency: 1, maxRepairs: 0 },
      () => {},
    );
    const prepared = await recursivePipeline(
      ctx,
      chunkEvidence(evidence, tokenizer, 4000),
      new HybridIndex(evidence, [[1, 0]], embedder),
    );
    expect(prepared.sections).toHaveLength(1);
    expect(
      requests.filter((request) =>
        request.stage.startsWith("recursive/root/read-"),
      ),
    ).toHaveLength(6);
    expect(
      requests.filter((request) =>
        request.stage.startsWith("recursive/root/step-"),
      ),
    ).toHaveLength(6);
    expect(
      JSON.parse(await readFile(join(root, "recursive-budget.json"), "utf8")),
    ).toMatchObject({ source_reads: 6, source_text_truncated: false });
  });
  it("reuses exact responses from another run without changing that cache or reusing changed evidence", async () => {
    const root = await temporary();
    const requests: ModelRequest[] = [];
    const model = fixtureModel(requests);
    const schema = z.object({
      claims: z.array(
        z.object({
          text: z.string(),
          refs: z.array(z.string()),
          status: z.string(),
        }),
      ),
    });
    const oldCache = join(root, "old-cache");
    const first = new RunContext(
      "old",
      join(root, "old"),
      oldCache,
      model,
      tokenizer,
      { inputTokens: 60000, concurrency: 1, maxCalls: 1 },
      () => {},
    );
    await first.ask(
      "write",
      "first",
      schema,
      { id: "s1", text: "original" },
      "JSON",
    );
    const prior = await readFile(
      join(oldCache, `${first.calls[0]!.key}.json`),
      "utf8",
    );
    const next = new RunContext(
      "new",
      join(root, "new"),
      join(root, "new-cache"),
      model,
      tokenizer,
      {
        inputTokens: 60000,
        concurrency: 1,
        maxCalls: 2,
        cacheDirectories: [oldCache],
      },
      () => {},
    );
    await next.ask(
      "write",
      "another-stage",
      schema,
      { id: "s1", text: "original" },
      "JSON",
    );
    expect(requests).toHaveLength(1);
    expect(next.calls[0]?.cache_hit).toBe(true);
    expect(
      await readFile(join(oldCache, `${first.calls[0]!.key}.json`), "utf8"),
    ).toBe(prior);
    await next.ask(
      "write",
      "changed",
      schema,
      { id: "s1", text: "different evidence" },
      "JSON",
    );
    expect(requests).toHaveLength(2);
    expect(next.calls[1]?.cache_hit).toBe(false);
  });
  it("reuses strict-summary cache entries after removing the fact-count limit without double charging", async () => {
    const root = await temporary();
    const requests: ModelRequest[] = [];
    const model = fixtureModel(requests);
    const create = () =>
      new RunContext(
        "migration",
        root,
        join(root, "cache"),
        model,
        tokenizer,
        { inputTokens: 60000, concurrency: 1, maxCalls: 5 },
        () => {},
      );
    const strict = NoteSchema.extend({ facts: NoteSchema.shape.facts.max(32) });
    const first = create();
    await first.ask(
      "summarize",
      "strict",
      strict,
      { id: "s1", text: "original" },
      "JSON",
    );
    const next = create();
    await next.ask(
      "summarize",
      "relaxed",
      NoteSchema,
      { id: "s1", text: "original" },
      "JSON",
    );
    expect(requests).toHaveLength(1);
    expect(next.calls[0]?.key).toBe(first.calls[0]?.key);
    expect(next.calls[0]?.cache_hit).toBe(true);
  });
  it("preserves malformed-response usage and makes distinct bounded repairs instead of replaying one failed repair", async () => {
    const root = await temporary();
    let paid = 0;
    const model: Model = {
      name: "test",
      model: "malformed",
      demo: false,
      async complete() {
        paid++;
        if (paid === 1)
          throw new ModelResponseError("Model returned invalid JSON", {
            value: "{invalid",
            input_tokens: 50,
            output_tokens: 10,
          });
        return {
          value: { refs: paid < 4 ? ["s999"] : "s1" },
          input_tokens: 50,
          output_tokens: 10,
        };
      },
    };
    const create = () =>
      new RunContext(
        "repair",
        root,
        join(root, "cache"),
        model,
        tokenizer,
        { inputTokens: 60000, concurrency: 1, maxCalls: 4 },
        () => {},
      );
    const ctx = create();
    const schema = z.object({ refs: z.array(z.string()) });
    expect(
      await ctx.ask(
        "summarize",
        "test",
        schema,
        { id: "s1", text: "original" },
        "JSON",
      ),
    ).toEqual({ refs: ["s1"] });
    expect(paid).toBe(4);
    expect(ctx.calls.reduce((sum, call) => sum + call.input_tokens!, 0)).toBe(
      200,
    );
    expect(new Set(ctx.calls.map((call) => call.key)).size).toBe(4);
    await create().ask(
      "summarize",
      "resume",
      schema,
      { id: "s1", text: "original" },
      "JSON",
    );
    expect(paid).toBe(4);
  });
  it("preserves every source exactly once and respects token limits and chat boundaries", () => {
    const evidence = Array.from({ length: 120 }, (_, i) => ({
      ...source(i, "A source with measured evidence. ".repeat(40)),
      thread_id: i < 60 ? "a" : "b",
      is_human_turn: i % 9 === 0,
    }));
    const chunks = chunkEvidence(evidence, tokenizer, 4000);
    expect(chunks.flatMap((chunk) => chunk.refs)).toEqual(
      evidence.map((item) => item.id),
    );
    expect(chunks.every((chunk) => chunk.tokens <= 4000)).toBe(true);
    for (const chunk of chunks)
      expect(
        new Set(
          chunk.refs.map(
            (id) => evidence.find((item) => item.id === id)!.thread_id,
          ),
        ).size,
      ).toBe(1);
    expect(() =>
      chunkEvidence([source(1, "x".repeat(30000))], tokenizer, 4000),
    ).toThrow("One record");
  });

  it("reduces a large tree without carrying the complete descendant reference list in every parent", async () => {
    const root = await temporary();
    const evidence = Array.from({ length: 140 }, (_, i) => source(i + 1));
    const requests: ModelRequest[] = [];
    const base = fixtureModel(requests);
    const model: Model = {
      ...base,
      async complete(request) {
        const result = await base.complete(request);
        if (request.task === "summarize")
          (result.value as { summary: string }).summary =
            "Measured source evidence. ".repeat(45);
        return result;
      },
    };
    const ctx = new RunContext(
      "tree",
      root,
      join(root, "cache"),
      model,
      tokenizer,
      { inputTokens: 60000, concurrency: 4, maxCalls: 200 },
      () => {},
    );
    const index = new HybridIndex(
      evidence,
      evidence.map(() => [1, 0]),
      embedder,
    );
    const chunks = evidence.map((item, i) => ({
      id: `c${i}`,
      refs: [item.id],
      thread_id: item.thread_id,
      tokens: 20,
    }));
    const tree = await buildHierarchy(ctx, chunks, index);
    expect(ctx.readSources.size).toBe(evidence.length);
    expect(tree.nodes.length).toBeGreaterThan(chunks.length);
    expect(
      tree.nodes.slice(chunks.length).every((node) => node.refs.length <= 2),
    ).toBe(true);
    expect(
      tree.nodes
        .slice(chunks.length)
        .some((node) => node.child_ids.length > node.refs.length),
    ).toBe(true);
    expect(tokenizer.count(JSON.stringify(tree.roots))).toBeLessThan(20000);
  });

  it("persists validation repairs and reuses paid responses after restart", async () => {
    const root = await temporary();
    let paid = 0;
    const model: Model = {
      name: "test",
      model: "repair",
      demo: false,
      async complete() {
        paid++;
        return {
          value: { refs: [paid === 1 ? "s999" : "s1"] },
          input_tokens: 20,
          output_tokens: 5,
        };
      },
    };
    const create = () =>
      new RunContext(
        "repair",
        root,
        join(root, "cache"),
        model,
        tokenizer,
        { inputTokens: 60000, concurrency: 1, maxCalls: 3 },
        () => {},
      );
    const schema = z.object({ refs: z.array(z.string()) });
    const first = create();
    expect(
      await first.ask(
        "summarize",
        "first",
        schema,
        { id: "s1", text: "source" },
        "JSON",
      ),
    ).toEqual({ refs: ["s1"] });
    expect(first.calls).toHaveLength(2);
    const resumed = create();
    expect(
      await resumed.ask(
        "summarize",
        "resumed",
        schema,
        { id: "s1", text: "source" },
        "JSON",
      ),
    ).toEqual({ refs: ["s1"] });
    expect(paid).toBe(2);
    expect(resumed.calls.every((call) => call.cache_hit)).toBe(true);
    expect(
      resumed.calls.reduce((sum, call) => sum + call.input_tokens!, 0),
    ).toBe(40);
  });

  it("enforces call limits with concurrent requests and waits for in-flight work before reporting a failure", async () => {
    const root = await temporary();
    const requests: ModelRequest[] = [];
    const ctx = new RunContext(
      "limited",
      root,
      join(root, "cache"),
      fixtureModel(requests),
      tokenizer,
      { inputTokens: 60000, concurrency: 8, maxCalls: 2 },
      () => {},
    );
    await expect(
      mapConcurrent([1, 2, 3, 4], 4, async (i) =>
        ctx.ask(
          "verify",
          `${i}`,
          z.object({ verdict: z.string(), reason: z.string() }),
          { i },
          "JSON",
        ),
      ),
    ).rejects.toThrow("Call budget");
    expect(requests).toHaveLength(2);
    expect(ctx.calls).toHaveLength(2);
  });

  it("uses semantic and lexical retrieval, including evidence near the end of a source", async () => {
    const evidence = [
      source(1, "Evict stale entries."),
      source(2, "other material ".repeat(100) + "unique_identifier_87"),
      source(3, "unrelated"),
    ];
    const index = new HybridIndex(
      evidence,
      [
        [1, 0],
        [0, 1],
        [0, 1],
      ],
      embedder,
    );
    expect((await index.search("free memory", 1))[0]!.id).toBe("s1");
    expect(
      (await index.search("unique_identifier_87", 2)).some(
        (hit) => hit.id === "s2",
      ),
    ).toBe(true);
  });

  it("batches complete writing and source checks, preserves corrections separately, and reuses every paid response", async () => {
    const root = await temporary();
    const evidence = [
      source(1, "The owner asked for a cache. Codex reported it implemented."),
      source(2, "Later tests failed; the fix was still pending."),
    ];
    const requests: ModelRequest[] = [];
    const model: Model = {
      name: "test",
      model: "first-person",
      demo: false,
      async complete(request) {
        requests.push(request);
        const value =
          request.task === "write"
            ? {
                sections: [
                  {
                    section_id: "section-1",
                    claims: [
                      {
                        text: "I asked Codex for a cache.",
                        refs: ["s1"],
                        status: "observed",
                      },
                    ],
                  },
                  {
                    section_id: "section-2",
                    claims: [
                      {
                        text: "I completed every test successfully.",
                        refs: ["s1"],
                        status: "observed",
                      },
                    ],
                  },
                ],
              }
            : {
                reviews: [
                  {
                    claim_id: "claim-1-1",
                    verdict: "supported",
                    reason: "Request is supported.",
                    replacement: null,
                  },
                  {
                    claim_id: "claim-2-1",
                    verdict: "unsupported",
                    reason: "Later results report a failure.",
                    replacement: {
                      text: "Codex reported the cache implemented, but later tests failed and the fix was still pending.",
                      refs: ["s1", "s2"],
                      status: "observed",
                    },
                  },
                ],
              };
        return { value, input_tokens: 100, output_tokens: 50 };
      },
    };
    const index = new HybridIndex(
      evidence,
      [
        [1, 0],
        [1, 0],
      ],
      embedder,
    );
    const shared = { id: "s1", text: evidence[0]!.text };
    const prepared = {
      outline: {
        title: "My cache",
        sections: ["Start", "Outcome"].map((heading) => ({
          heading,
          focus: heading,
          refs: ["s1"],
          queries: ["cache"],
        })),
      },
      sections: ["Start", "Outcome"].map((heading) => ({
        heading,
        focus: heading,
        evidence: [shared],
      })),
    };
    const create = () =>
      new RunContext(
        "batch",
        root,
        join(root, "cache"),
        model,
        tokenizer,
        { inputTokens: 60000, maxCalls: 5, concurrency: 1, maxRepairs: 0 },
        () => {},
      );
    const result = await writeLongNarrative(create(), prepared, index, 500);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.instruction).toContain("first-person");
    expect(
      (requests[0]!.data as { material: unknown[] }).material,
    ).toHaveLength(1);
    expect(
      (requests[1]!.data as { cited_evidence: unknown[] }).cited_evidence,
    ).toHaveLength(1);
    expect(result.metrics).toMatchObject({ corrected: 1, withheld: 0 });
    expect(await readFile(join(root, "draft.md"), "utf8")).toContain(
      "I completed every test successfully",
    );
    const final = await readFile(join(root, "narrative.md"), "utf8");
    expect(final).toContain("later tests failed");
    expect(final).not.toContain("I completed every test successfully");
    await writeLongNarrative(create(), prepared, index, 500);
    expect(requests).toHaveLength(2);
  });

  it("runs four distinct full-input paths, records recursive delegation, produces a reader, and resumes without model calls", async () => {
    const root = await temporary();
    const requests: ModelRequest[] = [];
    const options = {
      input: resolve("fixtures/experiments/v1/sessions"),
      output: root,
      model: fixtureModel(requests),
      tokenizer,
      embedder,
      chunkTokens: 4000,
      targetWords: 400,
    };
    const result = await runLongComparison(options);
    expect(result.preflight.evidence_view).toBe("conversation");
    expect(result.preflight.archived_fragments).toBeGreaterThan(0);
    expect(
      result.results.map((item) => [item.approach, item.status, item.reason]),
    ).toEqual(LONG_APPROACHES.map((name) => [name, "complete", null]));
    expect(
      result.results.find((item) => item.approach === "hierarchy")?.metrics
        ?.source_characters_read_fraction,
    ).toBe(1);
    expect(
      result.results.find((item) => item.approach === "hierarchy-retrieval")
        ?.cached_calls,
    ).toBeGreaterThan(0);
    const summaryPrepared = await readFile(
      join(root, "hierarchy/prepared.json"),
      "utf8",
    );
    const rawPrepared = await readFile(
      join(root, "hybrid/prepared.json"),
      "utf8",
    );
    expect(summaryPrepared).toContain('"facts"');
    expect(rawPrepared).toContain('"actor"');
    expect(
      await readFile(join(root, "recursive/recursive-trace.json"), "utf8"),
    ).toContain('"delegate"');
    expect(await readFile(join(root, "comparison.html"), "utf8")).toContain(
      "All four side by side",
    );
    const html = await readFile(join(root, "comparison.html"), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    expect(() => new Script(script)).not.toThrow();
    const embedded = JSON.parse(
      html.match(
        /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
      )![1]!,
    );
    expect(embedded.documents).toHaveLength(4);
    for (const doc of embedded.documents) {
      for (const review of doc.reviews) {
        for (const id of review.replacement?.refs ?? [])
          expect(embedded.evidence[id]).toBeDefined();
      }
    }
    const count = requests.length;
    await runLongComparison(options);
    expect(requests).toHaveLength(count);
    await expect(
      runLongComparison({ ...options, targetWords: 500 }),
    ).rejects.toThrow("different inputs or model settings");
    await expect(
      runLongComparison({ ...options, evidenceView: "execution" }),
    ).rejects.toThrow("different inputs or model settings");
  });
});
