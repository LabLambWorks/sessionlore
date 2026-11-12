# Separate extraction from retrieval

The diagnostic compares the same questions under two conditions:

1. **Selected originals:** supply the original messages chosen for the evaluation.
2. **Retrieved originals:** search the entire frozen project with topic queries,
   then supply the selected fragments to the same extractor.

Both providers receive identical evidence within each condition. The questions,
queries, original-source references, and evaluation criteria are frozen before
the run. The criteria and selected source IDs never enter retrieval or extraction
prompts. The second condition does not reuse the first condition's answers or
conversation state.

## Kimi Code configuration

Kimi Code is the default provider for new `run` and `compare` commands. It uses
`k3.1-pro`, high reasoning effort, JSON-object output, and a 16,384-token completion
limit including reasoning. Set the subscription key in the ignored `.env`:

```dotenv
KIMI_CODE_API_KEY=
DEEPSEEK_API_KEY=
```

Kimi Code uses `https://api.kimi.com/coding/v1`. Its subscription key is separate
from a Moonshot pay-as-you-go API key. The transport identifies itself as
`sessionlore/0.1.0`; it does not impersonate another client. The model ID and
reasoning configuration follow the [Kimi Code model reference](https://www.kimi.com/code/docs/en/kimi-code/models).
Provider-returned model IDs and token usage are retained. Kimi usage is reported
as subscription consumption, without inventing a per-call dollar price.
Kimi responses stream through the final usage event. Reasoning deltas are not
retained. This avoids waiting for the entire answer before any response data
arrives. Failed network attempts remain visible in usage totals after a resume;
their unreported usage is not assumed to be zero.

The shared local tokenizer remains the official DeepSeek tokenizer, so its counts
are a budget proxy for Kimi. Kimi requests also apply a conservative UTF-8-byte
upper bound, including output and framing, against a 262,144-token context limit.
This may reject an input that would fit; it never silently truncates it.

## Run the PeekaTrack diagnostic

```sh
pnpm cli diagnose .sessionlore/peekatrack-full-deepseek-v1 \
  --cases .sessionlore/peekatrack-diagnostic-v1/benchmark.json \
  --providers deepseek,kimi-code \
  --concurrency 2 \
  --out .sessionlore/peekatrack-diagnostic-v1
```

The first argument is an existing complete `compare` capture. The diagnostic
checks its corpus hash and rejects a time-filtered capture. All 9,948 PeekaTrack
fragments are searchable; it reuses the local embedding cache from the capture.
Each question uses the existing BM25 + MiniLM selection code with a 24,000-token
budget, no gold-source seeds, and neighboring-fragment expansion. This tests
retrieval for known topics; it does not test automatic discovery of every topic.

The default provider models are DeepSeek Flash in non-thinking mode and Kimi Code
K3.1 Pro with high reasoning. This is a comparison of those configurations, not an
equal-compute isolation of model architecture.

Repeat the same command to resume. Changed evidence, questions, queries, model
settings, tokenizer, or prompts require a new output directory. Successful calls
and model responses are saved before validation, including JSON repair attempts.

Outputs include `comparison.html`, `answers.md`, `diagnostic.json`, frozen
evaluation criteria, retrieval rankings and omissions, original source fragments,
and per-model responses. `review.md` and `grades.json` record the separate
source-based assessment when one is performed. These artifacts contain private
history and remain ignored by git.

Evidence-group recall accepts selected IDs or fragments with exactly identical
text. It can miss equivalent evidence phrased differently, so it is not answer
accuracy. Assess facts, chronology, source attribution, limitations, and missing
requirements separately. The twelve initial cases include known failures from
the earlier comparison; they are diagnostic cases, not a held-out benchmark.

## Recorded PeekaTrack result

The local run completed 48 answers across twelve cases and both providers.
Retrieval found 25 of 38 preselected evidence groups. Both models reconstructed
the train-audio implementation from supplied originals, then missed that outcome
when retrieval omitted the final report. Both also omitted some qualifications
with the correct sources already present.

Review found one incomplete answer key: the placement case omitted a later
conflicting implementation. Its original benchmark remains frozen; a separate
four-answer adjudication adds the missing originals. The eleven remaining cases
contain 42 criteria: DeepSeek covered 36 with supplied originals and 28 with
retrieved originals; Kimi covered 37 and 28. These are diagnostic coverage counts,
not general accuracy scores or a model ranking.

The ignored local artifacts contain the
[source-based review](../.sessionlore/peekatrack-diagnostic-v1/review.md),
[interactive comparison](../.sessionlore/peekatrack-diagnostic-v1/comparison.html),
and [placement correction](../.sessionlore/peekatrack-placement-adjudication-v2/review.md).
