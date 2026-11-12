// Local-only conversation capture. No provider client or .env access.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ADAPTER_VERSION,
  normalizeCapturedRollout,
} from "../packages/adapter-codex/dist/index.js";
import { listProjects, selectProject } from "../packages/core/dist/projects.js";
import { conversationView } from "../packages/experiments/dist/conversation.js";
import { corpusFromBatches } from "../packages/experiments/dist/evidence.js";
import { recordRole } from "../packages/experiments/dist/long/request-result.js";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";

const { values } = parseArgs({
  options: {
    project: { type: "string", default: "peekawild" },
    out: {
      type: "string",
      default: ".sessionlore/peekawild-request-inventory-v1",
    },
  },
});
const out = resolve(values.out);
if (await readJson(join(out, "capture.json"))) {
  console.log("Frozen conversation already exists; no recapture.");
} else {
  const project = selectProject(
    (await listProjects()).projects,
    values.project,
  );
  const batches = [],
    sources = [];
  const roles = new Set([
    "user_request",
    "user_answer",
    "question",
    "assistant_report",
  ]);
  let malformed = 0,
    unsupported = 0;
  for (const [i, rollout] of project.rollouts.entries()) {
    const before = await stat(rollout.path);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(rollout.path))
      digest.update(chunk);
    const sha = digest.digest("hex");
    const cache = resolve(
      ".sessionlore/inventory-source-cache",
      `${ADAPTER_VERSION}-${sha}.json`,
    );
    let batch = await readJson(cache);
    if (!batch) {
      batch = await normalizeCapturedRollout(rollout.path, {
        sourceId: sha,
        sourcePath: rollout.path,
        rawSize: before.size,
        mtime: before.mtime.toISOString(),
        ingestedAt: new Date().toISOString(),
        compression: rollout.path.endsWith(".zst") ? "zstd" : "none",
      });
      const counts = {
        malformed: batch.events.filter(
          (e) => e.parse_status === "malformed_record",
        ).length,
        unsupported: batch.events.filter(
          (e) => e.parse_status === "unsupported_record",
        ).length,
      };
      batch = {
        ...batch,
        inventory_parse_counts: counts,
        events: batch.events.filter(
          (e) => e.text && roles.has(recordRole(e, e.text)),
        ),
      };
      await atomicJson(cache, batch);
    }
    const after = await stat(rollout.path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(
        "Source changed during capture; retry local capture before generating.",
      );
    if (
      batch.source.source_id !== sha ||
      batch.source.adapter_version !== ADAPTER_VERSION
    )
      throw new Error("Source cache identity mismatch");
    malformed += batch.inventory_parse_counts.malformed;
    unsupported += batch.inventory_parse_counts.unsupported;
    batches.push(batch);
    sources.push({ ...batch.source, discovered_path: rollout.path });
    if ((i + 1) % 20 === 0 || i + 1 === project.rollouts.length)
      console.error(
        `Captured ${i + 1}/${project.rollouts.length} conversation sources locally`,
      );
  }
  if (malformed)
    throw new Error(
      `${malformed} malformed records need inspection before a complete inventory can be claimed`,
    );
  const view = conversationView(corpusFromBatches(batches, [], 6000));
  await atomicJson(join(out, "primary-corpus.json"), view.corpus);
  await atomicJson(join(out, "conversation.json"), view.compact);
  const manifest = {
    version: "request-inventory-capture-v1",
    captured_at: new Date().toISOString(),
    project: project.path,
    chat_ids: project.threads,
    source_files: sources.length,
    sources,
    malformed_records: malformed,
    unsupported_records: unsupported,
    primary_corpus_sha256: hash(view.corpus),
    conversation_sha256: hash(view.compact),
    conversation_records: view.stats.primary_records,
    time_filter: null,
    source_text_truncated: false,
    policy:
      "Freeze complete conversation text with source-file hashes and line/byte locators. Raw source files remain at their original paths; bulk execution and media are not sent to the extraction model.",
  };
  await atomicJson(join(out, "capture.json"), manifest);
  console.log(
    JSON.stringify({
      records: manifest.conversation_records,
      chats: project.threads,
      source_files: sources.length,
      api_calls: 0,
    }),
  );
}
