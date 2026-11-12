# Contributing to Sessionlore

Use [GitHub issues](https://github.com/LabLambWorks/sessionlore/issues) for bug
reports and proposals. Include the host and version, expected behavior, observed
behavior, and a small synthetic or redacted reproduction. Do not attach raw
coding sessions, credentials, or private source code.

## Development

Use the pinned Node.js and pnpm versions:

```sh
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm demo
pnpm demo:approaches
```

The main plugin workflow lives in `plugins/sessionlore/skills/devlog` and
`packages/host-tools`. Source readers live in `packages/adapter-codex` and
`packages/adapter-transcripts`. `packages/experiments` contains optional
API-backed experiments and must stay outside the plugin runtime.

For a runtime or dependency change, refresh the committed distributable:

```sh
pnpm plugin:prepare-release
pnpm plugin:check
```

This bundles the runtime and copies it, the license, and dependency notices into
`plugins/sessionlore`. Commit those generated files with the source change. Do
not edit the generated runtime manually. `pnpm plugin:check` rebuilds and rejects
a stale distributable.

## Pull requests

Explain the problem, the resulting behavior, and how you checked it. Include a
regression fixture when changing transcript interpretation. Preserve source
pointers, human/agent attribution, malformed-record reporting, and original
evidence. Use synthetic fixtures by default. Describe the limits of live-version
testing instead of claiming compatibility from a fixture alone.

Plugin changes must keep model work in the host agent. Local tools must not load
provider credentials or make hidden generation calls. Citation validation checks
reference existence; it must not be described as proof of factual correctness.

By submitting a contribution, you agree that it is provided under this project's
[MIT license](LICENSE). Third-party material must retain its license and notices.
