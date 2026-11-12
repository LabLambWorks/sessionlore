# Sessionlore

Sessionlore is a plugin for writing source-linked engineering dev logs in the
coding agent's first-person voice. Codex, Claude Code, or OpenCode supplies the
model: the host agent reads evidence, plans, writes, and reviews. The packaged
local tools import sessions, search evidence, check citation IDs, and export
Markdown and HTML. This workflow needs no separate writing-model API key.

Codex rollouts, Claude Code transcripts, and OpenCode JSON exports feed the same
evidence store. Existing API-backed narrative experiments remain available for
research; they are separate from the plugin and retain their original prompts.

## Install

Requires Node.js 22.15 or newer. The plugin includes its runtime and needs no
workspace dependency install. This is an early release; see the
[tested versions and limits](docs/plugin.md#development-checks).

For Codex:

```sh
codex plugin marketplace add LabLambWorks/sessionlore
codex plugin add sessionlore@sessionlore-local
```

For Claude Code, run these inside a session:

```text
/plugin marketplace add LabLambWorks/sessionlore
/plugin install sessionlore@sessionlore-local
```

Restart the host session and ask:

> Use Sessionlore to write this project's dev log from your perspective.

Claude Code also provides `/sessionlore:devlog`.

For OpenCode V1, clone this repository and add the absolute file URL of
`plugins/sessionlore/opencode.mjs` to the `plugin` array in `opencode.json`.
Restart and run `/sessionlore`. See the [plugin guide](docs/plugin.md) for the
complete configuration, supported transcript formats, and V2 status.

The agent writes as itself: “I traced the failure to the parser,” while attributing
the developer's decisions to the developer. It checks claims against captured
sources and exports a local draft with citations. Review the result before sharing;
source excerpts can contain private information.

## Develop

Use Node.js 22.23.1 and pnpm 10.33.2. The repository pins both versions. With nvm
and Corepack installed:

```sh
git clone https://github.com/LabLambWorks/sessionlore.git
cd sessionlore
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm plugin:build
```

The build produces a standalone plugin at `dist/plugins/sessionlore`. The
repository also includes a ready-to-install copy at `plugins/sessionlore`.
After changing the runtime, run `pnpm plugin:prepare-release` to update that copy.
CI checks that it matches a fresh build.

For Claude Code, test the plugin directly:

```sh
claude --plugin-dir ./dist/plugins/sessionlore
```

To exercise the local tools without invoking any model:

```sh
pnpm host prepare --host claude --input fixtures/claude/v1/session.jsonl \
  --out .sessionlore/host-demo
pnpm host read --run .sessionlore/host-demo
```

The host writes `draft.json`, reviews the source records, then passes the reviewed
draft to `validate` and `export`. The skill describes the complete workflow.
A successful citation check confirms that references exist; it does not prove
that every sentence is true.

## Optional model experiments

`pnpm demo` writes a source timeline to `.sessionlore/demo/timeline.md`.
`pnpm demo:approaches` runs all six pipelines on synthetic sessions and artifacts.
It prints a new directory under `.sessionlore/experiments-demo/` containing
`comparison.md` and a `narrative.md` for each approach. Both demos run locally
without an API key. The approach demo uses deterministic excerpts and heuristics;
use a real model to compare writing quality.

Select a project as the main input:

```sh
pnpm cli projects
pnpm cli capture --project peekatrack --out .sessionlore/cases/peekatrack-new
pnpm setup:history
pnpm cli compare --project peekatrack --provider kimi-code \
  --out .sessionlore/peekatrack-full
```

Project discovery collects its sessions, resume files, and Git worktrees. Recorded
file changes and validation results remain in the captured evidence. New `run`
and `compare` jobs use conversation content as their primary model input:
user messages, assistant replies, clarification questions, and recorded answers.
Execution commands, bulk tool results, thoughts, and injected instructions stay
in the local archive. Explicitly supplied artifacts remain available. Project
selection no longer automatically adds copies of tool results as artifacts.
Use `--evidence-view execution` only for an intentional raw-trace experiment.
Put
`KIMI_CODE_API_KEY` in the ignored root `.env`. DeepSeek remains available with
`--provider deepseek` and `DEEPSEEK_API_KEY`. The full-history comparison rejects
time windows, uses token budgets, and resumes cached work in the same output
directory. See [the full-history guide](docs/long-history.md) for the four methods
and the prepared PeekaTrack case. Python 3 is needed for the tokenizer setup.

To recover every requested enhancement and refinement as a searchable list, use
the [request inventory](docs/request-inventory.md). It reads requests and recorded
answers in bounded Kimi batches, preserves source links and stated reasons, and
tracks every input record. It does not write a devlog or infer implementation status.

Prepare a compact conversation view from an existing full-project capture,
without making any API calls:

```sh
pnpm cli prepare-conversation .sessionlore/peekatrack-full-deepseek-v1 \
  --out .sessionlore/peekatrack-conversation-v1
```

`conversation.json` contains the messages with source IDs. `preflight.json`
reports their size and local token estimates. Raw evidence remains in the source
capture for targeted verification. See [the input policy](docs/conversation-input.md).

Generate a complete devlog from the captured project with Kimi Code:

```sh
pnpm build
node --env-file=.env scripts/write-conversation.mjs \
  --source .sessionlore/peekatrack-full-deepseek-v1 \
  --out .sessionlore/peekatrack-kimi-full-narrative-v1
```

This path reads the full conversation, writes the complete project narrative,
then performs one review and revision using the conversation and bounded original
execution records retrieved from the draft's claims. It makes at most two
generation calls, with no automatic retries or output repairs. The output includes
`narrative.html`, `narrative.md`, the unchanged `draft.md`, source links, exact
requests and responses, and measured usage. Completed calls are cached for resumption.
The same-model review is not independent proof of correctness.

That two-pass path is separate from the four long-history approaches. To compare
all four on the same frozen cleaned PeekaTrack conversation with Kimi Code:

```sh
pnpm build
node scripts/compare-cleaned-kimi.mjs
```

This runs summary hierarchy, hybrid retrieval, hierarchy plus retrieval, and
recursive reading through the same first-person writer and batched source review.
Open `.sessionlore/peekatrack-kimi-four-cleaned-v1/comparison.html` for all four full
outputs side by side. Original drafts, review corrections, citations and measured
usage remain available. The runner checks Kimi quota and uses one generation at
a time; exact completed requests are reused on resume.
`node scripts/render-cleaned-comparison.mjs` rebuilds the reader locally without
loading an API key or making a model request.

The [evidence diagnostic](docs/evidence-diagnostic.md) compares extraction from
selected original messages with retrieval from the full project on both models.
The [Kimi-only retrieval comparison](docs/request-result-retrieval.md) tests
request-to-result retrieval and source-derived checks for missing details against
the current pipeline, using the same full-history capture and source budget.

For a model-backed comparison:

```sh
# Set OPENAI_API_KEY in your shell. Use a model available to your account that
# supports Chat Completions and structured JSON output.
export SESSIONLORE_MODEL='your-model-id'
pnpm cli run fixtures/experiments/v1/sessions \
  --provider openai-compatible \
  --approach all \
  --artifacts fixtures/experiments/v1/artifacts.json \
  --out .sessionlore/comparison
```

Select one with `--approach direct`, `hierarchical`, `pivot`, `workstream`,
`retrieval`, or `artifact`. Letters `A` through `F` and comma-separated selections
also work. See [the experiment guide](docs/experiments.md) for real session inputs,
Git artifacts, local model endpoints, limits, and review instructions.

## Workspace

| Path                           | Package                            | Responsibility                                                                                     |
| ------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/cli`                     | `@sessionlore/cli`                 | CLI arguments and local commands                                                                   |
| `packages/contracts`           | `@sessionlore/contracts`           | Runtime schemas and TypeScript types for evidence and later narrative stages                       |
| `packages/adapter-codex`       | `@sessionlore/adapter-codex`       | File discovery, JSONL/Zstandard decoding, Codex normalization                                      |
| `packages/adapter-transcripts` | `@sessionlore/adapter-transcripts` | Claude JSONL and OpenCode export normalization                                                     |
| `packages/host-tools`          | `@sessionlore/host-tools`          | Local tools for the host-agent workflow; no model transport                                        |
| `plugins/sessionlore`          | —                                  | Shared agent-POV skill, Codex/Claude manifests, OpenCode integration                               |
| `packages/evidence-store`      | `@sessionlore/evidence-store`      | Immutable raw bytes and versioned snapshots                                                        |
| `packages/core`                | `@sessionlore/core`                | Ingestion, deduplication within a run, timeline rendering, replay                                  |
| `packages/experiments`         | `@sessionlore/experiments`         | Narrative experiments, full-history methods, model transport, retrieval, writing, and verification |
| `fixtures/codex/v1`            | —                                  | Synthetic regression inputs                                                                        |
| `fixtures/experiments/v1`      | —                                  | Synthetic mixed-task sessions and engineering artifacts                                            |
| `docs`                         | —                                  | Original build brief, revision report, architecture image, and implementation notes                |

Internal dependencies use `workspace:*`. TypeScript project references build the
packages in dependency order. The plugin build bundles its runtime dependencies.
Nothing is published by the build; a public release still needs a licensing and
distribution decision.

## Commands

```sh
# Build all packages.
pnpm build

# Build the standalone plugin, or inspect its model-free command interface.
pnpm plugin:build
pnpm host --help

# Rebuild packages when source files change.
pnpm dev

# Ingest an explicit file or recursively scan a directory.
pnpm cli ingest /path/to/rollout.jsonl --out .sessionlore/local
pnpm cli ingest /path/to/sessions --out .sessionlore/local

# Verify a captured snapshot using a source ID from report.json.
pnpm cli replay <source-sha256> --out .sessionlore/local

# Run formatting checks, type checks, and tests.
pnpm check
pnpm format

# Exercise all six pipelines without API access.
pnpm demo:approaches
```

`pnpm cli` builds before running. After a build, you can also run
`node apps/cli/dist/index.js --help`. To build one package and its dependencies,
run `pnpm --filter @sessionlore/core build`.

## Ingestion behavior

- Reads `.jsonl` and `.jsonl.zst` files only from the path you provide.
- Retains every physical record, including unknown records and malformed tails.
- Records raw hashes, source metadata, line numbers, and decompressed byte ranges.
- Recognizes human turns from supported `event_msg.user_message` records. A
  completed desktop `UserMessage` is also recognized. A `role=user` response item
  alone is not treated as a human turn. Explicit subagent input remains distinct
  from human input.
- Reads completed `FileChange` and `CommandExecution` records as structured
  evidence, and flags explicit message mirrors to avoid duplicate story inputs.
- Records explicit fork, subagent, and attachment metadata as distinct lineage
  relationships. It does not infer or merge thread families.
- Keeps complete event IDs stable when a source is appended to. Repeated ingestion
  of unchanged bytes creates no new snapshot. Plain and compressed copies share
  event IDs, while each raw snapshot remains available.
- Renders source-file and line order, preserving timestamp conflicts as warnings.
- Replays captured bytes without requiring the original input file.

Each run replaces the local timeline and report with the supplied input set. Prior
snapshots remain stored; the timeline is not a cumulative database query. Capture
and normalization stream large files, with limits of 2 GiB per raw or decoded
source and 256 MiB per physical JSONL record. Media remains in raw evidence; the
writer receives text projections. Symlinks are not followed. The scanner skips
`.git`, `node_modules`, `.sessionlore`, and the selected output directory.

## Local data

```text
.sessionlore/local/
  raw/<source-sha256>
  snapshots/<source-sha256>/codex-0.3.0.json
  report.json
  timeline.md
```

Raw evidence and local previews can contain secrets. They are not redacted or
ready for publication. Ingestion, replay, and the demo provider make no network
calls. Model-backed runs send selected source content to the configured API
endpoint and save prompts and responses locally. The tool does not execute
transcript content. It creates data files with mode `0600` on POSIX systems.
`.sessionlore/` is ignored by Git. Keep custom output locations out of version
control as well.

The contracts require evidence references and distinguish `observed`, `inferred`,
and `unknown` fields. Schema validation does not prove a claim is supported by its
source. Experiments validate source IDs and use a model to review atomic claims
against original excerpts. This reviewer can miss errors. The long-history
comparison keeps source-supported review corrections and withholds paragraphs
that the reviewer cannot repair. Other experiment paths retain their original
filtering policy. Complete drafts and verdicts remain available. Redaction and
publishing are not implemented.

## Design and next work

The [design research](docs/Session-to-devlog%20深度事實核查與修訂建議.md)
records the initial implementation order and evidence boundaries. See
[monorepo notes](docs/monorepo.md) for package dependencies and the remaining phases.

The fixtures are synthetic. They do not establish compatibility with a particular
installed host version. Native plugin loading checks are documented separately
in the [plugin guide](docs/plugin.md#development-checks). Broader live-version
fixtures, a Grok adapter, lifecycle capture, calibrated continuation inference,
dedicated short-form generation, and publishing remain future work.

## Contribute and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release checks, and
[SECURITY.md](SECURITY.md) for private vulnerability reports.

Sessionlore is licensed under [MIT](LICENSE). The bundled plugin includes
[third-party notices](plugins/sessionlore/THIRD_PARTY_NOTICES.md).
