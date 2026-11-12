# Experiment fixtures

All records and artifacts are synthetic. These fixtures exercise orchestration;
they do not establish model quality or compatibility with an installed Codex version.

The sessions contain interleaved cache and documentation work, an abandoned TTL
attempt, a decision to use LRU, a passing test followed by another edit, an explicit
cross-thread continuation, and an unresolved investigation with no artifact.

When reviewing real model output, check these facts:

- The webhook documentation task is separate from cache work.
- The 500-entry test result predates the 600-entry edit. Only the follow-up test
  supports a passing result for the 600-entry cache.
- The TTL trial failed the memory bound. It was replaced by LRU.
- The documentation PR is open. It does not prove a merge or runtime change.
- The signature investigation has an unknown cause and made no code change.
- No source proves production performance or deployment.

The artifact approach has no direct artifact for the abandoned investigation.
Inspect its unmatched conversation list to see whether it misses that work.
