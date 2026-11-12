# Run and compare the six approaches

All six approaches are implemented in `packages/experiments`. They share the Codex
adapter, captured evidence, writer, word target, and claim reviewer. They differ in
how they select and organize evidence before writing.

For complete large projects, use the four-method `compare` command in the
[full-history guide](long-history.md). The A–F runner below remains available for
the earlier experiments. A direct call cannot process a project larger than the
selected model's context.

## Start with an offline run

From the repository root, with the pinned Node.js and pnpm versions installed:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo:approaches
```

The last command runs all six methods and prints the output directory. Open its
`comparison.md`, then each method's `narrative.md`. This mode uses deterministic
excerpts, keyword scores, and simple grouping. It tests execution and output
inspection. It does **not** test model quality or semantic claim support.

The fixtures include interleaved work, an abandoned approach, a test result
invalidated by a later edit, a cross-thread continuation, and an investigation
without a resulting artifact. See the [fixture review notes](../fixtures/experiments/v1/README.md).

## Run with a model

Set your API key in `OPENAI_API_KEY` using your usual secret-management method.
Select a model available to your account that accepts Chat Completions with JSON
schema output. This example explicitly selects the generic API provider.

```sh
export SESSIONLORE_MODEL='your-model-id'
pnpm cli run fixtures/experiments/v1/sessions \
  --provider openai-compatible \
  --approach all \
  --artifacts fixtures/experiments/v1/artifacts.json \
  --out .sessionlore/model-comparison
```

The default provider is `kimi-code`. For the generic API example above, explicitly
select `--provider openai-compatible`, at `https://api.openai.com/v1`.
Every selected method uses the same model, including the final writer and reviewer.
Requests send selected source excerpts and intermediate results to that endpoint.
Source text is not redacted. Calls are stateless and return structured JSON.

## Select a project

Projects are the main input unit. Threads remain internal evidence boundaries.
List projects, then select a name, full project path, or returned ID:

```sh
pnpm cli projects
pnpm cli run --project peekatrack --approach all --model your-model-id
```

Discovery reads the first metadata record of each local Codex session. It groups
sessions by working directory and uses the shared Git directory to include linked
worktrees and repository subdirectories. It includes archived sessions and resume
files. `--sessions-root /path/to/sessions` limits discovery to a supplied folder.
Names must be unique; use a path or ID when two projects have the same name.

The story projection orders source files by their recorded start times, so freezing
them under hash-based filenames does not reorder the comparison. Exact repeated
events with the same thread, original event ID, type, and text are projected once.
Their raw records remain available, and duplicate projections appear in the
exclusion list. Matching text in different threads is not deduplicated.

Project runs automatically include recorded file changes and validation-command
results as artifacts. This is the same source set for A–F. The app does not require
the user to select individual conversations. The current interface is the CLI;
the project discovery and selection functions are also exported from `core` for a
later graphical interface.

Freeze a project before comparing different model or pipeline settings:

```sh
pnpm cli capture --project peekatrack --out .sessionlore/cases/peekatrack-new
pnpm cli run .sessionlore/cases/peekatrack-new/sessions \
  --approach all --session-artifacts --model your-model-id
```

`capture` refuses to overwrite an existing named case. It writes `case.json`, an
evidence store, and immutable input copies under `sessions/`. Capture makes no
model requests. The same command also accepts an explicit rollout path for adapter
debugging, but project selection is the normal product flow.

The supplied PeekaTrack links resolve to the `peekatrack` project. A local case is
prepared at `.sessionlore/cases/peekatrack/`; it includes all six linked thread IDs,
their resume files, and the other sessions recorded for that project. Its capture
contains 26 files across 23 thread IDs, about 725 MB of raw data. This is private
local test data and is excluded from Git.

For the full PeekaTrack comparison, set `DEEPSEEK_API_KEY` in `.env`, download the
official tokenizer once, then run all four long-history methods:

```sh
pnpm setup:history
pnpm cli compare .sessionlore/cases/peekatrack/sessions \
  --provider deepseek --model deepseek-flash \
  --out .sessionlore/peekatrack-full-deepseek-v1
```

