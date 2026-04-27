import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { AdapterError } from "../../src/core/errors.js";
import { applyOverrides, deriveIdentityKey } from "../../src/core/identity.js";
import type { ProviderId, Subtype, Tier } from "../../src/core/types.js";

interface Case {
  name: string;
  provider: ProviderId;
  filePath: string;
  tier: Tier;
  subtype: Subtype;
  identityKey: string;
}

const home = os.homedir();
const root = path.join(os.tmpdir(), "memento-project");

const cases: Case[] = [
  {
    name: "claude project agents file",
    provider: "claude-code",
    filePath: path.join(root, "CLAUDE.md"),
    tier: "project",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "claude local agents file",
    provider: "claude-code",
    filePath: path.join(root, "CLAUDE.local.md"),
    tier: "project-local",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "claude global agents file",
    provider: "claude-code",
    filePath: path.join(home, ".claude", "CLAUDE.md"),
    tier: "global",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "codex project agents file",
    provider: "codex",
    filePath: path.join(root, "AGENTS.md"),
    tier: "project",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "codex local agents file",
    provider: "codex",
    filePath: path.join(root, "AGENTS.local.md"),
    tier: "project-local",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "codex global agents file",
    provider: "codex",
    filePath: path.join(home, ".codex", "AGENTS.md"),
    tier: "global",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "gemini project agents file",
    provider: "gemini-cli",
    filePath: path.join(root, "GEMINI.md"),
    tier: "project",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "gemini local agents file",
    provider: "gemini-cli",
    filePath: path.join(root, "GEMINI.local.md"),
    tier: "project-local",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "gemini global agents file",
    provider: "gemini-cli",
    filePath: path.join(home, ".gemini", "GEMINI.md"),
    tier: "global",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "antigravity project skill",
    provider: "antigravity",
    filePath: path.join(root, ".agent", "skills", "git-flow", "SKILL.md"),
    tier: "project",
    subtype: "skill",
    identityKey: "skill:git-flow",
  },
  {
    name: "antigravity project memory bank",
    provider: "antigravity",
    filePath: path.join(root, "memory-bank", "core", "state.md"),
    tier: "project",
    subtype: "memory-bank",
    identityKey: "memory-bank:core/state",
  },
  {
    name: "antigravity local memory bank",
    provider: "antigravity",
    filePath: path.join(root, "memory-bank", "core", "state.local.md"),
    tier: "project-local",
    subtype: "memory-bank",
    identityKey: "memory-bank:core/state",
  },
  {
    name: "antigravity global skill",
    provider: "antigravity",
    filePath: path.join(
      home,
      ".gemini",
      "antigravity",
      "skills",
      "git-flow",
      "SKILL.md",
    ),
    tier: "global",
    subtype: "skill",
    identityKey: "skill:git-flow",
  },
  {
    name: "cursor project rule",
    provider: "cursor",
    filePath: path.join(root, ".cursor", "rules", "typescript.mdc"),
    tier: "project",
    subtype: "rule",
    identityKey: "rule:typescript",
  },
  {
    name: "cursor local rule",
    provider: "cursor",
    filePath: path.join(root, ".cursor", "rules", "typescript.local.mdc"),
    tier: "project-local",
    subtype: "rule",
    identityKey: "rule:typescript",
  },
  {
    name: "cursor global rule",
    provider: "cursor",
    filePath: path.join(home, ".cursor", "rules", "typescript.mdc"),
    tier: "global",
    subtype: "rule",
    identityKey: "rule:typescript",
  },
  {
    name: "cursor legacy project rule",
    provider: "cursor",
    filePath: path.join(root, ".cursorrules"),
    tier: "project",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "cursor legacy local rule",
    provider: "cursor",
    filePath: path.join(root, ".cursorrules.local"),
    tier: "project-local",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "windsurf project rule",
    provider: "windsurf",
    filePath: path.join(root, ".windsurf", "rules", "typescript.md"),
    tier: "project",
    subtype: "rule",
    identityKey: "rule:typescript",
  },
  {
    name: "windsurf local rule",
    provider: "windsurf",
    filePath: path.join(root, ".windsurf", "rules", "typescript.local.md"),
    tier: "project-local",
    subtype: "rule",
    identityKey: "rule:typescript",
  },
  {
    name: "windsurf global rule",
    provider: "windsurf",
    filePath: path.join(home, ".windsurf", "rules", "typescript.md"),
    tier: "global",
    subtype: "rule",
    identityKey: "rule:typescript",
  },
  {
    name: "windsurf legacy project rule",
    provider: "windsurf",
    filePath: path.join(root, ".windsurfrules"),
    tier: "project",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "windsurf legacy local rule",
    provider: "windsurf",
    filePath: path.join(root, ".windsurfrules.local"),
    tier: "project-local",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
  {
    name: "global antigravity shared gemini file",
    provider: "antigravity",
    filePath: path.join(home, ".gemini", "GEMINI.md"),
    tier: "global",
    subtype: "agents-md",
    identityKey: "agents-md:main",
  },
];

describe("identity", () => {
  test.each(cases)(
    "$name",
    ({ provider, filePath, tier, subtype, identityKey }) => {
      expect(deriveIdentityKey(filePath, provider)).toEqual({
        tier,
        subtype,
        identityKey,
      });
    },
  );

  test("unmatched path throws AdapterError", () => {
    expect(() =>
      deriveIdentityKey(path.join(root, "README.md"), "codex"),
    ).toThrow(AdapterError);
  });

  test("applyOverrides returns key with no mapping", () => {
    expect(applyOverrides("rule:typescript")).toBe("rule:typescript");
  });

  test("applyOverrides returns key with empty mapping", () => {
    expect(applyOverrides("rule:typescript", {})).toBe("rule:typescript");
  });

  test("applyOverrides returns exact override key", () => {
    expect(
      applyOverrides("rule:ts", {
        "rule:ts": ["cursor:.cursor/rules/typescript.mdc"],
      }),
    ).toBe("rule:ts");
  });

  test("applyOverrides maps alias to override key", () => {
    expect(
      applyOverrides("cursor:.cursor/rules/typescript.mdc", {
        "rule:ts": ["cursor:.cursor/rules/typescript.mdc"],
      }),
    ).toBe("rule:ts");
  });

  test("applyOverrides leaves mapping miss unchanged", () => {
    expect(
      applyOverrides("rule:typescript", {
        "rule:go": ["cursor:.cursor/rules/go.mdc"],
      }),
    ).toBe("rule:typescript");
  });
});
