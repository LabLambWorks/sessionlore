import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Corpus, Evidence } from "../src/evidence.js";
import { runConversationNarrative } from "../src/long/conversation-narrative.js";
import { atomicJson, hash } from "../src/long/runtime.js";
import type { Model, ModelRequest } from "../src/model.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("writes a full narrative, checks targeted original results, retains both versions and reuses both completed calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-narrative-"));
  directories.push(root);
  const source = join(root, "source"),
    output = join(root, "output");
  const item = (id: string, actor: string, text: string): Evidence => ({
    id,
    actor,
    text,
    kind: "event",
    event_kind: actor === "tool" ? "result" : "message",
    thread_id: "thread",
    timestamp: "2026-01-01T00:00:00Z",
    is_human_turn: actor === "human",
    event_id: id,
    artifact_id: null,
    source: { artifact_sha256: "fixture" },
    text_start: 0,
    text_end: text.length,
  });
  const corpus: Corpus = {
    evidence: [
      item("s1", "human", "Make the build work."),
      item("s2", "assistant", "The build passed."),
      item(
        "s3",
        "tool",
        "Build failed: fixture result. <script>untrusted()</script>",
      ),
    ],
    lineage: [],
    excluded_events: [],
  };
  await atomicJson(join(source, "corpus.json"), corpus);
  await atomicJson(join(source, "manifest.json"), {
    corpus_sha256: hash(corpus),
    time_filter: null,
  });
  const requests: ModelRequest[] = [];
  const model: Model = {
    name: "fixture",
    model: "fixture",
    demo: false,
    async complete(request) {
      requests.push(request);
      const first = request.task === "write";
      const narrative = {
        title: "Build history",
        sections: [
          {
            heading: "Build",
            claims: [
              {
                text: first
                  ? "The assistant reported that the build passed."
                  : "The assistant reported a passing build, but the recorded build result failed.",
                refs: first ? ["s1", "s2"] : ["s2", "s3"],
                status: "observed",
              },
            ],
          },
        ],
      };
      return {
        value: first
          ? narrative
          : {
              narrative,
              issues: [
                {
                  explanation: "The result contradicts the report.",
                  refs: ["s3"],
                },
              ],
            },
        input_tokens: 50,
        output_tokens: 20,
      };
    },
  };
  const options = {
    sourceDirectory: source,
    output,
    model,
    tokenizer: {
      name: "fixture",
      count: (text: string) => Math.ceil(text.length / 4),
    },
  };
  const result = await runConversationNarrative(options);
  expect(result.status).toBe("complete");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0]?.data)).not.toContain("Build failed");
  expect(JSON.stringify(requests[1]?.data)).toContain("Build failed");
  expect(await readFile(join(output, "draft.md"), "utf8")).not.toContain(
    "recorded build result failed",
  );
  expect(await readFile(join(output, "narrative.md"), "utf8")).toContain(
    "recorded build result failed",
  );
  const html = await readFile(join(output, "narrative.html"), "utf8");
  expect(html).toContain('href="#s3"');
  expect(html).toContain('id="s1"');
  expect(await readFile(join(output, "sources.md"), "utf8")).toContain("## s1");
  expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
  await runConversationNarrative(options);
  expect(requests).toHaveLength(2);
});
