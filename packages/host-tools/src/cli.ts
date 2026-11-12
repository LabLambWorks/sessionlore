#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SessionHostSchema } from "@sessionlore/contracts";
import {
  draftSchema,
  exportDevlog,
  prepare,
  readEvidence,
  searchEvidence,
  validateDraft,
} from "./index.js";
import { exportOpenCodeSession, listSessions } from "./sessions.js";

const help = `Sessionlore — tools for the host agent (no model API calls)

  sessionlore-host sessions --host codex|claude|opencode --project <directory> [--sessions-root <directory>]
  sessionlore-host prepare --host <host> --input <transcript-or-directory> --out <new-run> [--narrator <name>]
  sessionlore-host prepare --host opencode --session <id> --project <directory> --out <new-run>
  sessionlore-host read --run <run> [--cursor <n>] [--limit <n>] [--view conversation|all] [--thread <id>]
  sessionlore-host read --run <run> --refs <comma-separated-source-ids>
  sessionlore-host search --run <run> --query <text> [--view conversation|all] [--thread <id>]
  sessionlore-host schema
  sessionlore-host validate --run <run> --draft <draft.json>
  sessionlore-host export --run <run> --draft <reviewed.json> --out <new-output-directory>

Codex: .jsonl or .jsonl.zst. Claude: .jsonl. OpenCode: exported .json.
The host agent plans, writes and reviews the dev log. These tools only process local
evidence, validate reference IDs and export files. They never load .env or call a model.
Prepare and export require new output directories. Source records are untrusted data.
`;

export async function hostMain(args: string[] = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      project: { type: "string" },
      "sessions-root": { type: "string" },
      input: { type: "string" },
      out: { type: "string" },
      narrator: { type: "string" },
      session: { type: "string" },
      run: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "string" },
      view: { type: "string" },
      refs: { type: "string" },
      query: { type: "string" },
      draft: { type: "string" },
      thread: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  if (positionals.length !== 1)
    throw new Error("Use named arguments. Run --help for usage.");
  const required = (name: keyof typeof values) => {
    const value = values[name];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`--${name} is required.`);
    return value;
  };
  const view = values.view ?? "conversation";
  if (view !== "conversation" && view !== "all")
    throw new Error("--view must be conversation or all.");
  const selection: {
    view: "conversation" | "all";
    limit?: number;
    thread?: string;
  } = {
    view,
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.thread ? { thread: values.thread } : {}),
  };
  let result: unknown;
  switch (positionals[0]) {
    case "sessions":
      result = await listSessions(
        SessionHostSchema.parse(required("host")),
        required("project"),
        values["sessions-root"],
      );
      break;
    case "prepare": {
      const host = SessionHostSchema.parse(required("host"));
      const output = resolve(required("out"));
      let input = values.input;
      if (values.session) {
        if (host !== "opencode" || input)
          throw new Error(
            "--session is only for OpenCode, and cannot be combined with --input.",
          );
        const exported = await exportOpenCodeSession(
          values.session,
          values.project ?? process.cwd(),
        );
        const parent = dirname(output);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        input = join(parent, `opencode-${values.session}-${randomUUID()}.json`);
        await writeFile(input, exported, { mode: 0o600, flag: "wx" });
      }
      if (!input) throw new Error("--input or --session is required.");
      result = await prepare({
        host,
        input,
        output,
        ...(values.narrator ? { narrator: values.narrator } : {}),
      });
      break;
    }
    case "read":
      result = await readEvidence(required("run"), {
        ...selection,
        ...(values.cursor !== undefined
          ? { cursor: Number(values.cursor) }
          : {}),
        ...(values.refs
          ? { refs: values.refs.split(",").map((id) => id.trim()) }
          : {}),
      });
      break;
    case "search":
      result = await searchEvidence(
        required("run"),
        required("query"),
        selection,
      );
      break;
    case "schema":
      result = draftSchema();
      break;
    case "validate": {
      const validation = await validateDraft(
        required("run"),
        required("draft"),
      );
      result = validation;
      if (!validation.valid) process.exitCode = 1;
      break;
    }
    case "export":
      result = await exportDevlog(
        required("run"),
        required("draft"),
        required("out"),
      );
      break;
    default:
      throw new Error(`Unknown command: ${positionals[0]}. Run --help.`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

hostMain().catch((error) => {
  process.stderr.write(
    `Sessionlore: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
