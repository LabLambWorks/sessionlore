import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ingest, loadEvidence } from "@sessionlore/core";
import { afterEach, describe, expect, it } from "vitest";
import { gitArtifacts, readArtifacts } from "../src/artifacts.js";
import {
  blocks,
  type Corpus,
  corpusFromBatches,
  type Evidence,
  referencedIds,
  SearchIndex,
} from "../src/evidence.js";
import {
  APPROACHES,
  DemoModel,
  type Model,
  type ModelRequest,
  runExperiment,
} from "../src/index.js";
import type { Card } from "../src/schema.js";

const roots: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "sessionlore-experiments-"));
  roots.push(path);
  return path;
}
const fixture = resolve("fixtures/experiments/v1/sessions");
const artifactFile = resolve("fixtures/experiments/v1/artifacts.json");
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8"));
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("six experiment approaches", () => {
  it("keeps frozen and live source ordering identical and deduplicates only explicit identical event identities", async () => {
    const root = await temporary();
    const report = await ingest(
      resolve("fixtures/codex/v2/rollout-completed-items.jsonl"),
      root,
    );
    const batch = (await loadEvidence(root, report.source_ids))[0]!;
    const event = batch.events[5]!;
    const resumed = {
      ...batch,
      source: { ...batch.source, source_id: "f".repeat(64) },
      events: [{ ...event, event_id: "e".repeat(64) }],
    };
    const first = corpusFromBatches([batch, resumed], [], 6000);
    expect(corpusFromBatches([resumed, batch], [], 6000)).toEqual(first);
    expect(
      first.evidence.filter(
        (item) =>
          item.event_kind === "result" && item.text.includes("unified_diff"),
      ),
    ).toHaveLength(1);
    expect(
      first.excluded_events.some((item) =>
        item.reason.includes("Repeated logical"),
      ),
    ).toBe(true);
    const otherThread = {
      ...resumed,
      events: [
        {
          ...resumed.events[0]!,
          thread_id: "independent",
          event_id: "d".repeat(64),
        },
      ],
    };
    expect(
      corpusFromBatches([batch, otherThread], [], 6000).evidence.filter(
        (item) =>
          item.event_kind === "result" && item.text.includes("unified_diff"),
      ),
    ).toHaveLength(2);
  });
  it("applies an explicit project time window equally to conversation and recorded artifacts", async () => {
    const result = await runExperiment({
      input: resolve("fixtures/codex/v2/rollout-completed-items.jsonl"),
      output: await temporary(),
      approaches: ["direct", "artifact"],
      model: new DemoModel(),
      includeSessionArtifacts: true,
      options: { since: "2026-11-10T09:00:05Z", until: "2026-11-10T09:00:07Z" },
    });
    expect(result.results.map((item) => item.status)).toEqual([
      "complete",
      "complete",
    ]);
    const corpus = await json<Corpus>(join(result.directory, "corpus.json"));
    expect(
      corpus.evidence.filter((item) => item.kind === "event"),
    ).toHaveLength(2);
    expect(
      corpus.evidence.filter((item) => item.kind === "artifact"),
    ).toHaveLength(2);
    expect(
      corpus.excluded_events.filter((item) =>
        item.reason.includes("time window"),
      ),
    ).toHaveLength(8);
    const manifest = await json<{ options: { since: string; until: string } }>(
      join(result.directory, "manifest.json"),
    );
    expect(manifest.options.since).toBe("2026-11-10T09:00:05Z");
  });
  it("executes genuinely different stages, retains provenance, and saves reviewable outputs for all six", async () => {
    const result = await runExperiment({
      input: fixture,
      output: await temporary(),
      model: new DemoModel(),
      approaches: [...APPROACHES],
      artifacts: await readArtifacts(artifactFile),
      options: { block_chars: 1800 },
    });
    expect(result.results.map((item) => [item.approach, item.status])).toEqual(
      APPROACHES.map((name) => [name, "complete"]),
    );
    const archive = await json<Corpus>(join(result.directory, "corpus.json"));
    const corpus = await json<Corpus>(
      join(result.directory, "primary-corpus.json"),
    );
    expect(corpus.evidence.length).toBeLessThan(archive.evidence.length);
    expect(
      corpus.evidence.every((item) =>
        archive.evidence.some((raw) => raw.id === item.id),
      ),
    ).toBe(true);
    const available = new Set(corpus.evidence.map((item) => item.id));
    const stages = new Map<string, string[]>();
    for (const item of result.results) {
      const calls = await readdir(join(item.directory, "calls"));
      const tasks: string[] = [];
      for (const file of calls) {
        const call = await json<{
          task: string;
          request: ModelRequest;
          response: unknown;
        }>(join(item.directory, "calls", file));
        tasks.push(call.task);
        expect(
          referencedIds(call.response).every((id) => available.has(id)),
        ).toBe(true);
      }
      stages.set(item.approach, tasks);
      expect(
        await readFile(join(item.directory, "narrative.md"), "utf8"),
      ).toContain("OFFLINE DEMONSTRATION");
      expect(item.quality?.supported_claims).toBeNull();
      expect(item.quality?.draft_claims).toBeGreaterThan(0);
    }
    expect(new Set(stages.get("direct"))).toEqual(
      new Set(["outline", "write", "verify"]),
    );
    expect(stages.get("hierarchical")).toContain("summarize");
    expect(stages.get("hierarchical")).not.toContain("score");
    expect(stages.get("pivot")).toContain("score");
    expect(stages.get("pivot")).toContain("card");
    expect(stages.get("pivot")).toContain("segment");
    expect(stages.get("workstream")!.indexOf("membership")).toBeLessThan(
      stages.get("workstream")!.indexOf("decisions"),
    );
    expect(stages.get("retrieval")).toContain("discover");
    expect(stages.get("retrieval")).toContain("revise");
    expect(stages.get("retrieval")).not.toContain("card");
    expect(stages.get("artifact")).toContain("reconstruct");
    const cards = await json<Card[]>(
      join(result.directory, "pivot/cards.json"),
    );
    const attachment = await json<{ source_id: string; pivot_id: string }[]>(
      join(result.directory, "pivot/attachments.json"),
    );
    const pivots = cards.map((card) => card.pivot_id);
    expect(
      new Set([...pivots, ...attachment.map((edge) => edge.source_id)]),
    ).toEqual(available);
    for (const edge of attachment) {
      const source = corpus.evidence.find(
        (item) => item.id === edge.source_id,
      )!;
      const target = corpus.evidence.find((item) => item.id === edge.pivot_id)!;
      expect(source.thread_id).toBe(target.thread_id);
      if (source.kind === "artifact")
        expect(source.artifact_id).toBe(target.artifact_id);
    }
    const traces = await json<{ round: number; hits: { id: string }[] }[]>(
      join(result.directory, "retrieval/retrieval-trace.json"),
    );
    expect(new Set(traces.map((trace) => trace.round))).toEqual(
      new Set([1, 2, 3]),
    );
    expect(
      traces
        .flatMap((trace) => trace.hits)
        .every((hit) => available.has(hit.id)),
    ).toBe(true);
    const unmatched = await json<string[]>(
      join(result.directory, "artifact/unmatched-conversation.json"),
    );
    expect(unmatched.length).toBeGreaterThan(0);
    expect(
      await readFile(join(result.directory, "comparison.md"), "utf8"),
    ).toContain("Do not use these results to rank");
  });

  it("skips an oversized direct baseline without truncation while hierarchical reduction processes all sources", async () => {
    const root = await temporary();
    const path = join(root, "long.jsonl");
    const records = [
      { type: "session_meta", payload: { id: "long-session" } },
      ...Array.from({ length: 45 }, (_, i) => ({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: `Task ${i}: investigate product cache case ${i}. ${"Measured evidence remains unresolved. ".repeat(25)}`,
        },
      })),
    ];
    await writeFile(
      path,
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    const result = await runExperiment({
      input: path,
      output: join(root, "output"),
      model: new DemoModel(),
      approaches: ["direct", "hierarchical"],
      options: { block_chars: 1800, context_chars: 18000 },
    });
    expect(result.results[0]).toMatchObject({ status: "skipped", calls: 0 });
    expect(result.results[0]?.reason).toContain("No evidence was truncated");
    expect(result.results[1]?.status, result.results[1]?.reason ?? "").toBe(
      "complete",
    );
    const corpus = await json<Corpus>(join(result.directory, "corpus.json"));
    const summaries = await json<{ refs: string[] }[]>(
      join(result.directory, "hierarchical/block-summaries.json"),
    );
    expect(new Set(summaries.flatMap((item) => item.refs))).toEqual(
      new Set(corpus.evidence.map((item) => item.id)),
    );
    const calls = await readdir(join(result.directory, "hierarchical/calls"));
    for (const file of calls) {
      const call = await json<{ task: string; request: ModelRequest }>(
        join(result.directory, "hierarchical/calls", file),
      );
      if (call.task === "write")
        expect(JSON.stringify(call.request.data)).not.toContain(
          "Measured evidence remains unresolved. ".repeat(25),
        );
    }
  });

  it("repairs invalid citations, withholds unsupported claims, and leaves other approaches runnable after failure", async () => {
    const demo = new DemoModel();
    let invalid = true;
    const model: Model = {
      name: "test",
      model: "scripted",
      demo: false,
      async complete(request) {
        if (request.task === "write" && invalid) {
          invalid = false;
          return {
            value: {
              claims: [
                {
                  text: "Invented deployment",
                  refs: ["s999999"],
                  status: "observed",
                },
              ],
            },
            input_tokens: 10,
            output_tokens: 5,
          };
        }
        if (request.task === "verify")
          return {
            value: {
              verdict: "unsupported",
              reason: "Test reviewer rejects this claim.",
            },
            input_tokens: 10,
            output_tokens: 5,
          };
        return demo.complete(request);
      },
    };
    const result = await runExperiment({
      input: fixture,
      output: await temporary(),
      approaches: ["direct"],
      model,
    });
    expect(result.results[0]?.status).toBe("complete");
    expect(result.results[0]?.quality?.unsupported_claims).toBeGreaterThan(0);
    const narrative = await readFile(
      join(result.directory, "direct/narrative.md"),
      "utf8",
    );
    expect(narrative).toContain("claims were withheld");
    expect(narrative).not.toContain("Invented deployment");
    const badModel: Model = {
      ...model,
      async complete(request) {
        if (request.task === "score")
          throw new Error("Synthetic score-stage outage");
        return demo.complete(request);
      },
    };
    const continued = await runExperiment({
      input: fixture,
      output: await temporary(),
      approaches: ["pivot", "retrieval", "artifact"],
      model: badModel,
    });
    expect(continued.results.map((item) => item.status)).toEqual([
      "failed",
      "complete",
      "skipped",
    ]);
    expect(continued.results[0]?.reason).toContain("score-stage outage");
    expect(continued.results[2]?.reason).toContain("No artifacts");
  });

  it("enforces the call budget and rejects an artifact-only selection without artifacts", async () => {
    const result = await runExperiment({
      input: fixture,
      output: await temporary(),
      model: new DemoModel(),
      approaches: ["hierarchical", "artifact"],
      options: { max_calls: 1 },
    });
    expect(result.results[0]).toMatchObject({ status: "failed", calls: 1 });
    expect(result.results[0]?.reason).toContain("Call limit");
    const single = await runExperiment({
      input: fixture,
      output: await temporary(),
      model: new DemoModel(),
      approaches: ["artifact"],
    });
    expect(single.results[0]?.status).toBe("failed");
  });

  it("reads an explicit Git range without executing configured external diffs", async () => {
    const root = await temporary();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Synthetic Fixture");
    await writeFile(join(root, "cache.txt"), "TTL\n");
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(root, "cache.txt"), "LRU 600\n");
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Bound cache");
    git("config", "diff.external", "false");
    const artifacts = await gitArtifacts(root, `${base}..HEAD`);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.text).toContain("+LRU 600");
    expect(artifacts[0]?.paths).toEqual(["cache.txt"]);
    await expect(gitArtifacts(root, "HEAD...HEAD")).rejects.toThrow(
      "base..head",
    );
  });

  it("preserves every fragment through turn chunking and retrieves identifiers and Chinese terms", () => {
    const entries = Array.from(
      { length: 5 },
      (_, i) =>
        ({
          id: `s${i}`,
          text: `case ${i} `,
          thread_id: "t",
          kind: "event",
          is_human_turn: i === 0 || i === 3,
        }) as Evidence,
    );
    expect(
      blocks(entries, 250)
        .flat()
        .map((item) => item.id),
    ).toEqual(entries.map((item) => item.id));
    const index = new SearchIndex(
      [
        { id: "a", text: "src/cache.ts LRU eviction" },
        { id: "b", text: "修正快取記憶體問題" },
        { id: "c", text: "unrelated documentation" },
      ],
      (item) => item.text,
    );
    expect(index.search("src/cache.ts", 1)[0]?.item.id).toBe("a");
    expect(index.search("記憶體", 1)[0]?.item.id).toBe("b");
    expect(index.search("missingword", 2)).toEqual([]);
  });
});
