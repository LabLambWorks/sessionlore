import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** OpenCode V1: a command prompts the active agent; no provider is called here. */
export default async function SessionlorePlugin() {
  const path = fileURLToPath(
    new URL("./skills/devlog/SKILL.md", import.meta.url),
  );
  const skill = await readFile(path, "utf8");
  return {
    config: async (config) => {
      config.command ??= {};
      if (config.command.sessionlore) return;
      config.command.sessionlore = {
        description:
          "Write a source-linked dev log from the agent's perspective",
        template: `Use the Sessionlore skill at ${path}. You are the OpenCode host agent. Follow the user's scope below.\n\n${skill.replace(/^---\n[\s\S]*?\n---\n/, "")}\n\nUser request: $ARGUMENTS`,
      };
    },
  };
}
