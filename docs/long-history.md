# Full-project history comparison

The `compare` command implements four long-history methods. It captures the whole
selected project and rejects `--since` and `--until`. Each model call has a token
budget; the project itself does not have to fit in one call.

New runs default to the [conversation input policy](conversation-input.md).
Messages, clarification questions and recorded answers form the primary corpus;
bulk tool traces remain in the local archive. `--evidence-view execution` selects
the older raw-trace input deliberately. Use a new output directory when changing
the input view. The historical PeekaTrack measurements below used execution
traces and do not describe the new default input size.

## Run with Kimi Code

Use the repository's Node.js and pnpm versions, plus Python 3 for the one-time
tokenizer download. Put the key in the ignored root `.env` file:

```dotenv
KIMI_CODE_API_KEY=
DEEPSEEK_API_KEY=
```

```sh
pnpm install --frozen-lockfile
pnpm setup:history
pnpm check
pnpm cli compare .sessionlore/cases/peekatrack/sessions \
  --provider kimi-code --model k3.1-pro \
  --out .sessionlore/peekatrack-full-kimi-v1
```

For a live project, replace the positional path with `--project peekatrack`.
The first run freezes the selected inputs. Repeat the exact command and output
directory to resume that snapshot. Use a new output directory to compare changed
inputs, prompts, or model settings. `.env` is loaded without printing or saving
the key. `JEV_API_KEY` is not used by these four methods.
The separate JEV controller experiment below uses that key only for typed
decisions; it does not change the four Kimi outputs.

`--prepare-only` captures and tokenizes without model calls. The first full run
downloads a pinned MiniLM embedding model and builds its local index. Source
text is embedded locally. LLM calls send selected project text to the selected provider.

Kimi Code is the default for new runs. It uses high reasoning effort, JSON-object
output, and 16,384 completion tokens including reasoning. See the
[Kimi Code setup and diagnostic](evidence-diagnostic.md).

