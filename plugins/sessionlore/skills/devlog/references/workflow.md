# Host-agent workflow

In the examples, `<tool>` is the absolute path to
`scripts/sessionlore-host.mjs` inside this installed skill. Quote paths in real
commands. `run` and `output` are new directories inside the current project.

```text
node <tool> sessions --host codex --project <project>
node <tool> prepare --host codex --input <rollout-or-directory> --out <run> --narrator Codex
node <tool> prepare --host claude --input <transcript-or-directory> --out <run> --narrator Claude
node <tool> prepare --host opencode --session <session-id> --project <project> --out <run> --narrator "OpenCode agent"
node <tool> read --run <run> --cursor 0
node <tool> read --run <run> --cursor <next_cursor>
node <tool> search --run <run> --query "test failure" --view all
node <tool> read --run <run> --refs <ref1>,<ref2>
node <tool> validate --run <run> --draft <run>/reviewed.json
node <tool> export --run <run> --draft <run>/reviewed.json --out <output>
```

For several selected files, copy them into a new staging directory under
`.sessionlore/` with unique filenames and prepare that directory. Keep the host
explicit; do not mix transcript formats in one run. A cross-host story requires
separate runs and separate attributed chapters in this release. Do not silently
omit another host's contribution or claim its work as your own.

Codex project discovery includes recorded Git worktrees. Claude project discovery
uses the exact recorded working directory. Use explicit paths for other worktrees.
OpenCode session listing depends on the installed CLI's scope; explicit exported
JSON is the fallback. If the source is unavailable or its format is unsupported,
report the gap rather than reconstructing a transcript from memory.

## Draft JSON

The prepared run includes the exact JSON schema. The narrator must match its
manifest. Replace the example reference below with real IDs returned by `read`.
Paragraph text is plain prose; the exporter supplies headings and citation links.

```json
{
  "title": "Revising the track upgrade",
  "narrator": { "host": "codex", "name": "Codex", "perspective": "agent" },
  "sections": [
    {
      "heading": "The change in direction",
      "paragraphs": [
        {
          "text": "You asked me to keep the existing track and add one block per upgrade.",
          "refs": ["REPLACE_WITH_RETURNED_SOURCE_ID"]
        }
      ]
    }
  ]
}
```

`read` returns exact source fragments, actors, timestamps, session IDs, and raw
snapshot pointers. Large messages are split without dropping text. Follow all
fragments of a relevant event when a qualification may cross a fragment boundary.
`search` returns shortened navigation excerpts and reports that they are truncated.
Use `read --refs` for the complete fragments. Pagination and search can be limited
to a session with `--thread`.

Conversation pages exclude thoughts, injected system/developer context, and bulk
execution output. Tool questions and structurally recognized user answers remain
available. `--view all` adds execution attempts and results for verification; the
raw snapshots retain all original records. OpenCode export pointers cover the
export document, with original message/part IDs identifying the cited record.

Before export, compare each paragraph with its citations. Search for later changes
and distinguish “I reported that tests passed” from a directly recorded test result.
Do not infer the human's approval from a question, a proposal, or a tool result.
Review coverage against the outline and retained notes. Mechanical validation
cannot establish truth or prove the prose uses the right perspective.

The output contains `devlog.md`, `devlog.html`, `sources.md`, `sources.json`, the
reviewed draft, provenance, and validation results. Source content is included in
the local output. Keep the source bundle private unless the user asks to share it
and has reviewed what it contains.
