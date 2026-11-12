# Conversation as the primary input

The raw Codex trace is an archive, not the text every model stage must read.
New `run` and `compare` jobs default to `--evidence-view conversation`.

The primary input retains full user messages, assistant replies, clarification
questions and their recorded answers. Structured answers that arrive through a
tool result are still user answers. A question-delivery acknowledgement is not
an answer. The selector reassembles split records before classifying them and
does not remove distinct messages merely because their wording repeats.

Execution commands, bulk tool output, internal reasoning and injected developer
instructions stay in `corpus.json` and the original raw capture. The selected
input is saved separately as `primary-corpus.json`. Explicitly supplied artifacts
remain primary input; selecting a project no longer adds tool-derived artifacts
automatically. `--session-artifacts` remains an explicit opt-in.

An assistant's completion message remains an attributed report. If a claim
needs direct proof, `readArchivedEvidence` reads explicitly selected original
source IDs under a total size bound. This is a local lookup primitive; automatic
claim-driven tool retrieval is not implemented by this change. It does not run a
second model or inject every tool result into the prompt.

## PeekaTrack measurement

The frozen project capture contains 9,948 text fragments and 26,872,936 UTF-16
code units. Tool calls and results account for about 93.5% of its text. Injected
developer messages account for another 5%.

The conversation view retains 553 records and 270,622 code units, about 1% of
the original volume. It includes all 50 request records, 410 assistant messages,
50 clarification-question records and 43 recorded answers in that capture.
There is no time window and no content truncation.

The existing local tokenizer estimates 58,253 tokens for the text and 78,454
tokens for the compact prompt format with provenance metadata. These are proxy
counts, not exact Kimi token counts. This measurement used no API calls.

The compact file groups records by chat. A shared column definition replaces
repeated metadata keys, while each record retains source IDs, role, timestamp
and full original text. Source locators remain in `primary-corpus.json` and the
raw capture. The existing experiment stages still use their original per-record
prompt format; the compact file is prepared for a simpler subsequent baseline.

## Prepare without API usage

~~~sh
pnpm cli prepare-conversation .sessionlore/peekatrack-full-deepseek-v1 \
  --out .sessionlore/peekatrack-conversation-v1
~~~

This verifies the frozen corpus hash, rejects time-filtered captures, and writes
`conversation.json`, `primary-corpus.json` and `preflight.json`. No API key or
remote embedding model is needed.

Use a new output directory for a new `compare` run. Its manifest records the
input view so cached results from a raw-trace experiment cannot be mixed with
conversation-based results. Historical diagnostic and retrieval-comparison
commands retain their frozen experimental definitions; they are not the default
narrative path. Existing paid results have not been overwritten or rerun.

The initial Kimi test read all 553 records for one diagnostic question. It used
75,164 input tokens and 2,567 output tokens. This established that the full
conversation fits in one request, but the answer omitted a later construction
change and did not establish the actual coordination approval. This is one
known-case result, not an overall quality score.

`scripts/write-conversation.mjs` runs the full-project narrative path: one writing
call, local retrieval of bounded execution records, and one review/revision call.
The complete conversation remains in both calls. Retrieval queries come from the
generated draft; no benchmark answers or gold source IDs enter either call.
Raw tool results remain out of the initial writing input. Both narrative versions,
source records, retrieval omissions and provider usage are retained. This is a
separate full-conversation method; it does not silently change the historical
four-method comparison or the frozen question-answer experiments.
