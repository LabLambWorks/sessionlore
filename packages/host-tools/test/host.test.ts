import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionHost } from "@sessionlore/contracts";
import { replay } from "@sessionlore/core";
import { describe, expect, it } from "vitest";
import {
  type Devlog,
  exportDevlog,
  loadRun,
  prepare,
  readEvidence,
  searchEvidence,
  validateDraft,
} from "../src/index.js";

const paths: Record<SessionHost, string> = {
  codex: "fixtures/codex/v1/rollout-basic.jsonl",
  claude: "fixtures/claude/v1/session.jsonl",
  opencode: "fixtures/opencode/v1/session.json",
};
describe("host-agent workflow", () => {
  it("keeps recorded clarification questions and answers in the conversation view", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-answers-"));
    try {
      const claude = join(root, "claude.jsonl");
      await writeFile(
        claude,
        [
          {
            type: "assistant",
            sessionId: "c",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "q1",
                  name: "AskUserQuestion",
                  input: { questions: [{ question: "Which tiles?" }] },
                },
              ],
            },
          },
          {
            type: "user",
            sessionId: "c",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "q1",
                  content: "Square tiles",
                },
              ],
            },
            toolUseResult: { answers: { "Which tiles?": "Square tiles" } },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      const cRun = join(root, "c-run");
      await prepare({ host: "claude", input: claude, output: cRun });
      const c = await readEvidence(cRun);
      expect(c.records.map((row) => row.actor)).toEqual(["assistant", "tool"]);
      expect(c.records[1]?.text).toContain("Square tiles");
      const opencode = join(root, "opencode.json");
      await writeFile(
        opencode,
        JSON.stringify({
          info: { id: "o" },
          messages: [
            {
              info: { id: "m", role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "question",
                  state: {
                    status: "completed",
                    input: { questions: [{ question: "Which tiles?" }] },
                    output: "Square tiles",
                  },
                },
              ],
            },
          ],
        }),
      );
      const oRun = join(root, "o-run");
      await prepare({ host: "opencode", input: opencode, output: oRun });
      expect(
        (await readEvidence(oRun)).records.map((row) => row.actor),
      ).toEqual(["assistant", "tool"]);
      const codex = join(root, "codex.jsonl");
      await writeFile(
        codex,
        [
          { type: "session_meta", payload: { id: "x" } },
          {
            type: "response_item",
            payload: {
              type: "function_call",
              name: "request_user_input",
              arguments: JSON.stringify({
                questions: [{ question: "Which tiles?" }],
              }),
            },
          },
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              output: JSON.stringify({
                answers: { tiles: { answers: ["Square tiles"] } },
              }),
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      const xRun = join(root, "x-run");
      await prepare({ host: "codex", input: codex, output: xRun });
      expect(
        (await readEvidence(xRun)).records.map((row) => row.actor),
      ).toEqual(["assistant", "tool"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(["codex", "claude", "opencode"] as const)(
    "imports, reads, validates and exports %s without a writing provider",
    async (host) => {
      const root = await mkdtemp(join(tmpdir(), "sessionlore-host-"));
      try {
        const run = join(root, "run");
        const manifest = await prepare({
          host,
          input: resolve(paths[host]),
          output: run,
        });
        expect(manifest.generation).toBe("host-agent");
        const page = await readEvidence(run, { limit: 1 });
        expect(page.next_cursor).toBe(1);
        const all = await readEvidence(run);
        expect(all.records.every((item) => item.primary)).toBe(true);
        expect(
          all.records.some((item) =>
            /Injected|Private reasoning/.test(item.text),
          ),
        ).toBe(false);
        const report = all.records.find((item) => item.actor === "assistant")!;
        const draft: Devlog = {
          title: "A recorded development session",
          narrator: manifest.narrator,
          sections: [
            {
              heading: "What I reported",
              paragraphs: [
                { text: `I reported: ${report.text}`, refs: [report.id] },
              ],
            },
          ],
        };
        const file = join(run, "reviewed.json");
        await writeFile(file, JSON.stringify(draft));
        expect((await validateDraft(run, file)).valid).toBe(true);
        const result = await exportDevlog(run, file, join(root, "output"));
        expect(await readFile(result.markdown, "utf8")).toContain(report.id);
        expect(await readFile(result.html, "utf8")).toContain(
          `id="${report.id}"`,
        );
        expect(
          (await replay(manifest.sources[0]!, join(run, "archive"), host))
            .matched,
        ).toBe(true);
        const search = await searchEvidence(run, "tests", { view: "all" });
        expect(search.results.some((item) => item.actor === "tool")).toBe(true);
        await expect(
          prepare({ host, input: resolve(paths[host]), output: run }),
        ).rejects.toThrow();
        await expect(
          exportDevlog(run, file, result.directory),
        ).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("rejects invented citations, changed narrators and tampered evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-invalid-"));
    try {
      const run = join(root, "run");
      const manifest = await prepare({
        host: "claude",
        input: resolve(paths.claude),
        output: run,
      });
      const file = join(run, "draft.json");
      await writeFile(
        file,
        JSON.stringify({
          title: "Invented",
          narrator: { ...manifest.narrator, name: "Codex" },
          sections: [
            {
              heading: "Claim",
              paragraphs: [{ text: "I deployed it.", refs: ["invented"] }],
            },
          ],
        }),
      );
      const result = await validateDraft(run, file);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      await expect(
        exportDevlog(run, file, join(root, "output")),
      ).rejects.toThrow();
      await expect(readEvidence(run, { refs: ["invented"] })).rejects.toThrow(
        "Unknown source",
      );
      await writeFile(join(run, "evidence.json"), "[]\n");
      await expect(loadRun(run)).rejects.toThrow("integrity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("paginates long records without losing Unicode and renders hostile source text inert", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-long-"));
    try {
      const input = join(root, "input.jsonl");
      const text =
        "a".repeat(5999) +
        "🚂保留" +
        "b".repeat(25000) +
        "<script>alert(1)</script>![x](https://bad.invalid/pixel)";
      await writeFile(
        input,
        JSON.stringify({
          type: "user",
          sessionId: "test",
          message: { content: text },
        }) + "\n",
      );
      const run = join(root, "run");
      const manifest = await prepare({ host: "claude", input, output: run });
      const first = await readEvidence(run);
      expect(first.next_cursor).not.toBeNull();
      const second = await readEvidence(run, { cursor: first.next_cursor! });
      const records = [...first.records, ...second.records];
      expect(records.map((item) => item.text).join("")).toBe(text);
      const last = records.at(-1)!;
      const draft = join(run, "draft.json");
      await writeFile(
        draft,
        JSON.stringify({
          title: "<script>bad</script>",
          narrator: manifest.narrator,
          sections: [
            {
              heading: "Source",
              paragraphs: [
                {
                  text: '<img src="https://bad.invalid/pixel">',
                  refs: [last.id],
                },
              ],
            },
          ],
        }),
      );
      const exported = await exportDevlog(run, draft, join(root, "output"));
      const rendered = await readFile(exported.html, "utf8");
      expect(rendered).not.toContain("<script>");
      expect(rendered).not.toContain("<img ");
      expect(rendered).toContain("&lt;script&gt;");
      expect(
        await readFile(join(exported.directory, "sources.md"), "utf8"),
      ).not.toContain("![x]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("standalone plugin package", () => {
  it("runs after relocation with no workspace dependencies or model credentials", async () => {
    const build = spawnSync(
      process.execPath,
      [resolve("scripts/build-plugin.mjs")],
      { encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    const root = await mkdtemp(join(tmpdir(), "sessionlore-relocated-"));
    try {
      const plugin = join(root, "plugin with spaces");
      await cp(resolve("dist/plugins/sessionlore"), plugin, {
        recursive: true,
      });
      const cli = join(plugin, "skills/devlog/scripts/sessionlore-host.mjs");
      const invoke = (...args: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {
          cwd: root,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
        });
      expect(invoke("--help").status).toBe(0);
      const run = join(root, "run");
      const prepared = invoke(
        "prepare",
        "--host",
        "opencode",
        "--input",
        resolve(paths.opencode),
        "--out",
        run,
      );
      expect(prepared.status, prepared.stderr).toBe(0);
      const page = invoke("read", "--run", run);
      expect(page.status, page.stderr).toBe(0);
      expect(JSON.parse(page.stdout).records.length).toBeGreaterThan(0);
      expect(invoke("read", "--run", run, "--view", "bogus").status).toBe(1);
      expect(invoke("validate", "--run", run).status).toBe(1);
      const inputs = JSON.parse(
        await readFile(join(plugin, "build-manifest.json"), "utf8"),
      ).inputs as string[];
      expect(
        inputs.some(
          (path) => path.includes("experiments") || path.includes("model.ts"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
