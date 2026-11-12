# Compare request-to-result retrieval with the current pipeline

This comparison keeps the full project capture, topic questions, Kimi model,
initial writer and 24,000-token source budget fixed. It saves three answers per
question:

| Variant | Retrieval | Answer processing |
| --- | --- | --- |
| current | Existing BM25 + MiniLM fragment ranking and immediate neighbors | One extraction call |
| request-result | Request episodes, actual replies, progress/final reports and supporting result records | The same extraction instruction and schema |
| checked | The same request-to-result evidence | Source-only detail checklist, answer revision and a separate final audit |

Only Kimi Code makes model calls. The existing local MiniLM index and local
DeepSeek tokenizer are reused; the tokenizer is a budgeting proxy, not a
DeepSeek API call. Kimi also enforces the existing conservative byte-based
context bound.

## Run

Set KIMI_CODE_API_KEY in the ignored root .env, then use an intact full-history
comparison capture:

~~~sh
pnpm cli compare-retrieval .sessionlore/peekatrack-full-deepseek-v1 \
  --cases .sessionlore/peekatrack-kimi-request-result-v1/benchmark.json \
  --provider kimi-code \
  --concurrency 2 \
  --timeout-ms 600000 \
  --out .sessionlore/peekatrack-kimi-request-result-v1
~~~

Add --prepare-only to build and inspect retrieval without model calls. Repeat the
same command and output path to resume completed stages. The manifest freezes
the corpus, questions, model configuration, algorithms, implementation hashes,
prompts, tokenizer and embedding identity. Changed settings require a new output
directory, except for an increased HTTP timeout. That transport-only change is
recorded in the manifest, preserves its previous version, and reuses completed
responses. The command rejects time filters and non-Kimi providers.
An explicit account-quota rejection stops further scheduling. Completed stages
remain reusable. Restore quota or wait for its reset before resuming; repeated
requests do not resolve an exhausted monthly allowance.

## Request and result selection

The index reassembles fragments of each original event, then divides each chat
at genuine user requests. Structured user replies stay with the request episode.
Recorded question answers, assistant reports, tool outputs and attempted actions
remain distinct. A bare accepted:true tool response means delivery acknowledgement,
not user permission.

Question/answer links use matching question text or structured answer keys.
Action/result adjacency is explicitly marked as a candidate relationship; it
does not prove an exact tool-call identity. The current frozen capture does not
retain that identity for every tool format.

All original fragments remain searchable. The selector combines:

- the existing full-corpus fragment ranking;
- a second hybrid ranking over requests, actual replies, questions and reports;
- lexical episode ranking over conversation text.

It selects up to six episodes across chats. Within them, requests, questions,
actual answers and progress/final reports take priority. Supporting tool results
before the latest reports, full-corpus search hits and preceding action context
fill the remaining budget. Matched question/reply pairs are expanded. Exact
duplicate text of the same source role is represented once, with aliases saved.

There is no elapsed-time cutoff. A result hours or days after a request remains
part of the episode. Records are supplied in timestamp order, preserving source
order within equal timestamps. Complete fragments are never shortened to fit.

“Request-to-result” does not mean every tool log fits one prompt. Outputs list
selected episodes, their full source membership, duplicate aliases, omitted
candidate IDs and omitted conversational records. These distinguish a structurally
indexed episode from the evidence actually supplied to Kimi.

## Missing-detail checks

A separate Kimi call builds a checklist from the selected originals and question,
without seeing the draft or evaluation criteria. It records source-linked
decisions, conditions, exclusions, values, sequence, exceptions, verification
scope, limitations and conflicts.

Each checklist item has short verbatim quote anchors. The runner checks that the
quotes occur in their cited originals and rejects invented anchors or unknown
source IDs. Quote matching verifies provenance, not semantic correctness.

Another call compares the initial answer with each checklist item and the
originals. It records missing or partial details and unsupported claims, then
returns a corrected answer. A final stateless call audits the corrected answer.
Every checklist ID must be assessed exactly once. Residual omissions or
contradictions produce a needs-review result; they are not silently counted as a
clean answer.

The final audit uses the same model, so it is not independent ground truth.
The comparison's source-based review grades actual saved answers separately.
The revision keeps the concise answer target but may use more words to preserve
material qualifications.

## Evidence and evaluation

The existing twelve PeekaTrack questions are reused. The placement case includes
the previously corrected later implementation and verification evidence. The
frozen evaluation contains 47 criteria. Expected answers, gold references and
rubrics never enter retrieval or any model prompt.

Outputs include comparison.html, answers.md, comparison.json, the frozen
benchmark, episode-index.json, per-case retrieval traces, source fragments,
initial answers, detail checklists, revisions, final audits and provider usage.
A separate review.md and grades.json can record source-based evaluation.

These are known diagnostic cases with supplied topic queries, not a held-out
test or automatic discovery of every project topic. Compare evidence recall,
answer coverage, unsupported claims, residual model-audit warnings, tokens and
elapsed time separately. All project-history artifacts stay local and ignored
by Git.
