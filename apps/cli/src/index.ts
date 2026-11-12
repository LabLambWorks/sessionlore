#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import {
  captureCase,
  captureFiles,
  ingest,
  listProjects,
  replay,
  selectProject,
} from "@sessionlore/core";
import {
  APPROACHES,
  type Approach,
  DemoModel,
  gitArtifacts,
  HttpModel,
  LONG_APPROACHES,
  type LongApproach,
  prepareConversationCapture,
  readArtifacts,
  runEvidenceDiagnostic,
  runExperiment,
  runLongComparison,
  runRetrievalComparison,
} from "@sessionlore/experiments";

const help = `Sessionlore — local coding-session evidence

For dev logs written by your host model, use the Sessionlore plugin or pnpm host.
The run/compare commands below are optional API-backed experiments.

Usage:
  sessionlore ingest <file-or-directory> [--out <directory>]
  sessionlore replay <source-sha256> [--out <directory>]
  sessionlore capture <file-or-directory> --out <new-case-directory>
  sessionlore projects [--sessions-root <directory>]
  sessionlore capture --project <name-or-path> --out <new-case-directory>
  sessionlore run --project <name-or-path> --approach <name|all> [options]
  sessionlore run <file-or-directory> --approach <name|all> [options]
  sessionlore compare <file-or-directory> --provider kimi-code --out <directory> [options]
  sessionlore compare --project <name-or-path> --provider kimi-code --out <directory> [options]
  sessionlore diagnose <full-history-output> --cases <benchmark.json> --out <directory>
  sessionlore compare-retrieval <full-history-output> --cases <benchmark.json> --out <directory>
  sessionlore prepare-conversation <full-history-output> --out <directory>
  sessionlore --help

Inputs: Codex .jsonl and .jsonl.zst files. Directories are scanned recursively.
Output defaults to .sessionlore in the current directory.
Ingest/replay are local. API-backed runs send selected evidence to your endpoint.
Raw snapshots, prompts, and narratives can contain private data.

Approaches: direct (A), hierarchical (B), pivot (C), workstream (D),
            retrieval (E), artifact (F), all. Comma-separated names also work.

Run options:
  --project <name-or-path>           Select a project; collect its sessions and resume files.
  --sessions-root <directory>        Override local Codex session discovery root.
  --since <ISO-timestamp>            Optional project time window, inclusive.
  --until <ISO-timestamp>            Optional project time window, exclusive.
  --provider demo|openai-compatible|deepseek|kimi-code  Default: kimi-code.
  --model <model-id>                 Or SESSIONLORE_MODEL. Required for API runs.
  --base-url <url>                   Or SESSIONLORE_BASE_URL; default https://api.openai.com/v1
  --api-key-env <name>               Default: OPENAI_API_KEY. Key is never saved.
  --json-mode schema|object          Default: schema; object for JSON-only servers.
  --max-output-tokens <n>            Per call, including reasoning. Kimi: 16384; others: 8192.
  --timeout-ms <n>                   Per HTTP attempt. Default: 120000.
  --artifacts <json-file>            Exported commits/diffs/PRs/issues/test results.
  --session-artifacts                Use recorded FileChange and validation-command events.
  --evidence-view conversation|execution  Default: conversation. Execution includes raw trace text.
  --git <repository>                Read commits and diffs from an explicit range.
  --git-range <base>..<head>         Required with --git; at most 100 commits.
  --block-chars <n>                  Default: 10000; split at turns when possible.
  --context-chars <n>                Max serialized prompt characters; default: 120000.
  --words <n>                        Target narrative words; default: 700.
  --max-calls <n>                    Per-approach call limit; default: 250.
  --retrieval-k <n>                  Hits per query; default: 6.
  --retrieval-rounds <n>             Outline refinement rounds; default: 2.
  --pivot-threshold <0..1>           Narrative relevance threshold; default: 0.6.

Each run creates a new directory with comparison.md, sources.md, and one directory
per approach. A skipped or failed method has a reason in its result.json.

Full-history compare options (time filters are rejected):
  --approach all|hierarchy|hybrid|hierarchy-retrieval|recursive (comma-separated)
  --tokenizer <directory>           Official DeepSeek tokenizer files.
  --chunk-tokens <n>                Default: 16000. Complete source coverage.
  --input-tokens <n>                Per-call input budget; default: 60000.
  --concurrency <n>                 Default: 8. Maximum: 32.
  --prepare-only                   Capture and tokenize without API calls.
  --cases <file>                    Diagnostic questions, source refs, and evaluation rubric.
  --providers <list>                Diagnostic default: deepseek,kimi-code.
  --words <n>                       Compare default: 1800.
  --max-calls <n>                   Compare default: 3000 per approach.
Repeat the same compare command and --out to resume. Changed model/input settings
require a new directory. Outputs include an interactive comparison.html.
`;

