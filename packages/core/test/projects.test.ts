import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { listProjects, selectProject } from "../src/projects.js";

describe("project selection", () => {
  it("groups resume files, subdirectories, and Git worktrees by project while keeping distinct thread identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessionlore-projects-"));
    try {
      const project = join(root, "game");
      const worktree = join(root, "worktree");
      const sessions = join(root, "sessions");
      await mkdir(project);
      await mkdir(sessions);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", project, ...args], {
          encoding: "utf8",
          stdio: "pipe",
        });
      git("init", "-q");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Test");
      await writeFile(join(project, "file"), "fixture");
      git("add", ".");
      git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture");
      git(
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "-qb",
        "fixture-branch",
        worktree,
      );
      await mkdir(join(project, "nested"));
      const records = [
        { id: "main", cwd: project },
        { id: "main", cwd: project },
        { id: "child", cwd: worktree },
        { id: "nested", cwd: join(project, "nested") },
        { id: "other", cwd: join(root, "different") },
      ];
      for (const [i, payload] of records.entries()) {
        const data = Buffer.from(
          `${JSON.stringify({ type: "session_meta", payload })}\n${JSON.stringify({ type: "private_body", payload: "not needed for project discovery" })}\n`,
        );
        await writeFile(
          join(sessions, `${i}.jsonl${i === 1 ? ".zst" : ""}`),
          i === 1 ? zstdCompressSync(data) : data,
        );
      }
      const catalog = await listProjects(sessions);
      expect(catalog.warnings).toEqual([]);
      expect(catalog.projects).toHaveLength(2);
      const selected = selectProject(catalog.projects, "game");
      expect(selected.threads).toBe(3);
      expect(selected.rollouts).toHaveLength(4);
      expect(selectProject(catalog.projects, project).id).toBe(selected.id);
      expect(() => selectProject(catalog.projects, "missing")).toThrow(
        "No sessions",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