This command uses the complete frozen project and rejects time filters. Repeat it
to resume completed calls. The earlier two-minute offline run checked execution
only and is not evidence of full-project capability. The full comparison retains
drafts, reviewed narratives, exact calls, source coverage, usage, and an interactive
reader. See [the full-history guide](long-history.md) for implementation limits.

For legacy `run` debugging only, `--since` is inclusive and `--until` is exclusive; both use ISO timestamps with
time zones. Out-of-window events and events with unknown timestamps are excluded
from a bounded comparison and recorded in the exclusion list. Artifact timestamps
use the same interval. Source captures remain complete. A window can omit earlier
context, so review conclusions that depend on events before its start.

## Run an explicit input

Run a single method or a subset:

```sh
pnpm cli run /absolute/path/to/rollout.jsonl --approach direct
pnpm cli run /absolute/path/to/selected-sessions --approach B,D,E
```

Use an explicit file or a directory containing only the sessions for the comparison.
Directory scanning is recursive. Inputs can be plain `.jsonl` or `.jsonl.zst`.
Unknown records remain in the raw capture. Records without a text projection are
listed in `corpus.json` and are not sent to the writer. Explicit user/assistant
message mirrors are also excluded from the story projection while retained in raw
evidence. Completed desktop records have regression coverage based on observed
session shapes, not a compatibility claim for every Codex release.

For a local compatible server, select its installed model and endpoint:

```sh
pnpm cli run fixtures/experiments/v1/sessions \
  --approach all \
  --artifacts fixtures/experiments/v1/artifacts.json \
  --model your-local-model \
  --base-url http://localhost:11434/v1 \
  --api-key-env LOCAL_MODEL_API_KEY \
  --json-mode object
```