async function main(): Promise<void> {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string", default: ".sessionlore" },
      help: { type: "boolean", short: "h" },
      approach: { type: "string", default: "all" },
      project: { type: "string" },
      "sessions-root": { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      provider: { type: "string", default: "kimi-code" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string", default: "OPENAI_API_KEY" },
      "json-mode": { type: "string", default: "schema" },
      "max-output-tokens": { type: "string", default: "8192" },
      "timeout-ms": { type: "string", default: "120000" },
      artifacts: { type: "string" },
      "session-artifacts": { type: "boolean", default: false },
      "evidence-view": { type: "string", default: "conversation" },
      git: { type: "string" },
      "git-range": { type: "string" },
      "block-chars": { type: "string", default: "10000" },
      "context-chars": { type: "string", default: "120000" },
      words: { type: "string", default: "700" },
      "max-calls": { type: "string", default: "250" },
      "retrieval-k": { type: "string", default: "6" },
      "retrieval-rounds": { type: "string", default: "2" },
      "pivot-threshold": { type: "string", default: "0.6" },
      tokenizer: { type: "string" },
      "chunk-tokens": { type: "string", default: "16000" },
      "input-tokens": { type: "string", default: "60000" },
      concurrency: { type: "string", default: "8" },
      "prepare-only": { type: "boolean", default: false },
      cases: { type: "string" },
      providers: { type: "string", default: "deepseek,kimi-code" },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
    return;
  }
  const [command, input] = positionals;
  if (
    values["evidence-view"] !== "conversation" &&
    values["evidence-view"] !== "execution"
  )
    throw new Error("--evidence-view must be conversation or execution.");
  if (command === "prepare-conversation") {
    if (
      !input ||
      positionals.length !== 2 ||
      values.since ||
      values.until ||
      values.project
    )
      throw new Error(
        "Use prepare-conversation <full-history-output> --out <directory>; the full captured project is used.",
      );
    process.stdout.write(
      JSON.stringify(
        await prepareConversationCapture({
          sourceDirectory: input,
          output: values.out!,
        }),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const explicit = (name: string) =>
    process.argv.some(
      (arg) => arg === `--${name}` || arg.startsWith(`--${name}=`),
    );
  const makeProvider = (provider: string, useOverrides = true) => {
    if (provider !== "deepseek" && provider !== "kimi-code")
      throw new Error("Use provider deepseek or kimi-code.");
    const kimi = provider === "kimi-code";
    const keyName =
      useOverrides && explicit("api-key-env")
        ? values["api-key-env"]!
        : kimi
          ? "KIMI_CODE_API_KEY"
          : "DEEPSEEK_API_KEY";
    const apiKey = process.env[keyName];
    if (!apiKey && !values["prepare-only"])
      throw new Error(`Set ${keyName} in .env.`);
    return new HttpModel({
      model:
        (useOverrides ? values.model : undefined) ??
        (kimi ? "k3.1-pro" : "deepseek-flash"),
      baseUrl:
        (useOverrides ? values["base-url"] : undefined) ??
        (kimi ? "https://api.kimi.com/coding/v1" : "https://api.deepseek.com"),
      ...(apiKey ? { apiKey } : {}),
      apiStyle: provider,
      jsonMode: "object",
      maxOutputTokens: explicit("max-output-tokens")
        ? Number(values["max-output-tokens"])
        : kimi
          ? 16384
          : 8192,
      timeoutMs: explicit("timeout-ms") ? Number(values["timeout-ms"]) : 180000,
    });
  };
  if (command === "compare-retrieval") {
    if (
      !input ||
      !values.cases ||
      positionals.length !== 2 ||
      values.since ||
      values.until ||
      values.project
    )
      throw new Error(
        "Use compare-retrieval <full-history-output> --cases <benchmark.json>; no time filters.",
      );
    if (values.provider !== "kimi-code" || explicit("providers"))
      throw new Error(
        "compare-retrieval uses Kimi Code only; do not pass --providers.",
      );
    const result = await runRetrievalComparison({
      sourceDirectory: input,
      benchmarkPath: values.cases,
      output: values.out!,
      model: makeProvider("kimi-code"),
      concurrency: explicit("concurrency") ? Number(values.concurrency) : 2,
      prepareOnly: values["prepare-only"],
      progress: (message) => process.stderr.write(message + "\n"),
    });
    process.stdout.write(
      JSON.stringify(
        {
          directory: result.directory,
          prepared: result.prepared,
          rows: result.rows.map(({ answer, audit, ...row }) => ({
            ...row,
            answer_saved: Boolean(answer),
            audit_saved: Boolean(audit),
          })),
        },
        null,
        2,
      ) + "\n",
    );
    if (result.rows.some((row) => row.status !== "complete"))
      process.exitCode = 1;
    return;
  }
  if (command === "diagnose") {
    if (
      !input ||
      !values.cases ||
      positionals.length !== 2 ||
      values.since ||
      values.until ||
      values.project
    )
      throw new Error(
        "Use diagnose <full-history-output> --cases <benchmark.json>; no time filters.",
      );
    const models = values
      .providers!.split(",")
      .map((id) => ({ id: id.trim(), model: makeProvider(id.trim(), false) }));
    const result = await runEvidenceDiagnostic({
      sourceDirectory: input,
      benchmarkPath: values.cases,
      output: values.out!,
      models,
      concurrency: explicit("concurrency") ? Number(values.concurrency) : 2,
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(
      `${JSON.stringify({ directory: values.out, rows: result.rows.map(({ answer, ...row }) => ({ ...row, answer_saved: Boolean(answer) })), retrieval: result.retrieval.map(({ case_id, recall }) => ({ case_id, groups: recall.groups })), costs: result.costs }, null, 2)}\n`,
    );
    if (result.rows.some((row) => row.status !== "complete"))
      process.exitCode = 1;
    return;
  }
  if (command === "projects" && positionals.length === 1) {
    const catalog = await listProjects(values["sessions-root"]);
    process.stdout.write(
      `${JSON.stringify({ projects: catalog.projects.map(({ rollouts, ...project }) => ({ ...project, source_files: rollouts.length })), warnings: catalog.warnings }, null, 2)}\n`,
    );
    return;
  }
  if (values.project && input)
    throw new Error("Select --project or an explicit input path, not both.");
  const project =
    values.project &&
    (command === "run" || command === "capture" || command === "compare")
      ? selectProject(
          (await listProjects(values["sessions-root"])).projects,
          values.project,
        )
      : undefined;
  if (
    (!input && !project) ||
    positionals.length !== (project ? 1 : 2) ||
    !["ingest", "replay", "run", "capture", "compare"].includes(command ?? "")
  ) {
    throw new Error(
      "Use ingest <path>, replay <source-sha256>, capture <path>, or run <path>. Run --help for usage.",
    );
  }
  const output = values.out ?? ".sessionlore";
  if (command === "compare") {
    if (values.since || values.until)
      throw new Error(
        "compare always uses the full project. --since and --until are not accepted.",
      );
    if (values.provider !== "deepseek" && values.provider !== "kimi-code")
      throw new Error(
        "Full-history compare supports --provider kimi-code or deepseek.",
      );
    const selection = values.approach ?? "all";
    const approaches =
      selection === "all"
        ? [...LONG_APPROACHES]
        : selection.split(",").map((name) => name.trim() as LongApproach);
    if (approaches.some((name) => !LONG_APPROACHES.includes(name)))
      throw new Error(`compare approaches: ${LONG_APPROACHES.join(", ")}`);
    const result = await runLongComparison({
      input: input ?? project!.path,
      output,
      ...(project ? { project } : {}),
      approaches,
      model: makeProvider(values.provider),
      ...(values.tokenizer ? { tokenizerPath: values.tokenizer } : {}),
      chunkTokens: Number(values["chunk-tokens"]),
      inputTokens: Number(values["input-tokens"]),
      concurrency: Number(values.concurrency),
      targetWords: explicit("words") ? Number(values.words) : 1800,
      maxCalls: explicit("max-calls") ? Number(values["max-calls"]) : 3000,
      prepareOnly: values["prepare-only"],
      evidenceView: values["evidence-view"],
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.results.some((item) => item.status === "failed"))
      process.exitCode = 1;
    return;
  }
  if (command === "capture") {
    process.stdout.write(
      `${JSON.stringify(
        project
          ? await captureFiles(
              project.rollouts.map((item) => item.path),
              output,
              project.path,
            )
          : await captureCase(input!, output),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "run") {
    const number = (name: keyof typeof values): number => {
      const raw = values[name];
      const parsed = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(parsed))
        throw new Error(`--${name} must be a finite number.`);
      return parsed;
    };
    const selection = (values.approach ?? "all").toLowerCase();
    const approaches =
      selection === "all"
        ? [...APPROACHES]
        : selection.split(",").map((value) => {
            const name = value.trim();
            const alias = /^[a-f]$/.test(name)
              ? APPROACHES[name.charCodeAt(0) - 97]
              : name;
            if (!APPROACHES.includes(alias as Approach))
              throw new Error(`Unknown approach: ${name}`);
            return alias as Approach;
          });
    if (
      !["demo", "openai-compatible", "deepseek", "kimi-code"].includes(
        values.provider!,
      )
    )
      throw new Error(
        "--provider must be demo, openai-compatible, deepseek, or kimi-code.",
      );
    if (values["json-mode"] !== "schema" && values["json-mode"] !== "object")
      throw new Error("--json-mode must be schema or object.");
    for (const name of ["max-output-tokens", "timeout-ms"] as const)
      if (!Number.isInteger(number(name)) || number(name) <= 0)
        throw new Error(`--${name} must be a positive integer.`);
    if (Boolean(values.git) !== Boolean(values["git-range"]))
      throw new Error("Supply both --git and --git-range.");
    const apiKey =
      process.env[
        values.provider === "deepseek" &&
        values["api-key-env"] === "OPENAI_API_KEY"
          ? "DEEPSEEK_API_KEY"
          : (values["api-key-env"] ?? "OPENAI_API_KEY")
      ];
    const model =
      values.provider === "demo"
        ? new DemoModel()
        : values.provider === "kimi-code"
          ? makeProvider("kimi-code")
          : new HttpModel({
              model:
                values.model ??
                process.env.SESSIONLORE_MODEL ??
                (values.provider === "deepseek" ? "deepseek-flash" : ""),
              baseUrl:
                values["base-url"] ??
                process.env.SESSIONLORE_BASE_URL ??
                (values.provider === "deepseek"
                  ? "https://api.deepseek.com"
                  : "https://api.openai.com/v1"),
              apiStyle: values.provider === "deepseek" ? "deepseek" : "openai",
              ...(apiKey ? { apiKey } : {}),
              jsonMode: values["json-mode"],
              maxOutputTokens: number("max-output-tokens"),
              timeoutMs: number("timeout-ms"),
            });
    const artifacts = [
      ...(values.artifacts ? await readArtifacts(values.artifacts) : []),
      ...(values.git && values["git-range"]
        ? await gitArtifacts(values.git, values["git-range"])
        : []),
    ];
    const result = await runExperiment({
      input: input ?? project!.path,
      ...(project ? { project } : {}),
      output,
      approaches,
      model,
      artifacts,
      includeSessionArtifacts: values["session-artifacts"],
      evidenceView: values["evidence-view"],
      options: {
        since: values.since ?? null,
        until: values.until ?? null,
        block_chars: number("block-chars"),
        context_chars: number("context-chars"),
        target_words: number("words"),
        max_calls: number("max-calls"),
        retrieval_k: number("retrieval-k"),
        retrieval_rounds: number("retrieval-rounds"),
        pivot_threshold: number("pivot-threshold"),
      },
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.results.some((item) => item.status !== "complete"))
      process.exitCode = 1;
    return;
  }
  const result =
    command === "ingest"
      ? await ingest(input!, output)
      : await replay(input!, output);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected failure";
  process.stderr.write(`sessionlore: ${message}\n`);
  process.exitCode = 1;
});
