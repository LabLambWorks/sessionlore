import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve("apps/cli/dist/index.js");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

describe("CLI", () => {
  it("rejects time windows for the full-history comparison", () => {
    const result = run(
      "compare",
      "anything",
      "--provider",
      "deepseek",
      "--since",
      "2026-10-28T08:39:00Z",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("always uses the full project");
  });
  it("freezes a real-format case and runs all six methods using captured session artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-cli-case-"));
    try {
      const target = join(root, "case");
      const capture = run(
        "capture",
        resolve("fixtures/codex/v2/rollout-completed-items.jsonl"),
        "--out",
        target,
      );
      expect(capture.status, capture.stderr).toBe(0);
      const manifest = JSON.parse(capture.stdout);
      expect(manifest.report.human_turns).toBe(1);
      expect(
        run(
          "capture",
          resolve("fixtures/codex/v2/rollout-completed-items.jsonl"),
          "--out",
          target,
        ).status,
      ).toBe(1);
      const result = run(
        "run",
        manifest.sessions_path,
        "--approach",
        "all",
        "--session-artifacts",
        "--provider",
        "demo",
        "--out",
        join(root, "runs"),
      );
      expect(result.status, result.stderr).toBe(0);
      const comparison = JSON.parse(result.stdout);
      const artifacts = JSON.parse(
        await readFile(join(comparison.directory, "artifacts.json"), "utf8"),
      );
      expect(
        artifacts.artifacts.map((item: { kind: string }) => item.kind),
      ).toEqual(["diff", "test"]);
      expect(artifacts.artifacts[1].text).toContain("14 tests passed");
      expect(
        artifacts.artifacts.some((item: { text: string }) =>
          item.text.includes("cat README.md"),
        ),
      ).toBe(false);
      const corpus = JSON.parse(
        await readFile(join(comparison.directory, "corpus.json"), "utf8"),
      );
      expect(
        corpus.excluded_events.filter((item: { reason: string }) =>
          item.reason.includes("mirror"),
        ),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("explains usage and rejects invalid arguments with a nonzero status", () => {
    expect(run("--help").stdout).toContain("sessionlore ingest");
    expect(run("ingest").status).toBe(1);
    expect(run("ingest", "missing.jsonl").status).toBe(1);
    expect(run("--unknown").status).toBe(1);
  });

  it("runs ingestion and replay through the built workspace packages", async () => {
    const output = await mkdtemp(join(tmpdir(), "sessionlore-cli-"));
    try {
      const result = run(
        "ingest",
        resolve("fixtures/codex/v1/rollout-basic.jsonl"),
        "--out",
        output,
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.events).toBe(9);
      expect(await readFile(join(output, "timeline.md"), "utf8")).toContain(
        "Session timeline",
      );
      const replayed = run("replay", report.source_ids[0], "--out", output);
      expect(replayed.status).toBe(0);
      expect(JSON.parse(replayed.stdout).matched).toBe(true);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("runs all six approaches through the CLI and reports skipped experiments with nonzero status", async () => {
    const output = await mkdtemp(
      join(tmpdir(), "sessionlore-cli-experiments-"),
    );
    try {
      const result = run(
        "run",
        resolve("fixtures/experiments/v1/sessions"),
        "--approach",
        "all",
        "--provider",
        "demo",
        "--artifacts",
        resolve("fixtures/experiments/v1/artifacts.json"),
        "--out",
        output,
      );
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.results).toHaveLength(6);
      expect(
        report.results.every(
          (item: { status: string }) => item.status === "complete",
        ),
      ).toBe(true);
      expect(
        await readFile(join(report.directory, "comparison.md"), "utf8"),
      ).toContain("F. Artifact-anchored");
      const skipped = run(
        "run",
        resolve("fixtures/experiments/v1/sessions"),
        "--approach",
        "A,F",
        "--provider",
        "demo",
        "--out",
        output,
      );
      expect(skipped.status).toBe(1);
      expect(JSON.parse(skipped.stdout).results[1].status).toBe("skipped");
      expect(run("run", "anything", "--provider", "unknown").status).toBe(1);
      expect(run("run", "anything", "--approach", "unknown").status).toBe(1);
      expect(
        run("run", "anything", "--provider", "demo", "--max-calls", "NaN")
          .status,
      ).toBe(1);
      expect(
        run("run", "anything", "--provider", "demo", "--git", ".").status,
      ).toBe(1);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