The local key variable can be unset when the server needs no authentication.
`schema` mode requests strict JSON-schema output. `object` mode requests a JSON
object and includes the schema in the prompt; both modes validate results locally.
The transport sends `max_completion_tokens`, so the server must support that field
to enforce the configured output limit. Compatibility depends on the server and
model. The [OpenAI API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
and [Ollama compatibility reference](https://docs.ollama.com/api/openai-compatibility)
describe their request formats; this project uses the shared Chat Completions interface.

## Select an approach

| Letter / name | Implemented stages | Main inspection files |
| --- | --- | --- |
| A / `direct` | Full normalized source text → outline → narrative. Every writing call sees the complete source set. | `outline.json`, `calls/` |
| B / `hierarchical` | Turn-aware blocks → summary of every block → combine summaries → recursively reduce if necessary → outline → narrative. The writer receives summaries. | `block-summaries.json`, `combined-summaries.json`, reduction levels |
| C / `pivot` | Model relevance scores → nearest-anchor attachment within a thread → evidence fields in cards → official and proposed thread links → topological thread order → contiguous card segments → narrative. | `scores.json`, `attachments.json`, `cards.json`, `thread-links.json`, `ordered-cards.json` |
| D / `workstream` | Task attempts within threads → many-to-many grouping by goal across threads → decision extraction within groups → outline → narrative. | `attempts.json`, `workstreams.json`, `workstream-decisions.json` |
| E / `retrieval` | BM25 source index → outline from source previews → retrieve full evidence → revise outline and query again → execute final queries → narrative. | `search-index.json`, `initial-outline.json`, `retrieval-trace.json`, `retrieved-evidence.json` |
| F / `artifact` | Artifact anchors → retrieve related conversation → reconstruct decisions and outcomes for each artifact → outline → narrative. | `artifact-matches.json`, `artifact-reconstructions.json`, `unmatched-conversation.json` |

`--approach all` runs A–F in sequence. Comma-separated names or letters work too.

C's scores express narrative relevance, not calibrated confidence. Low-scoring
sources attach to the nearest anchor without being deleted. A thread with no score
above the threshold uses its highest-scoring source and records that fallback.
Fields can remain unknown. Official lineage and model-proposed continuation remain
distinct, and thread identities are never merged. Cycles produce a warning and a
stable source-order tie break. Proposed links are experimental and uncalibrated.

D uses lexical retrieval to propose up to six existing goal groups, then asks the
model to choose memberships or create a separate group. This can miss matches
with different vocabulary; inspect the saved assignments. Every source in an
extraction block must belong to at least one attempt.

E uses BM25, not embeddings. Its catalogue contains explicit previews; the full
text remains retrievable. It can miss synonyms or context outside its retrieved
set. The final source list and all queries are saved.

F deliberately starts from artifacts. It saves unmatched conversation separately
so a reviewer can check for omitted investigation and abandoned work. A retrieval
match is not proof that a conversation caused a commit.

## Supply engineering artifacts

F needs artifacts. Supply a JSON export, a local Git range, or both. Every approach
in a run receives the same artifact set, so F's difference is its starting point
and selection method, not privileged evidence access.

```sh
# Local commit contents and diffs, excluding the base commit.
pnpm cli run /absolute/path/to/selected-sessions \
  --approach all \
  --git /absolute/path/to/repository \
  --git-range 'BASE_COMMIT..HEAD' \
  --out .sessionlore/real-comparison

# Exported PRs, issues, diffs, commits, or test output.
pnpm cli run /absolute/path/to/selected-sessions \
  --approach artifact \
  --artifacts /absolute/path/to/artifacts.json
```

Git collection reads at most 100 commits from an explicit two-dot range. It uses
commit hashes after resolving the range, disables external diff and text-conversion
commands, and does not change the working tree. It does not capture uncommitted
changes, fetch PRs, or execute tests. Add those observations to an artifact export
when relevant. A Git commit alone does not prove test success or deployment.

The JSON format is:

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "cache-test-2026-10-01",
      "kind": "test",
      "title": "Product cache unit tests",
      "text": "Command, tested revision or state, exit code, and actual output go here.",
      "timestamp": "2026-10-01T10:03:00Z",
      "uri": null,
      "paths": ["src/product-cache.ts"]
    }
  ]
}
```

All fields are required. `timestamp` and `uri` can be null. `kind` is one of
`commit`, `diff`, `pr`, `issue`, or `test`. IDs must be unique across both artifact
inputs. The runner preserves and hashes the export. The user is responsible for
its factual content; a structured export does not authenticate the observations.

For recorded conversation artifacts, pass `--session-artifacts` on an explicit
input, or select `--project` to enable it automatically. This extracts completed
desktop `FileChange` observations and `CommandExecution` records whose command
matches a supported validation command such as `pnpm test`, `npm run test:*`, or
`pytest`. It preserves failed results as well as successes, including exit codes,
captured output, and source locators. Command matching is a heuristic: the output
must still establish what was tested. It does not rerun tests or treat a successful
process as proof of deployment. Older log formats may not contain these records.

Without artifacts, a multi-method run marks F `skipped`. A run selecting only F
fails with an actionable message. Neither case is reported as a successful F run.

## Inspect and compare results

Each run creates a new directory; it does not replace an earlier experiment:

```text
run-<timestamp>-<id>/
  manifest.json             # Input hashes, model/configuration, options, methods
  corpus.json               # Source IDs, normalized text, raw locators, exclusions
  artifacts.json            # Frozen artifact input
  artifact-input.json       # Original external artifact export, before time filtering
  sources.md                # Source excerpts linked from narratives
  comparison.md
  comparison.json
  review-scorecard.json     # Empty fields for human assessment
  evidence/                # Immutable raw snapshots, ingestion report, timeline
  direct/                  # And hierarchical/, pivot/, workstream/, retrieval/, artifact/
    outline.json
    draft.json
    draft.md                # Complete generated narrative before filtering
    verification.json       # Verdict and sources checked for each atomic claim
    narrative.md            # Claims accepted by the reviewer; labelled demo otherwise
    result.json             # Status, usage, elapsed time, counts, warnings
    calls/                  # Exact stage inputs, schemas, responses, validation errors
