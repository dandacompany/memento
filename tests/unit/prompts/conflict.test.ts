import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { sha256Hex } from "../../../src/adapters/shared/io.js";
import type {
  ConflictGroup,
  MemoryDoc,
  ProviderId,
} from "../../../src/core/types.js";
import { fixtureDir } from "../tmp-fixture.js";

const selectMock = vi.hoisted(() => vi.fn());

vi.mock("@inquirer/prompts", () => ({
  select: selectMock,
}));

afterEach(() => {
  selectMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("conflictPromptUser", () => {
  test("returns the latest candidate when the user selects option a", async () => {
    const older = memoryDoc("codex", "older", 100);
    const latest = memoryDoc("claude-code", "latest", 200);
    selectMock.mockResolvedValueOnce("choose-a");

    const { conflictPromptUser } =
      await import("../../../src/prompts/conflict.js");

    await expect(conflictPromptUser(group([older, latest]))).resolves.toBe(
      latest,
    );
  });

  test("returns the other candidate when the user selects option b", async () => {
    const older = memoryDoc("codex", "older", 100);
    const latest = memoryDoc("claude-code", "latest", 200);
    selectMock.mockResolvedValueOnce("choose-b");

    const { conflictPromptUser } =
      await import("../../../src/prompts/conflict.js");

    await expect(conflictPromptUser(group([older, latest]))).resolves.toBe(
      older,
    );
  });

  test("returns null when the user skips the group", async () => {
    selectMock.mockResolvedValueOnce("skip");

    const { conflictPromptUser } =
      await import("../../../src/prompts/conflict.js");

    await expect(conflictPromptUser(group())).resolves.toBeNull();
  });

  test("prints a diff and re-prompts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const older = memoryDoc("codex", "old body", 100);
    const latest = memoryDoc("claude-code", "new body", 200);
    selectMock.mockResolvedValueOnce("diff").mockResolvedValueOnce("choose-b");

    const { conflictPromptUser } =
      await import("../../../src/prompts/conflict.js");

    await expect(conflictPromptUser(group([older, latest]))).resolves.toBe(
      older,
    );
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(stripAnsi(String(log.mock.calls[0]?.[0]))).toContain("-new body");
    expect(stripAnsi(String(log.mock.calls[0]?.[0]))).toContain("+old body");
  });

  test("opens an editor and returns the merged body", async () => {
    const root = fixtureDir();
    const editorScript = path.join(root, "editor.cjs");
    await fs.writeFile(
      editorScript,
      [
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.argv[2], "[MERGED]\\nmerged body\\n", "utf8");',
      ].join("\n"),
      "utf8",
    );
    vi.stubEnv(
      "EDITOR",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(editorScript)}`,
    );
    selectMock.mockResolvedValueOnce("edit");

    const older = memoryDoc("codex", "older", 100);
    const latest = memoryDoc("claude-code", "latest", 200);
    const { conflictPromptUser } =
      await import("../../../src/prompts/conflict.js");

    const result = await conflictPromptUser(group([older, latest]));

    expect(result?.body).toBe("merged body\n");
    expect(result?.meta.source).toBe(older.meta.source);
    expect(result?.meta.identityKey).toBe(older.meta.identityKey);
    expect(result?.meta.tier).toBe(older.meta.tier);
    expect(result?.meta.bodyHash).toBe(sha256Hex("merged body\n"));
    expect(result?.meta.rawHash).toBe(sha256Hex("merged body\n"));
  });

  test("throws when the conflict group has fewer than two candidates", async () => {
    const { conflictPromptUser } =
      await import("../../../src/prompts/conflict.js");

    await expect(
      conflictPromptUser(group([memoryDoc("codex", "one", 100)])),
    ).rejects.toThrow("requires at least two candidates");
    expect(selectMock).not.toHaveBeenCalled();
  });
});

function group(candidates?: MemoryDoc[]): ConflictGroup {
  return {
    key: "project/agents-md:main",
    candidates: candidates ?? [
      memoryDoc("codex", "body a", 100),
      memoryDoc("claude-code", "body b", 200),
    ],
  };
}

function memoryDoc(source: ProviderId, body: string, mtime: number): MemoryDoc {
  return {
    body,
    meta: {
      tier: "project",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source,
      sourcePath: `/repo/${source}/AGENTS.md`,
      mtime,
      bodyHash: sha256Hex(body),
      rawHash: `raw:${source}:${sha256Hex(body)}`,
    },
  };
}

function stripAnsi(input: string): string {
  return input.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
    "",
  );
}
