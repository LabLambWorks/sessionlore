import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { IngestBatch } from "@sessionlore/contracts";
import type { Context } from "./context.js";
import { blocks, project, SearchIndex, unique } from "./evidence.js";
import {
  type Artifact,
  ArtifactFileSchema,
  type Material,
  SummarySchema,
} from "./schema.js";
import { type Prepared, prepareMaterials } from "./shared.js";

const execute = promisify(execFile);
export async function readArtifacts(path: string): Promise<Artifact[]> {
  return ArtifactFileSchema.parse(JSON.parse(await readFile(path, "utf8")))
    .artifacts;
}

/** Extract recorded artifacts from structured Codex completion events, never from prose claims. */
export function sessionArtifacts(batches: IngestBatch[]): Artifact[] {
  const artifacts = new Map<string, Artifact>();
  for (const batch of batches)
    for (const event of batch.events) {
      if (!event.text) continue;
      const isPatch =
        event.original_type === "event_msg.item_completed.FileChange";
      const isCommand =
        event.original_type === "event_msg.item_completed.CommandExecution";
      if (!isPatch && !isCommand) continue;
      const data = JSON.parse(event.text) as {
        command?: unknown;
        changes?: Record<string, unknown>;
        status?: string;
        exit_code?: number;
      };
      const command = Array.isArray(data.command)
        ? data.command
            .filter((part): part is string => typeof part === "string")
            .join(" ")
        : typeof data.command === "string"
          ? data.command
          : "";
      const validation =
        /(?:^|\s|&&|;)\s*(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint)\b|(?:pytest|vitest)\b|(?:cargo|go)\s+test\b)/.test(
          command,
        );
      if (!isPatch && !validation) continue;
      artifacts.set(event.event_id, {
        id: `session:${event.event_id}`,
        kind: isPatch ? "diff" : "test",
        title: isPatch
          ? `Recorded file change (${data.status ?? "unknown status"})`
          : `Recorded validation command (exit code ${data.exit_code ?? "unknown"})`,
        text: `Captured tool observation, not a claim about the current repository state. Source event: ${event.event_id}.\n${event.text}`,
        timestamp: event.timestamp,
        uri: `sessionlore:${event.payload_ref.source_id}#line=${event.payload_ref.line_number}`,
        paths: isPatch ? Object.keys(data.changes ?? {}) : [],
      });
    }
  return [...artifacts.values()];
}

/** Read only a user-selected commit range. Never run hooks, external diffs, or source commands. */
export async function gitArtifacts(
  repository: string,
  range: string,
): Promise<Artifact[]> {
  const parts = range.split("..");
  if (parts.length !== 2 || parts.some((part) => !part || part.startsWith(".")))
    throw new Error(
      "--git-range must be an explicit base..head range (not three-dot syntax).",
    );
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-C", repository, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      })
    ).stdout.trimEnd();
  const base = await git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${parts[0]}^{commit}`,
  );
  const head = await git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${parts[1]}^{commit}`,
  );
  if (!/^[a-f0-9]{40,64}$/.test(base) || !/^[a-f0-9]{40,64}$/.test(head))
    throw new Error("Could not resolve Git range to commits.");
  const commits = (await git("rev-list", "--reverse", `${base}..${head}`, "--"))
    .split("\n")
    .filter(Boolean);
  if (commits.length > 100)
    throw new Error(
      "Git range exceeds 100 commits. Select a smaller range; nothing was truncated.",
    );
  const artifacts: Artifact[] = [];
  for (const commit of commits) {
    const title = await git("show", "-s", "--format=%s", commit, "--");
    const timestamp = await git("show", "-s", "--format=%cI", commit, "--");
    const paths = (
      await git(
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        commit,
        "--",
      )
    )
      .split("\0")
      .filter(Boolean);
    const text = await git(
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--format=fuller",
      "--stat",
      "--patch",
      commit,
      "--",
    );
    artifacts.push({
      id: `git:${commit}`,
      kind: "commit",
      title,
      timestamp,
      paths,
      text,
      uri: null,
    });
  }
  return artifacts;
}

export async function artifact(ctx: Context): Promise<Prepared> {
  const anchors = ctx.corpus.evidence.filter(
    (item) => item.kind === "artifact",
  );
  if (!anchors.length)
    throw new Error(
      "Artifact approach needs --artifacts <json> or --git <repository> --git-range <base>..<head>.",
    );
  const conversations = ctx.corpus.evidence.filter(
    (item) => item.kind === "event",
  );
  const index = new SearchIndex(conversations, (item) => item.text);
  const materials: Material[] = [];
  const matches: unknown[] = [];
  const used = new Set<string>();
  for (const artifactId of unique(anchors.map((item) => item.artifact_id))) {
    const sources = anchors.filter((item) => item.artifact_id === artifactId);
    // Full artifact text is indexed for terms. No claims are derived just from a title.
    const hits = index.search(
      sources.map((item) => item.text).join("\n"),
      ctx.options.retrieval_k,
    );
    const related = hits.map((hit) => hit.item);
    related.forEach((item) => used.add(item.id));
    matches.push({
      artifact_id: artifactId,
      artifact_refs: sources.map((item) => item.id),
      conversation: hits.map((hit) => ({ id: hit.item.id, score: hit.score })),
      relationship: "retrieval candidate, not proven provenance",
    });
    for (const [i, part] of blocks(
      [...sources, ...related],
      ctx.options.block_chars,
    ).entries()) {
      const result = await ctx.ask(
        "reconstruct",
        `artifact/${materials.length + 1}`,
        SummarySchema,
        { artifact_id: artifactId, evidence: project(part) },
        "Reconstruct this artifact's engineering contribution. Start from what the artifact proves, then use conversation for goals, decisions, and rationale. A commit or PR does not prove deployment, test success, or authorship of nearby conversation. Retrieval matches are candidates, not causal links. Keep evidence types and reported vs demonstrated outcomes clear. Return a concise summary and at most eight facts.",
      );
      materials.push({
        id: `artifact-${artifactId}-${i}`,
        ...result,
        refs: part.map((item) => item.id),
      });
    }
  }
  await ctx.save("artifact-matches", matches);
  await ctx.save(
    "unmatched-conversation",
    conversations.filter((item) => !used.has(item.id)).map((item) => item.id),
  );
  await ctx.save("artifact-reconstructions", materials);
  ctx.warnings.push(
    `${conversations.length - used.size} conversation fragments were not retrieved from artifacts. Review these for investigations and abandoned work.`,
  );
  return prepareMaterials(ctx, materials, "artifact");
}
