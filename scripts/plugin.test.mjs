import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import openCodeV1 from "../plugins/sessionlore/opencode.mjs";
import openCodeV2 from "../plugins/sessionlore/opencode-v2.mjs";

describe("OpenCode plugin registration", () => {
  it("adds an active-agent command without selecting a model and preserves user commands", async () => {
    const hooks = await openCodeV1();
    const config = { command: { other: { template: "existing" } } };
    await hooks.config(config);
    expect(config.command.other.template).toBe("existing");
    expect(config.command.sessionlore.model).toBeUndefined();
    const path = fileURLToPath(
      new URL("../plugins/sessionlore/skills/devlog/SKILL.md", import.meta.url),
    );
    expect(config.command.sessionlore.template).toContain(path);
    expect(await readFile(path, "utf8")).toContain("name: devlog");
    config.command.sessionlore = { template: "user override" };
    await hooks.config(config);
    expect(config.command.sessionlore.template).toBe("user override");
  });
  it("registers the same skill through the V2 skill API", async () => {
    const skills = [];
    await openCodeV2.setup({
      skill: {
        transform: async (edit) => edit({ add: (skill) => skills.push(skill) }),
      },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("sessionlore");
    expect(await readFile(skills[0].path, "utf8")).toContain(skills[0].content);
    expect(skills[0].model).toBeUndefined();
  });
});
