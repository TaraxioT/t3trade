import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerSkillItemId,
  isSameComposerSkill,
  normalizeSkillPath,
  skillPathContext,
} from "./composerSkillIdentity";

const provider = ProviderDriverKind.make("codex");

describe("composerSkillIdentity (10B)", () => {
  it("normalizes path separators", () => {
    expect(normalizeSkillPath("a\\b\\c.md")).toBe("a/b/c.md");
  });

  it("derives identity from provider + name + normalized path", () => {
    expect(
      composerSkillItemId({ provider, skill: { name: "review", path: "user/review/SKILL.md" } }),
    ).toBe(`skill:codex:review:user/review/SKILL.md`);
    expect(
      composerSkillItemId({ provider, skill: { name: "review", path: "user\\review\\SKILL.md" } }),
    ).toBe(
      composerSkillItemId({ provider, skill: { name: "review", path: "user/review/SKILL.md" } }),
    );
  });

  it("same name on different paths is NOT the same skill", () => {
    const user = { provider, skill: { name: "review", path: "~/.agent/skills/review/SKILL.md" } };
    const workspace = {
      provider,
      skill: { name: "review", path: "/repo/.agent/skills/review/SKILL.md" },
    };
    expect(isSameComposerSkill(user, workspace)).toBe(false);
    expect(composerSkillItemId(user)).not.toBe(composerSkillItemId(workspace));
  });

  it("identical provider/name/path (separator-insensitive) IS the same skill", () => {
    expect(
      isSameComposerSkill(
        { provider, skill: { name: "review", path: "a/b" } },
        { provider, skill: { name: "review", path: "a\\b" } },
      ),
    ).toBe(true);
  });

  it("different providers with the same name and path are distinct", () => {
    const codex = { provider, skill: { name: "review", path: "a/b" } };
    const claude = {
      provider: ProviderDriverKind.make("claudeAgent"),
      skill: { name: "review", path: "a/b" },
    };
    expect(isSameComposerSkill(codex, claude)).toBe(false);
  });

  it("path context keeps the distinguishing tail segments", () => {
    expect(skillPathContext("/repo/.agent/skills/review/SKILL.md")).toBe("review/SKILL.md");
    expect(skillPathContext("a/b/c/d.md", 3)).toBe("b/c/d.md");
  });
});
