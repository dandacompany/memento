import { describe, expect, test } from "vitest";

import {
  normalizeResourceSlug,
  resourceGroupKey,
  resourceGroupKeyForDoc,
} from "../../src/core/resource-identity.js";
import type { ResourceDoc } from "../../src/core/resource-types.js";

describe("resource identity", () => {
  test("resourceGroupKey includes kind, scope, and identity", () => {
    expect(
      resourceGroupKey({
        kind: "mcp",
        scope: "local",
        identityKey: "mcp:playwright",
      }),
    ).toBe("mcp/local/mcp:playwright");
  });

  test("resourceGroupKeyForDoc derives a key from doc metadata", () => {
    const doc: ResourceDoc = {
      kind: "skill",
      body: { type: "skill-bundle", files: [] },
      meta: {
        provider: "codex",
        scope: "project",
        tier: "project",
        identityKey: "skill:review",
        sourcePath: "/repo/.agents/skills/review",
        sourceFormat: "directory",
        sensitive: false,
        redactions: [],
        mtime: 100,
        bodyHash: "body",
        rawHash: "raw",
      },
    };

    expect(resourceGroupKeyForDoc(doc)).toBe("skill/project/skill:review");
  });

  test.each([
    ["Review", "review"],
    ["Code Review", "code-review"],
    ["  MCP: GitHub  ", "mcp-github"],
    ["already_ok.1", "already_ok.1"],
  ])("normalizeResourceSlug(%s)", (input, expected) => {
    expect(normalizeResourceSlug(input)).toBe(expected);
  });
});
