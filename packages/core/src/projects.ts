import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createZstdDecompress } from "node:zlib";
import { discoverRollouts } from "@sessionlore/adapter-codex";

const execute = promisify(execFile);
export type ProjectSession = {
  thread_id: string;
  path: string;
  cwd: string;
  bytes: number;
  timestamp: string | null;
};
export type Project = {
  id: string;
  name: string;
  path: string;
  threads: number;
  total_bytes: number;
  rollouts: ProjectSession[];
};

async function sessionHeader(path: string): Promise<ProjectSession | null> {
  const raw = createReadStream(path, { highWaterMark: 4096 });
  const stream = path.endsWith(".zst") ? raw.pipe(createZstdDecompress()) : raw;
  raw.on("error", (error) => stream.destroy(error));
  let header = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      header = Buffer.concat([header, chunk as Buffer]);
      const newline = header.indexOf(10);
      if (newline < 0 && header.length <= 1024 * 1024) continue;
      if (newline < 0) throw new Error("Metadata header exceeds 1 MiB");
      const record = JSON.parse(
        header.subarray(0, newline).toString("utf8"),
      ) as {
        type?: string;
        timestamp?: string;
        payload?: { id?: string; cwd?: string };
      };
      if (
        record.type !== "session_meta" ||
        !record.payload?.id ||
        !record.payload.cwd
      )
        return null;
      return {
        thread_id: record.payload.id,
        cwd: resolve(record.payload.cwd),
        path,
        bytes: (await stat(path)).size,
        timestamp: record.timestamp ?? null,
      };
    }
    return null;
  } finally {
    raw.destroy();
    stream.destroy();
  }
}

/** Discover project membership from session metadata; never inspect conversation bodies. */
export async function listProjects(
  sessionsRoot?: string,
): Promise<{ projects: Project[]; warnings: string[] }> {
  const roots = sessionsRoot
    ? [resolve(sessionsRoot)]
    : [
        join(homedir(), ".codex", "sessions"),
        join(homedir(), ".codex", "archived_sessions"),
      ];
  const paths: string[] = [];
  for (const root of roots) {
    try {
      paths.push(...(await discoverRollouts(root)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const warnings: string[] = [];
  const groups = new Map<string, ProjectSession[]>();
  const projectRoots = new Map<string, string>();
  for (const path of paths) {
    try {
      const header = await sessionHeader(path);
      if (!header) {
        warnings.push(`No project metadata in ${path}`);
        continue;
      }
      let root = projectRoots.get(header.cwd);
      if (!root) {
        root = header.cwd;
        try {
          const { stdout } = await execute(
            "git",
            [
              "-C",
              header.cwd,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ],
            { timeout: 3000, maxBuffer: 65536 },
          );
          const common = stdout.trim();
          if (basename(common) === ".git") root = dirname(common);
        } catch {
          /* Deleted and non-Git project directories retain their recorded cwd. */
        }
        projectRoots.set(header.cwd, root);
      }
      groups.set(root, [...(groups.get(root) ?? []), header]);
    } catch (error) {
      warnings.push(
        `Could not read metadata from ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  return {
    projects: [...groups]
      .map(([path, rollouts]) => ({
        id: createHash("sha256").update(path).digest("hex").slice(0, 16),
        name: basename(path),
        path,
        threads: new Set(rollouts.map((item) => item.thread_id)).size,
        total_bytes: rollouts.reduce((n, item) => n + item.bytes, 0),
        rollouts,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

export function selectProject(projects: Project[], selector: string): Project {
  let selectorPath = resolve(selector);
  try {
    selectorPath = realpathSync(selectorPath);
  } catch {
    /* Names and deleted paths need not exist. */
  }
  const matches = projects.filter(
    (project) =>
      project.id === selector ||
      project.name === selector ||
      project.path === selectorPath ||
      project.rollouts.some((item) => item.cwd === resolve(selector)),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Project name is ambiguous; use its full path or ID from projects."
        : `No sessions found for project ${selector}. Run projects to list available projects.`,
    );
  return matches[0]!;
}
