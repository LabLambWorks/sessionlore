import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "plugins", "sessionlore");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, "plugins", "sessionlore"), output, { recursive: true });
const bundled = await build({
  entryPoints: [join(root, "packages/host-tools/src/cli.ts")],
  outfile: join(output, "skills/devlog/scripts/sessionlore-host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  metafile: true,
  legalComments: "eof",
});
// Fail packaging if model transports or the legacy experiment runtime leak in.
const forbidden = Object.keys(bundled.metafile.inputs).filter((path) =>
  /packages\/experiments|huggingface|onnxruntime|openai\/|anthropic\//.test(
    path,
  ),
);
if (forbidden.length)
  throw new Error(
    `Plugin must contain only local evidence tools: ${forbidden.join(", ")}`,
  );
const manifest = JSON.parse(
  await readFile(join(output, "plugin.json"), "utf8"),
);
await cp(join(root, "LICENSE"), join(output, "LICENSE"));
const zodLicense = await readFile(
  join(root, "packages/host-tools/node_modules/zod/LICENSE"),
  "utf8",
);
await writeFile(
  join(output, "THIRD_PARTY_NOTICES.md"),
  `# Bundled third-party software\n\nThe Sessionlore plugin bundles Zod, licensed under MIT.\nSource: https://github.com/colinhacks/zod\n\n${zodLicense}`,
);
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: "sessionlore-plugin",
      version: manifest.version,
      description: manifest.description,
      license: "MIT",
      repository: {
        type: "git",
        url: "https://github.com/LabLambWorks/sessionlore.git",
      },
      homepage: "https://github.com/LabLambWorks/sessionlore#readme",
      bugs: { url: "https://github.com/LabLambWorks/sessionlore/issues" },
      type: "module",
      engines: { node: ">=22.15.0" },
      exports: { ".": "./opencode.mjs", "./v2": "./opencode-v2.mjs" },
      bin: {
        "sessionlore-host": "./skills/devlog/scripts/sessionlore-host.mjs",
      },
      files: [
        "plugin.json",
        ".codex-plugin",
        ".claude-plugin",
        "skills",
        "opencode.mjs",
        "opencode-v2.mjs",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "README.md",
      ],
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(output, "build-manifest.json"),
  JSON.stringify(
    {
      version: manifest.version,
      generation: "host-agent",
      inputs: Object.keys(bundled.metafile.inputs),
      bundled_external_dependencies: [],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(output + "\n");
