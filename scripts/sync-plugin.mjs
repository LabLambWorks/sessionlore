import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const files = [
  "skills/devlog/scripts/sessionlore-host.mjs",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
for (const file of files) {
  const built = join(root, "dist/plugins/sessionlore", file);
  const distributed = join(root, "plugins/sessionlore", file);
  if (check) {
    let current;
    try {
      current = await readFile(distributed);
    } catch {
      /* Missing generated file is a stale package. */
    }
    if (!current?.equals(await readFile(built)))
      throw new Error(
        `Stale plugin file: ${file}. Run pnpm plugin:prepare-release and commit the generated files.`,
      );
  } else {
    await mkdir(dirname(distributed), { recursive: true });
    await copyFile(built, distributed);
  }
}
process.stdout.write(
  check
    ? "Committed plugin matches the source build.\n"
    : "Updated committed plugin runtime and notices.\n",
);