```

Every generated claim must cite source IDs supplied to its writing call. The
shared reviewer sees the original cited excerpts, three lexical search hits for
possible contradictions, and the final source in each cited thread. It can mark a
claim supported, unsupported, or uncertain. The final narrative withholds the last
two categories. The complete draft and review reasons stay available even when
all claims are withheld. Demo outputs are never described as semantically verified.

The reviewer is the same model used for writing. Its verdict is an experimental
signal, not ground truth. It can share the writer's errors and miss contradictions
outside retrieved context. Review both the draft and filtered narrative, since
filtering can hide unsupported claims by deleting them and create omissions.

Use `review-scorecard.json` to record incorrect claims, important omissions,
wrong task groupings, usefulness, and correction time. Compare simple sessions,
long debugging sessions, interleaved tasks, and cross-thread work separately.
Repeat real model runs to check variability. For a blinded review, randomize
copies of the output filenames before giving them to a reviewer.

The comparison reports model calls, provider-reported tokens, elapsed time,
actual draft word count, and cited source count. There is no invented aggregate
quality score. Token counts are null when unavailable. Dollar costs are not
estimated without prices for the selected model.

## Limits and failures

Run `pnpm cli --help` for all options. Common controls are:

| Option | Default | Meaning |
| --- | ---: | --- |
| `--block-chars` | 10000 | Approximate block size; keep complete turns when they fit |
| `--since`, `--until` | unset | Explicit time window applied equally to all methods |
| `--context-chars` | 120000 | Maximum serialized prompt characters, including instructions and schemas |
| `--words` | 700 | Shared narrative word target; actual word count is reported |
| `--max-output-tokens` | 8192 | Per-request output limit, including reasoning tokens where applicable |
| `--max-calls` | 250 | Maximum logical model calls per approach, including validation repairs |
| `--timeout-ms` | 120000 | Timeout per HTTP attempt |
| `--retrieval-k` | 6 | Search hits per query; also used for artifact conversation retrieval |
| `--retrieval-rounds` | 2 | Outline/evidence refinement rounds, followed by final query retrieval |
| `--pivot-threshold` | 0.6 | C's narrative relevance threshold |

Long individual records are split into indexed fragments without removing text.
Their normalized-text character offsets and original raw byte locators are saved.
These character limits are **not token counts**. Choose a prompt limit that leaves
enough room for the selected model's output. `--block-chars` must be at most half
of `--context-chars`.

The streaming importer supports raw and decompressed files up to 2 GiB each and
physical JSONL records up to 256 MiB. Normalized text and narrative stages still
use memory proportional to the text projection. Media bytes remain in the raw
capture; these pipelines do not perform visual analysis of session images.

An oversized A input is skipped without truncation. Other stages also fail
explicitly if their prompt will not fit. B reduces summaries recursively, D
extracts and assigns attempts incrementally, and E pages source discovery and
revision, but no method promises unlimited input size. In particular, a very large
card, grouping prompt, retrieved section, or claim review can reach the limit.
Raise the context limit only if the model supports it; otherwise reduce block
size or retrieval count, or select a smaller comparison case.

Invalid structured responses receive one repair attempt. HTTP 429 and 5xx responses
receive at most two transport retries; those retries are separate from the logical
call limit. Timeouts, authentication errors, refusals, and truncated model output
are explicit failures. Prompts, partial results, and errors remain available for
inspection. Other selected methods continue after a pipeline failure. There is no
automatic resume of a partially completed experiment.

The CLI exits with status 1 if any selected method failed or was skipped, while
still writing the comparison for completed methods. It exits 0 only when every
selected method completed. Completion means the pipeline ran, not that its story
is correct or useful.

## Implementation validation

`pnpm check` covers ingestion regressions, all six distinct execution paths,
reference validation, preservation of attached evidence, long-input behavior,
reduction, retrieval, artifact omissions, Git collection, failure isolation,
CLI behavior, and a complete pipeline against a local HTTP test server. HTTP tests
also cover schema/object modes, usage accounting, refusals, truncation, rate-limit
retry, timeouts, and credential exclusion from saved traces.

The offline and mocked HTTP checks establish that the implementation runs. They
do not establish paid-provider compatibility for every model or comparative
narrative quality. Use the model-backed commands above for that evaluation.
