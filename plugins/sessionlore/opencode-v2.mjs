import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** OpenCode V2 plugin definition. Skill execution stays in the active agent. */
export default {
  id: "sessionlore",
  async setup(ctx) {
    const path = fileURLToPath(
      new URL("./skills/devlog/SKILL.md", import.meta.url),
    );
    const content = (await readFile(path, "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "sessionlore",
        name: "Sessionlore",
        description:
          "Write source-linked engineering dev logs in the agent's voice.",
        path,
        content,
      });
    });
  },
};
