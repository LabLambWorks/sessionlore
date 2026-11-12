# Exhaustive request inventory

Use this mode to recover requested enhancements, fixes, features and refinements
from a Codex project. It accounts for every retained human request and recorded
answer. It does not choose only important events or write a devlog.

```sh
pnpm build
node scripts/capture-request-inventory.mjs --project peekawild
node scripts/inventory-requests.mjs
node scripts/inventory-requests.mjs --run
node scripts/render-request-inventory.mjs
```

All commands accept `--out`. The default is
`.sessionlore/peekawild-request-inventory-v1`. Capture and the first inventory
command are local-only. The `--run` command uses the existing
`KIMI_CODE_API_KEY` from `.env` and Kimi Code `k3.1-pro` with low reasoning effort.

## Evidence and coverage

Capture discovers all project chat files, including archives and worktrees, and
freezes their complete retained conversation text. Source-file SHA-256 hashes,
original paths, and source line/byte locators remain in the capture. Large raw
execution output and media remain in the original files. The capture does not
copy those archives or send them to a model. It rejects source changes during a
read and malformed source records. Cached normalized sources can be reused.

Every human request and recorded answer is a target. Nearby complete messages
are included for short approvals and referential corrections; recorded questions
are included when an answer needs them. There are no time windows, truncated
source messages, model-selected searches or early finish decisions. Batches have
at most 32 target records and approximately 8,000 local proxy tokens of data.
An oversized complete request and its context stop preparation.

Each output record contains separate requested items or an explicit non-request
reason. The validator rejects missing, repeated or invented target IDs and
invented context citations. Source quotations are checked locally; a mismatched
quotation is flagged without deleting neighboring items. Record accounting does
not establish semantic completeness. Inspect compound requests, ambiguous
approvals, image references and exclusion reasons when assessing quality.

If a response has extracted items but omits the inapplicable
`no_request_reason` field, validation records that structural repair and sets
the field to `null`. The raw response remains unchanged. An empty item list
still requires an explicit exclusion reason; validation does not invent one.

Items preserve requested direction and constraints, a stated reason when present,
the reason's source actor, source wording, uncertainty, date and chat link.
Repeated requests and later reversals are retained separately. Grouping and
searching in the reader do not merge or delete them. “Focused” is a scope label,
not an estimate of engineering effort. Implementation status is `not_checked`.

## Usage and resumption

The PeekaWild run started with limits of 180,000 new input-plus-output tokens,
24 generations and a 15-percentage-point quota increase. After the quota guard
stopped the run, the user approved increasing only that guard to 30 points.
The amendment is recorded in `resume-budget.json`; token and call limits stay
unchanged. It runs one request at
a time. Each call reserves Kimi's provider input count, protocol framing and the
full output allowance before generation. The local DeepSeek tokenizer is only
a batching proxy. The run stops on exhausted quota, an unknown request outcome,
an unresolved reservation or a budget guard. It does not automatically retry.

Exact requests, responses, model settings, provider usage and checkpoints remain
saved. A resume of the same frozen run reuses matching completed responses.
Changing the prompt or capture does not silently reuse incompatible model work.
Do not reset or bypass a budget to finish a stopped run. Record explicitly
authorized increases through `KimiRunBudget.amend`, preserving the previous
limits and usage. A new output directory is not a workaround for a guard.

## Outputs

- `inventory.html`: local searchable reader, with scope, category, area and
  uncertainty filters, original messages, and Codex chat links.
- `inventory.csv` and `inventory.md`: complete extracted items.
- `inventory.json`: items and the full per-record coverage ledger.
- `records.json`, `primary-corpus.json`, `capture.json`: frozen text and provenance.
- `preflight.json`, `resume-budget.json`, `run-result.json`, `summary.json`: scope,
  token accounting, limits and completion status.
- `attempts/`, `responses/`, `token-counts/`, `results/`: exact model work and cache.

Implementation verification and interpretation of image-only details are separate
work. No implementation claim is inferred from a request or assistant suggestion.
