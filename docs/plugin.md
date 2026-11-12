# Sessionlore host-model plugin

The plugin's skill asks the active coding agent to select evidence, plan the
story, write from the agent's perspective, and review its claims. Model work
stays in the host session and uses that host's configured model and usage limits.
Sessionlore does not read provider credentials or call a model endpoint in this
workflow. Its bundled Node.js tools perform local data processing and export.

## Install

The repository's `plugins/sessionlore` directory includes the executable and all
runtime dependencies. It needs Node.js 22.15 or newer on the receiving machine.
No build or separate writing-model credentials are required.

### Codex

The repository's `.agents/plugins/marketplace.json` points to the ready-to-install
package. Run:

```sh
codex plugin marketplace add LabLambWorks/sessionlore
codex plugin add sessionlore@sessionlore-local
```

Restart the session and ask:

> Use Sessionlore to write this project's dev log from your perspective.

In a supported Codex desktop local marketplace, select Sessionlore from the
repository marketplace and enable it. The package includes a portable root
`plugin.json` and a `.codex-plugin/plugin.json` compatibility manifest. There
are no lifecycle hooks; writing is requested in an active agent session.
See [OpenAI's packaging guide](https://developers.openai.com/plugins/build/plugins)
for installation and public directory requirements.

### Claude Code

For a persistent installation, run these inside Claude Code:

```text
/plugin marketplace add LabLambWorks/sessionlore
/plugin install sessionlore@sessionlore-local
```

To try a local clone:

```sh
claude --plugin-dir ./plugins/sessionlore
```

Invoke `/sessionlore:devlog` with the requested scope, or ask in natural language.
The repository includes `.claude-plugin/marketplace.json`. The plugin inherits
the active model; it does not declare a
different model or launch a nested agent process. See
[Claude Code plugins](https://code.claude.com/docs/en/plugins).

### OpenCode

For OpenCode V1, clone the repository to a persistent location:

```sh
git clone https://github.com/LabLambWorks/sessionlore.git
```

Add the entrypoint to `plugin` in the project's `opencode.json`, using an
absolute file URL:

```json
{
  "plugin": [
    "file:///absolute/path/to/sessionlore/plugins/sessionlore/opencode.mjs"
  ]
}
```

Restart OpenCode and run `/sessionlore` with the requested scope. The command
supplies the skill to the current agent. It preserves an existing command named
`sessionlore`; rename the plugin command if that name is already in use.

The separate V2 entrypoint registers a skill with the V2 skill API:

```json
{
  "plugins": [
    "file:///absolute/path/to/sessionlore/plugins/sessionlore/opencode-v2.mjs"
  ]
}
```

Use the `sessionlore` skill in the active agent. V1 and V2 use different plugin
APIs and configuration keys. See [OpenCode's plugin API](https://opencode.ai/docs/build/plugins/server).
The V2 entrypoint has a contract test; a real V2 installation is still required
before claiming a tested V2 release.

## Inputs and scope

| Host | Input | Discovery |
| --- | --- | --- |
| Codex | `.jsonl` and `.jsonl.zst` rollouts | Existing project/session metadata, including recorded Git worktrees |
| Claude Code | `.jsonl` transcripts | `~/.claude/projects`, filtered by exact recorded working directory |
| OpenCode | JSON from `opencode export <session-id>` | Installed CLI session listing, or explicit exports |

Use `sessions --host <host> --project <path>` to list candidate sessions. A
`--sessions-root` override supports alternate transcript locations. Source paths
can also be supplied directly. For several selected files, stage copies under a
new directory with unique names and prepare that directory. The skill limits
selection to the requested project or sessions.

Prepare one host's sources per run. A multi-host project currently needs separate
runs and attributed chapters. OpenCode V1 JSON exports are covered by fixtures.
Unsupported export shapes cause an error. Live transcript schema changes need
new fixtures and adapter validation.

Claude sidechain prompts are attributed to an assistant rather than the human,
and child transcripts receive separate thread identities. Neither new adapter
infers parentage from semantic similarity. The raw archive retains metadata and
unsupported records for inspection.

## Local workflow

```sh
pnpm host prepare --host codex --input /path/to/rollout.jsonl \
  --out .sessionlore/devlog-run --narrator Codex
pnpm host read --run .sessionlore/devlog-run --cursor 0
pnpm host search --run .sessionlore/devlog-run --query "test results" --view all
pnpm host read --run .sessionlore/devlog-run --refs SOURCE_ID
pnpm host validate --run .sessionlore/devlog-run --draft .sessionlore/devlog-run/reviewed.json
pnpm host export --run .sessionlore/devlog-run \
  --draft .sessionlore/devlog-run/reviewed.json --out .sessionlore/devlog-output
```

For an installed package, replace `pnpm host` with
`node /path/to/plugin/skills/devlog/scripts/sessionlore-host.mjs`.
Preparation and export require new directories. Failed preparation can retain
captured bytes for diagnosis; use a new directory after correcting the input.

The host writes the draft using `draft.schema.json`, then checks cited originals
and later corrections. The narrator's host and name must match the run manifest.
Validation checks structure and reference existence; semantic support,
perspective, and completeness remain host-agent review tasks.

`read` returns a `next_cursor` for pagination. Messages over 6,000 characters are
split into lossless fragments. `search` returns shortened navigation excerpts;
read the full fragments before citing them. Conversation pages exclude thoughts,
injected instructions and bulk execution output. Targeted execution records are
available with `--view all`. The raw archive retains the originals. The Claude
and OpenCode import limit is 128 MiB per file.

OpenCode records point to the complete export document and retain original
message/part IDs. Claude and Codex retain line/byte pointers. The exported source
bundle includes exact cited fragments and provenance. HTML escapes all prose and
source text and uses no remote assets. Outputs are local drafts, with no automatic
publication action.

## Development checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm plugin:check
```

`pnpm plugin:build` creates a standalone copy in `dist/plugins/sessionlore`.
`pnpm plugin:prepare-release` updates the committed runtime, license, and notices
in `plugins/sessionlore`. Commit those generated files with source changes.
`pnpm plugin:check` verifies they match a fresh build; CI runs this check. These
commands do not publish anything. For local marketplace development, use the
repository path instead of `LabLambWorks/sessionlore` in the install commands.

Local loading was verified on 2026-11-12 with Codex CLI 0.153.0, Claude Code
2.1.197, and OpenCode 1.18.15. Codex installed and enabled the built local plugin;
Claude listed the packaged `devlog` skill; OpenCode loaded the `/sessionlore`
command with no model override. A Codex host-written synthetic example completed
the read, write, review, validate, and export flow. These checks do not establish
writing quality across every host model or compatibility with future versions.

`pnpm check` runs formatting, TypeScript, and regression tests, including the
three-host evidence workflow and a relocated package without model credentials.
`pnpm plugin:build` fails if legacy model transports or experiment dependencies
enter the bundle. Tests cover actors, tool results, malformed tails, Unicode
fragments, citation failures, source integrity, and inert HTML output.

The original API-backed commands remain in `apps/cli` and
`packages/experiments`, with their existing provider setup and prompts. The
plugin neither imports nor invokes that runtime.
