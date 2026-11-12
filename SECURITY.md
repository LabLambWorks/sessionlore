# Reporting security issues

Please use [GitHub private vulnerability reporting](https://github.com/LabLambWorks/sessionlore/security/advisories/new)
for issues that could expose session contents, execute transcript instructions,
or cause an unexpected network request. Include the affected version, reproduction
steps, and a synthetic example. Do not include real credentials or private chat
history in a public issue.

Sessionlore is an early release. Fixes target the latest version; there is no
guaranteed response time or support window.

## Data boundaries

The plugin tools read local sources and create local files. The host agent reads
the selected evidence, so the host's model configuration and data policies apply.
The optional API-backed experiments send selected evidence to their configured
provider and are separate from the plugin.

Captured archives and exported source bundles can contain sensitive information.
They are not automatically redacted. `.sessionlore/` and `.env` are ignored by Git;
custom output directories need the same care. Review generated content and its
source bundle before publishing it.
