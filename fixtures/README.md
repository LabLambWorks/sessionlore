# Fixtures

These are synthetic inputs. They contain no private session history or credentials.
`codex/v1` versions the fixture format, not a supported Codex release. Installed-version
compatibility has not been established.

The compressed fixture contains the exact bytes of `rollout-basic.jsonl`. If you edit
that file, regenerate its compressed copy from the repository root:

```sh
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {zstdCompressSync} from "node:zlib"; const p="fixtures/codex/v1/rollout-basic.jsonl"; writeFileSync(p+".zst",zstdCompressSync(readFileSync(p)));'
```

The malformed-tail fixture intentionally ends without a newline or a complete JSON
object. Do not repair it. Add a new fixture version when changing normalization
expectations. Use consented, scrubbed transcripts to establish compatibility before
claiming support for a specific agent release.
