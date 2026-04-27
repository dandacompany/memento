import { describe, expect, test, vi } from "vitest";

import { ConflictError } from "../../src/core/errors.js";
import { resolveGroup, type ResolveOptions } from "../../src/core/resolver.js";
import type { MemoryDoc, ProviderId } from "../../src/core/types.js";

type PromptUser = NonNullable<ResolveOptions["promptUser"]>;

function memoryDoc(
  source: ProviderId,
  bodyHash: string,
  mtime: number,
): MemoryDoc {
  return {
    body: `body:${bodyHash}`,
    meta: {
      tier: "project",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source,
      sourcePath: `/repo/${source}/AGENTS.md`,
      mtime,
      bodyHash,
      rawHash: `raw:${bodyHash}:${source}`,
    },
  };
}

const prev = {
  bodyHash: "prev",
  mtime: 100,
};

describe("resolveGroup", () => {
  describe("3x3 case and strategy matrix", () => {
    const identicalDocs = [
      memoryDoc("codex", "same", 200),
      memoryDoc("claude-code", "same", 300),
    ];

    const propagatedDocs = [
      memoryDoc("codex", "prev", 200),
      memoryDoc("claude-code", "changed", 300),
    ];

    const conflictDocs = [
      memoryDoc("codex", "changed-a", 200),
      memoryDoc("claude-code", "changed-b", 300),
    ];

    test.each(["lww", "prompt", "fail"] satisfies ResolveOptions["strategy"][])(
      "identical + %s returns identical",
      async (strategy) => {
        const promptUser = vi.fn<PromptUser>();

        await expect(
          resolveGroup(identicalDocs, prev, {
            strategy,
            isTTY: true,
            promptUser,
          }),
        ).resolves.toEqual({
          doc: identicalDocs[0],
          status: "identical",
        });
        expect(promptUser).not.toHaveBeenCalled();
      },
    );

    test.each(["lww", "prompt", "fail"] satisfies ResolveOptions["strategy"][])(
      "propagated + %s returns changed doc",
      async (strategy) => {
        const promptUser = vi.fn<PromptUser>();

        await expect(
          resolveGroup(propagatedDocs, prev, {
            strategy,
            isTTY: true,
            promptUser,
          }),
        ).resolves.toEqual({
          doc: propagatedDocs[1],
          status: "propagated",
        });
        expect(promptUser).not.toHaveBeenCalled();
      },
    );

    test("true conflict + lww returns max mtime doc", async () => {
      await expect(
        resolveGroup(conflictDocs, prev, {
          strategy: "lww",
          isTTY: true,
        }),
      ).resolves.toEqual({
        doc: conflictDocs[1],
        status: "lww-resolved",
      });
    });

    test("true conflict + prompt returns prompt-selected doc", async () => {
      const promptUser = vi.fn<PromptUser>().mockResolvedValue(conflictDocs[0]);

      await expect(
        resolveGroup(conflictDocs, prev, {
          strategy: "prompt",
          isTTY: true,
          promptUser,
        }),
      ).resolves.toEqual({
        doc: conflictDocs[0],
        status: "prompt-resolved",
      });
      expect(promptUser).toHaveBeenCalledWith({
        key: "project/agents-md:main",
        candidates: conflictDocs,
        cachePrev: prev,
      });
    });

    test("true conflict + fail throws ConflictError with group", async () => {
      await expect(
        resolveGroup(conflictDocs, prev, {
          strategy: "fail",
          isTTY: true,
        }),
      ).rejects.toMatchObject({
        name: "ConflictError",
        code: "CONFLICT",
        groups: [
          {
            key: "project/agents-md:main",
            candidates: conflictDocs,
            cachePrev: prev,
          },
        ],
      });
    });
  });

  test("prompt strategy in non-TTY falls back to lww", async () => {
    const docs = [
      memoryDoc("codex", "changed-a", 200),
      memoryDoc("claude-code", "changed-b", 300),
    ];
    const promptUser = vi.fn<PromptUser>().mockResolvedValue(docs[0]);

    await expect(
      resolveGroup(docs, prev, {
        strategy: "prompt",
        isTTY: false,
        promptUser,
      }),
    ).resolves.toEqual({
      doc: docs[1],
      status: "lww-resolved",
    });
    expect(promptUser).not.toHaveBeenCalled();
  });

  test("prompt strategy without promptUser falls back to lww", async () => {
    const docs = [
      memoryDoc("codex", "changed-a", 200),
      memoryDoc("claude-code", "changed-b", 300),
    ];

    await expect(
      resolveGroup(docs, prev, {
        strategy: "prompt",
        isTTY: true,
      }),
    ).resolves.toEqual({
      doc: docs[1],
      status: "lww-resolved",
    });
  });

  test("promptUser returning null skips the conflict group", async () => {
    const docs = [
      memoryDoc("codex", "changed-a", 200),
      memoryDoc("claude-code", "changed-b", 300),
    ];
    const promptUser = vi.fn<PromptUser>().mockResolvedValue(null);

    await expect(
      resolveGroup(docs, prev, {
        strategy: "prompt",
        isTTY: true,
        promptUser,
      }),
    ).resolves.toEqual({
      doc: null,
      status: "skipped",
    });
  });

  test("missing cachePrev with differing bodies is treated as true conflict", async () => {
    const docs = [
      memoryDoc("codex", "first-sync-a", 200),
      memoryDoc("claude-code", "first-sync-b", 300),
    ];

    await expect(
      resolveGroup(docs, undefined, {
        strategy: "fail",
        isTTY: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("propagation with duplicate changed bodies chooses newest changed candidate", async () => {
    const docs = [
      memoryDoc("codex", "prev", 200),
      memoryDoc("claude-code", "changed", 300),
      memoryDoc("gemini-cli", "changed", 400),
    ];

    await expect(
      resolveGroup(docs, prev, {
        strategy: "lww",
        isTTY: false,
      }),
    ).resolves.toEqual({
      doc: docs[2],
      status: "propagated",
    });
  });
});
