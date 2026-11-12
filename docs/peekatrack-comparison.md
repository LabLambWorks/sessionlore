# Full PeekaTrack comparison: first completed run

All four methods completed with `deepseek-flash` on the same frozen history:
23 chats, 26 source files, 9,948 normalized text fragments, and 9,464,099
projected input tokens. No time filter was used. Images and audio were retained
in the raw archive but not interpreted by the text pipelines.

- [Side-by-side narratives and original citations](../.sessionlore/peekatrack-full-deepseek-v1/comparison.html)
- [Source-based review and checkpoint details](../.sessionlore/peekatrack-full-deepseek-v1/review.md)
- [Usage, cost, runtime, and automated verification](../.sessionlore/peekatrack-full-deepseek-v1/comparison.md)
- [Scaling audit](../.sessionlore/peekatrack-full-deepseek-v1/scaling-audit.json)

These artifacts are local and ignored by git because they contain chat history.
Use [the run instructions](long-history.md) to reproduce the experiment.

## Observed results

Twenty user-decision checkpoints were selected before the narratives were
generated and were not supplied to the pipelines. The table records Codex review
of the full drafts against those sources. It is not human ground truth, exhaustive
event recall, or a factual-accuracy score.

| Method | Covered / partial / missing | Draft words | Source text read |
| --- | ---: | ---: | ---: |
| Raw hybrid retrieval | 10 / 6 / 4 | 2,635 | 2.3% |
| Summary-only hierarchy | 3 / 5 / 12 | 1,836 | 100% |
| Hierarchy + original-source retrieval | 3 / 4 / 13 | 2,271 | 100% |
| Adaptive recursive reader | 5 / 6 / 9 | 2,670 | 3.8% |

Raw hybrid retrieval covered the most selected decisions but missed the final
successful railway checks and described the outcome as unresolved. The adaptive
reader recovered that ending and the train-audio verification limits, but omitted
several middle-stage decisions and reopened settled product questions.

Both hierarchy methods processed all 660 chunks. During reduction, late
workstreams lost their source-linked facts; the outline then omitted them.
Retrieving original evidence for that same outline did not recover the topics.
Full processing coverage therefore did not produce full narrative coverage.

The adaptive controller used all sixteen steps on searches, with note compaction.
It did not select its chunk-read or recursive-delegation tools. Child readers are
implemented and tested, but this real run does not establish their benefit.

The same-model verifier accepted some stale outcomes and rejected some supported
claims. Its acceptance counts must not be used as the main quality ranking.

## Recommendation and limits

Keep raw hybrid retrieval as the baseline and test a workstream ledger with
mandatory searches for later outcomes and reversals. Plan from that ledger before
retrieving originals for writing. Neither current retrieval method produced a
reliable complete history; the hierarchy variants do not justify their extra cost
in this run.

Saved paid responses cost an estimated $4.05–$8.11 using the published DeepSeek
peak/off-peak rates. One attempt has unreported usage. This is not an invoice;
per-method totals include shared cached calls and must not be added together.
Repairs, resumed calls, shared indexing, and unequal output lengths prevent a
clean speed or cost benchmark.

`pnpm check` passed lint, type checks, builds, and 43 tests. Browser checks passed
for method selection, full/filtered drafts, source citations, and console errors.
This is one project and one realized run per method. The detailed review links
each material finding to original evidence.
