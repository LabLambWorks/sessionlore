import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionHost } from "@sessionlore/contracts";
import { discoverSessions, listProjects } from "@sessionlore/core";

const execute = promisify(execFile);
export type SessionListing = {
  host: SessionHost;
  project: string;
  warnings: string[];
  sessions?: {
    thread_id: string;
    path?: string;
    cwd: string;
    timestamp: string | number | null;
    title?: string;
  }[];
  exports?: string[];
};
export async function listSessions(
  host: SessionHost,
  project: string,
  sessionsRoot?: string,
): Promise<SessionListing> {
  const directory = resolve(project);
  if (host === "codex") {
    const result = await listProjects(sessionsRoot);
    return {
      host,
      project: directory,
      sessions: result.projects
        .filter(
          (item) =>
            item.path === directory ||
            item.rollouts.some((session) => session.cwd === directory),
        )
        .flatMap((item) => item.rollouts),
      warnings: result.warnings,
    };
  }
  if (host === "opencode") {
    if (sessionsRoot)
      return {
        host,
        project: directory,
        exports: await discoverSessions(sessionsRoot, host),
        warnings: [
          "Export directories have no automatic project filter; select the relevant exports.",
        ],
      };
    const { stdout } = await execute(
      "opencode",
      ["session", "list", "--format", "json"],
      { cwd: directory, maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
    );
    const sessions: unknown = JSON.parse(stdout);
    if (!Array.isArray(sessions))
      throw new Error(
        "Unsupported OpenCode session list; supply an explicit opencode export JSON file.",
      );
    return {
      host,
      project: directory,
      sessions: sessions
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof item.directory === "string" &&
            resolve(item.directory) === directory,
        )
        .map((item) => ({
          thread_id: item.id,
          title: item.title,
          cwd: item.directory,
          timestamp: item.time?.updated ?? null,
        })),
      warnings: [
        "Listing scope depends on the installed OpenCode version. An explicit exported session JSON is also supported.",
      ],
    };
  }
  const root = sessionsRoot ?? join(homedir(), ".claude", "projects");
  let paths: string[];
  try {
    paths = await discoverSessions(root, host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      host,
      project: directory,
      sessions: [],
      warnings: [`No Claude transcript directory at ${root}.`],
    };
  }
  const sessions: {
    thread_id: string;
    path: string;
    cwd: string;
    timestamp: string | null;
  }[] = [];
  const warnings: string[] = [];
  for (const path of paths) {
    // Read a bounded prefix only; session discovery does not load whole conversations.
    const stream = createReadStream(path, { end: 1024 * 1024 - 1 });
    let prefix = "";
    try {
      for await (const chunk of stream) {
        prefix += (chunk as Buffer).toString("utf8");
        let end: number;
        while ((end = prefix.indexOf("\n")) >= 0) {
          const line = prefix.slice(0, end);
          prefix = prefix.slice(end + 1);
          let row: Record<string, unknown>;
          try {
            row = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            typeof row.cwd === "string" &&
            typeof row.sessionId === "string"
          ) {
            if (resolve(row.cwd) === directory)
              sessions.push({
                thread_id:
                  row.sessionId +
                  (row.isSidechain === true
                    ? `/${basename(path, ".jsonl")}`
                    : ""),
                path,
                cwd: resolve(row.cwd),
                timestamp:
                  typeof row.timestamp === "string" ? row.timestamp : null,
              });
            stream.destroy();
            break;
          }
        }
        if (stream.destroyed) break;
      }
    } catch (error) {
      warnings.push(
        `Could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      stream.destroy();
    }
  }
  return { host, project: directory, sessions, warnings };
}

/** This invokes only OpenCode's read-only exporter, never its model or prompt commands. */
export async function exportOpenCodeSession(
  sessionId: string,
  project: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
    throw new Error("Invalid OpenCode session ID.");
  const { stdout } = await execute("opencode", ["export", sessionId], {
    cwd: resolve(project),
    timeout: 30000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const document: unknown = JSON.parse(stdout);
  if (
    !document ||
    typeof document !== "object" ||
    !Array.isArray((document as { messages?: unknown }).messages)
  )
    throw new Error(
      "Unsupported OpenCode export; supply an explicit export file.",
    );
  return stdout;
}
