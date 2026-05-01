import { describe, expect, test } from "vitest";

import { memoryDocToResourceDoc } from "../../src/core/resource-types.js";
import type { MemoryDoc } from "../../src/core/types.js";

describe("resource types", () => {
  test("memoryDocToResourceDoc preserves memory metadata", () => {
    const memoryDoc: MemoryDoc = {
      body: "# Instructions\n",
      meta: {
        tier: "project",
        identityKey: "agents-md:main",
        subtype: "agents-md",
        source: "codex",
        sourcePath: "/repo/AGENTS.md",
        mtime: 123,
        bodyHash: "body-hash",
        rawHash: "raw-hash",
        title: "Instructions",
        tags: ["sync"],
      },
    };

    expect(memoryDocToResourceDoc(memoryDoc, "local")).toEqual({
      kind: "memory",
      body: "# Instructions\n",
      meta: {
        provider: "codex",
        scope: "local",
        tier: "project",
        identityKey: "agents-md:main",
        sourcePath: "/repo/AGENTS.md",
        sourceFormat: "markdown",
        sensitive: false,
        redactions: [],
        mtime: 123,
        bodyHash: "body-hash",
        rawHash: "raw-hash",
        title: "Instructions",
        tags: ["sync"],
        writeable: true,
      },
    });
  });
});
