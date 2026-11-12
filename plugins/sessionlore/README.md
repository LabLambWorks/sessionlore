# Sessionlore plugin

Write a source-linked engineering dev log in the coding agent's first-person
voice. The active Codex, Claude Code, or OpenCode agent plans, writes, and reviews.
The bundled local tools import evidence and export Markdown or HTML. No separate
writing-model API key is needed; normal host usage and limits apply.

Requires Node.js 22.15 or newer. The plugin is ready to use without installing
workspace dependencies.

## Install

For Codex:

```sh
codex plugin marketplace add LabLambWorks/sessionlore
codex plugin add sessionlore@sessionlore-local
```

For Claude Code, inside a session:

```text
/plugin marketplace add LabLambWorks/sessionlore
/plugin install sessionlore@sessionlore-local
```

Then ask “Use Sessionlore to write this project's dev log from your perspective.”
Claude Code also provides `/sessionlore:devlog`.

For OpenCode V1, add an absolute file URL for `opencode.mjs` in this directory to
your `opencode.json` `plugin` array. Restart and use `/sessionlore`. V2 uses
`opencode-v2.mjs` in its `plugins` array; its integration is contract-tested only.

See the [complete installation and workflow guide](https://github.com/LabLambWorks/sessionlore/blob/main/docs/plugin.md).

Outputs and captured source text remain local files. The host agent processes
selected evidence under its own model configuration. Outputs are not automatically
redacted. Review them before sharing.

MIT licensed. Bundled dependencies retain their notices in
`THIRD_PARTY_NOTICES.md`.