For the DeepSeek control, use `--provider deepseek --model deepseek-flash` and a
separate output directory. Its configuration uses JSON-object output, non-thinking
mode, temperature 0.2, and `max_tokens=8192`. DeepSeek's documented request format
differs from the generic OpenAI transport. See the
[DeepSeek API reference](https://api-docs.deepseek.com/api/create-chat-completion).

## Reproduce the cleaned PeekaTrack comparison

```sh
pnpm build
node scripts/compare-cleaned-kimi.mjs --prepare
node scripts/compare-cleaned-kimi.mjs
```

This runner verifies the raw capture hash and exact equality with both saved
cleaned input files in `.sessionlore/peekatrack-conversation-v1`. It uses Kimi Code
only, reads the live model context limit, checks quota before every generation,
and keeps one generation in flight. Both hierarchy methods share cached notes.
It also searches earlier Kimi caches for exact matching requests. Different
prompts do not reuse unrelated prior answers. Its new output directory is
`.sessionlore/peekatrack-kimi-four-cleaned-v1`. The source snapshot, brief, model
configuration, requests, responses, token usage and retrieval provenance are saved.

To rebuild the reader from saved results without an API key or model request:

```sh
node scripts/render-cleaned-comparison.mjs
```

The reader shows all four method columns. Unfinished methods remain clearly
marked; their absence is not presented as a completed comparison.
Use `node scripts/compare-cleaned-kimi.mjs --wait-for-quota` to keep the current
run waiting until Kimi reports available quota, then resume its cached stages.
The runner checks quota once per minute while waiting and before every new
generation. The wait is recorded separately from method execution time.

## Replay controller decisions with JEV

After the frozen Kimi comparison is complete, test JEV against its ten saved
recursive decision states:

```sh
node scripts/compare-jev-controller.mjs
node --test scripts/jev-controller.test.mjs
node scripts/compare-jev-controller.mjs --run
```

The first command performs local preflight only. The last command loads
`JEV_API_KEY` from `.env` and calls TypeSafe's System One API with the pinned
`jev-1.14.0` model. It never calls Kimi. The persistent allowance is ten requests
and 500,000 input-plus-output tokens, with complete-request byte reservations,
one request in flight, exact request/response storage, and no automatic retries.
An unresolved request or unknown usage stops the run. Successful responses are
reused. Do not reset the allowance to repeat completed work.

JEV returns choices, not generated queries. The adapter offers the allowed
operation, existing investigation questions, and available chunk IDs. Code turns
those selections into the controller's action shape. It retains the complete
saved state; it does not supply Kimi's decision to JEV. Larger byte bounds use
TypeSafe's explicit long-context header rather than shortening the state.
See the [TypeSafe Choice API](https://docs.typesafe.ai/primitives/choice) and
[context limits](https://docs.typesafe.ai/models).

This is a replay on Kimi's saved states, not a JEV-led trajectory or a fifth
devlog. Agreement with Kimi is not ground truth. The first PeekaTrack replay
produced valid controls quickly, but repeatedly selected broad search goals.
Do not use the adapter as an unrestricted controller without duplicate-search
guards and narrower evidence-gap choices. Requests, probabilities, usage and
the comparison are saved in `.sessionlore/peekatrack-jev-controller-v1`.

## Run guarded JEV decisions with Kimi writing

The full PeekaTrack follow-up uses the same frozen cleaned corpus and the completed
comparison's 25 source summaries. It validates each cached summary against the
complete original source text before accepting it.

```sh
pnpm check
node scripts/run-jev-kimi-full.mjs
node scripts/run-jev-kimi-full.mjs --run
node scripts/render-jev-kimi-comparison.mjs
```

The first runner command performs local preflight. The live run gives JEV a finite
set of unread evidence batches. JEV selects the next batch; code rejects repeated
sources and prevents normal completion until all 553 retained records are covered.
There is no free-form search query or model-controlled finish action. Outstanding
questions stay in the writing input; complete coverage does not mean that every
outcome is known.

Kimi reuses exact cached source summaries, then produces one outline and the first-person
devlog. The runner initially attempts the usual Kimi source review. New
source-summary generations are prohibited.
The fixed allowance is eight new Kimi calls, 250,000 new input-plus-output tokens,
and a 25-percentage-point increase in quota use. JEV has a separate eight-call,
250,000-token allowance. Both budgets persist across restarts, reserve the complete
next request, and stop on pending or unknown usage. One provider request is in flight
at a time. Do not reset or enlarge these allowances to work around a guard.

In the recorded run, Kimi needed one full repair for invalid citation IDs. Its
three generations used 236,550 tokens, leaving too little allowance for its source
review. The guard stopped that request before generation. The following separate
continuation uses the two remaining JEV calls for source-support decisions:

```sh
node scripts/finish-jev-source-review.mjs
node scripts/finish-jev-source-review.mjs --run
node scripts/render-jev-kimi-comparison.mjs
```

The first command is an offline preflight. The continuation uses the saved Kimi
draft and existing JEV allowance; it does not clear the Kimi stop or import a Kimi
client. It returns support verdicts only. Unsupported or uncertain paragraphs are
withheld, while the complete original draft stays available. This review differs
from the baseline's Kimi review and cannot establish comparable accuracy from
verdict counts. In this run it withheld seven paragraphs, including supported
material and the whole closing section. See the saved `QUALITY.md` assessment.

Results are saved in `.sessionlore/peekatrack-jev-kimi-full-v1`. The local renderer
compares the complete output and ordered outline against the unchanged Kimi-only
recursive result. It reports incremental usage separately from reused summary work.
This experiment changes the controller and the coverage policy together; it does
not isolate the effect of choosing JEV instead of Kimi.

## Four distinct methods

| CLI name | Reading and planning | Evidence given to the final writer |
| --- | --- | --- |
| `hierarchy` | Read every chunk; recursively combine summaries; plan from the roots. | Selected root summaries and their retained source-linked facts. |
| `hybrid` | Plan from every chat's catalogue, full human requests, and full-text term statistics; refine with retrieval. | Original fragments selected by BM25 and local dense embeddings. |
| `hierarchy-retrieval` | Build the same full-coverage hierarchy and outline as `hierarchy`; retrieve evidence for each section. | Original fragments, including nearby context and searches for later corrections. |
| `recursive` | A controller searches, reads chunks, and delegates questions to recursive readers using external notes. | Original fragments retrieved for the resulting section plans. |

The recursive method is an RLM-style constrained-tool implementation, not a
reproduction of the paper's arbitrary Python REPL. Its tools are `search`, `read`,
`delegate`, and `finish`. The root has at most 16 controller steps, children have
4, and nesting is at most 2. Every source remains available; the reader may stop
without reading every source. Its trace and coverage make this visible.
Once a read or delegated answer enters its memory, the controller may choose to
finish. There is no mandatory minimum of five root operations.

All four use the selected model, the same writer, target length, and original-source paragraph
reviewer. The default target is 1,800 words. Actual word counts can differ.
The writer uses the human owner's first-person voice. It attributes Codex's work
where needed and does not invent personal actions or experiences. Complete
sections share one copy of repeated writing material within each bounded request.
Verification batches up to 24 paragraphs with their complete original citations
and up to 8,000 proxy tokens of retrieved counterevidence. It can return a cited
correction or withhold a paragraph. The original draft and verdicts remain saved.
There is one review pass, without a repeated audit loop. This shared review does
not change the evidence available to the summary-only writer.

## Scaling and provenance

- The local DeepSeek tokenizer counts serialized prompt content. This is a proxy
  when the selected model is Kimi; it is not Kimi token accounting. Each request adds a
  framing reserve. API-reported usage is retained separately; local counts are
  preflight estimates, not billing records.
- Defaults are 16,000 tokens per chunk and 60,000 input tokens per call. Output
  space must also fit the selected model. Turns and chat boundaries are preserved
  when possible; oversized turns split into complete 6,000-character source
  fragments. Every fragment occurs in exactly one processing chunk.
- Summary parents store child node IDs and only retained fact citations. They do
  not recursively copy every descendant source ID into the prompt. The separate
  tree and chunk files preserve processing coverage and provenance.
- Raw source files remain intact. Empty text projections, explicit mirrors, and
  repeated logical events are listed as exclusions. Image/audio payloads are
  retained raw but are not interpreted by these text pipelines.
- Recorded changes and command results remain in their original events. The
  comparison does not append a second copy of extracted artifact text.
- Calls are cached by model configuration, instructions, schema, and input. Cache
  entries retain paid responses before schema validation, so repairs are visible.
  A stopped run reuses completed calls. The default limit is 3,000 calls per method
  with 8 concurrent calls; `--max-calls` and `--concurrency` can change on resume.

The dense index uses the pinned `Xenova/all-MiniLM-L6-v2` revision recorded in the
manifest. Every 240-wordpiece window is encoded, then pooled into a fragment
vector. It does not silently embed only the beginning of a fragment. BM25 and
cosine rankings are fused using reciprocal rank fusion. Neighboring source
fragments are candidates for context expansion. This encoder favors English;
Unicode BM25 also indexes Chinese terms. Pooling may dilute a small detail in a
large fragment. These are limitations to assess, not established optimal choices.

## Inspect results

The first completed full PeekaTrack run is recorded in
[PeekaTrack comparison results](peekatrack-comparison.md), including a source-based
review separate from the automated verifier.

Open `comparison.html` for all four complete outputs side by side. Switch between
final outputs and original drafts, or open one method in a wider reading view.
Click source IDs to inspect complete original messages. The output
directory also contains:

- `manifest.json`, `preflight.json`, `corpus.json`, `chunks.json`: frozen scope,
  source pointers, tokenizer identity, token counts, and complete chunk coverage.
- `comparison.md` and `comparison.json`: usage, runtime, word counts, verification
  counts, and source-reading coverage.
- One directory per method: `draft.md`, `narrative.md`, `draft.json`,
  `verification.json`, `coverage.json`, `prepared.json`, and `calls.jsonl`.
- `model-cache/`: exact prompts, responses, and provider-reported usage.
- Tree, retrieval, and recursive trace files for the relevant methods.

Per-method cost estimates count the unique calls recorded for that method, including
repairs, restarted attempts, and calls reused from another method. Total paid usage counts each saved HTTP response
once. Estimated Flash costs use the published peak/off-peak price range, not an
invoice. Transport failures can have unreported usage. Runtime includes cache
effects and sums execution attempts, so a warm hierarchy-plus-retrieval run is not
a cold runtime measurement. Shared capture and local indexing time is separate.
See [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).

Source coverage measures text read before verification. It does not measure
recall of important events. The same-model verifier is not independent ground
truth. Compare the full drafts as well as the filtered narratives and check
important decisions, reversals, unsupported outcomes, and missing work against
the originals. A failure remains a recorded failure; no shorter time window is
substituted.

## Research basis

The hierarchy follows the split-and-reduce principle in
[Summⁿ](https://arxiv.org/abs/2110.10150). The combined method borrows multilevel
navigation from [RAPTOR](https://arxiv.org/abs/2401.18059), but uses the originals
for final writing. The adaptive method borrows external context and recursive
subtasks from [Recursive Language Models](https://arxiv.org/abs/2512.24601).
The raw retrieval baseline tests whether those extra indexing and reasoning calls
earn their cost; [NavTree](https://arxiv.org/abs/2610.06902) provides a recent QA
example where summary-free navigation is competitive. These implementations are
task-specific experiments, not benchmark reproductions or proven winners.
