import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createBackup, listBackups } from "../../../../src/core/backup.js";
import { fixtureDir } from "../../tmp-fixture.js";

const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@inquirer/prompts", () => ({
  confirm: promptMocks.confirm,
}));

const { runRestore } = await import("../../../../src/cli/commands/restore.js");

const originalCwd = process.cwd();
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  promptMocks.confirm.mockReset();
  promptMocks.confirm.mockResolvedValue(true);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  setStdoutIsTTY(false);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();

  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }
});

describe("runRestore", () => {
  test("--list shows backups in DESC order", async () => {
    const root = await initializedProject();
    const first = await seedBackup(root, [
      ["project/doc:one", "one.md", "one-original", "one-new"],
    ]);
    const second = await seedBackup(root, [
      ["project/doc:two", "two.md", "two-original", "two-new"],
    ]);
    const third = await seedBackup(root, [
      ["project/doc:three", "three.md", "three-original", "three-new"],
    ]);
    process.chdir(root);

    await expect(runRestore({ list: true })).resolves.toBe(0);

    const lines = stdout.trim().split("\n");
    expect(lines[0]).toContain(third.timestamp);
    expect(lines[1]).toContain(second.timestamp);
    expect(lines[2]).toContain(first.timestamp);
    expect(lines[0]).toContain("1 entries");
    expect(lines[0]).toContain("project/doc:three");
  });

  test("no mode flag defaults to --list", async () => {
    const root = await initializedProject();
    const backup = await seedBackup(root, [
      ["project/doc:default", "default.md", "original", "new"],
    ]);
    process.chdir(root);

    await expect(runRestore({})).resolves.toBe(0);

    expect(stdout).toContain(backup.timestamp);
    expect(stdout).toContain("project/doc:default");
  });

  test("--list --json emits backup summaries", async () => {
    const root = await initializedProject();
    const backup = await seedBackup(root, [
      ["project/doc:one", "one.md", "one-original", "one-new"],
      ["project/doc:two", "two.md", "two-original", "two-new"],
    ]);
    process.chdir(root);

    await expect(runRestore({ list: true, json: true })).resolves.toBe(0);

    const parsed = JSON.parse(stdout) as {
      backups: Array<{
        timestamp: string;
        dir: string;
        entries: number;
        firstGroupKey: string | null;
        groupKeys: string[];
      }>;
    };
    expect(parsed).toEqual({
      backups: [
        {
          timestamp: backup.timestamp,
          dir: backup.dir,
          entries: 2,
          firstGroupKey: "project/doc:one",
          groupKeys: ["project/doc:one", "project/doc:two"],
        },
      ],
    });
  });

  test("--at restores all entries", async () => {
    const root = await initializedProject();
    const one = path.join(root, "one.md");
    const two = path.join(root, "two.md");
    const backup = await seedBackup(root, [
      ["project/doc:one", "one.md", "one-original", "one-new"],
      ["project/doc:two", "two.md", "two-original", "two-new"],
    ]);
    process.chdir(root);

    await expect(runRestore({ at: backup.timestamp })).resolves.toBe(0);

    await expect(readText(one)).resolves.toBe("one-original");
    await expect(readText(two)).resolves.toBe("two-original");
    expect(stdout).toContain("Restored 2 entries, skipped 0");
  });

  test("--at accepts a timestamp prefix", async () => {
    const root = await initializedProject();
    const filePath = path.join(root, "prefix.md");
    const backup = await seedBackup(root, [
      ["project/doc:prefix", "prefix.md", "prefix-original", "prefix-new"],
    ]);
    process.chdir(root);

    await expect(
      runRestore({ at: backup.timestamp.slice(0, 19) }),
    ).resolves.toBe(0);

    await expect(readText(filePath)).resolves.toBe("prefix-original");
  });

  test("--at --group restores only the filtered group", async () => {
    const root = await initializedProject();
    const one = path.join(root, "one.md");
    const two = path.join(root, "two.md");
    const backup = await seedBackup(root, [
      ["project/doc:one", "one.md", "one-original", "one-new"],
      ["project/doc:two", "two.md", "two-original", "two-new"],
    ]);
    process.chdir(root);

    await expect(
      runRestore({ at: backup.timestamp, group: "project/doc:two" }),
    ).resolves.toBe(0);

    await expect(readText(one)).resolves.toBe("one-new");
    await expect(readText(two)).resolves.toBe("two-original");
    expect(stdout).toContain("Restored 1 entries, skipped 1");
  });

  test("--at unknown returns error with list hint", async () => {
    const root = await initializedProject();
    await seedBackup(root, [
      ["project/doc:one", "one.md", "one-original", "one-new"],
    ]);
    process.chdir(root);

    await expect(runRestore({ at: "unknown" })).resolves.toBe(1);

    expect(stderr).toContain("No backup found for timestamp: unknown");
    expect(stderr).toContain("Run `memento restore --list` first.");
  });

  test("--prune keeps newest N backups", async () => {
    const root = await initializedProject();
    await seedBackup(root, [["project/doc:one", "one.md", "one", "one-new"]]);
    const second = await seedBackup(root, [
      ["project/doc:two", "two.md", "two", "two-new"],
    ]);
    const third = await seedBackup(root, [
      ["project/doc:three", "three.md", "three", "three-new"],
    ]);
    process.chdir(root);

    await expect(runRestore({ prune: 2 })).resolves.toBe(0);

    await expect(listBackups(mementoDir(root))).resolves.toEqual([
      third,
      second,
    ]);
    expect(stdout).toContain("Removed 1 backups, kept 2");
  });

  test("confirmation prompt yes proceeds", async () => {
    const root = await initializedProject();
    const filePath = path.join(root, "yes.md");
    const backup = await seedBackup(root, [
      ["project/doc:yes", "yes.md", "yes-original", "yes-new"],
    ]);
    process.chdir(root);
    setStdoutIsTTY(true);
    promptMocks.confirm.mockResolvedValue(true);

    await expect(runRestore({ at: backup.timestamp })).resolves.toBe(0);

    expect(promptMocks.confirm).toHaveBeenCalledWith({
      message: `Restore 1 entries from ${backup.timestamp}?`,
      default: false,
    });
    await expect(readText(filePath)).resolves.toBe("yes-original");
  });

  test("confirmation prompt no cancels with exit 0", async () => {
    const root = await initializedProject();
    const filePath = path.join(root, "no.md");
    const backup = await seedBackup(root, [
      ["project/doc:no", "no.md", "no-original", "no-new"],
    ]);
    process.chdir(root);
    setStdoutIsTTY(true);
    promptMocks.confirm.mockResolvedValue(false);

    await expect(runRestore({ at: backup.timestamp })).resolves.toBe(0);

    await expect(readText(filePath)).resolves.toBe("no-new");
    expect(stdout).toContain("Restore cancelled");
  });

  test("non-TTY skips confirmation and proceeds", async () => {
    const root = await initializedProject();
    const filePath = path.join(root, "non-tty.md");
    const backup = await seedBackup(root, [
      ["project/doc:non-tty", "non-tty.md", "original", "new"],
    ]);
    process.chdir(root);
    setStdoutIsTTY(false);

    await expect(runRestore({ at: backup.timestamp })).resolves.toBe(0);

    expect(promptMocks.confirm).not.toHaveBeenCalled();
    await expect(readText(filePath)).resolves.toBe("original");
  });

  test("--quiet skips confirmation and suppresses restore output", async () => {
    const root = await initializedProject();
    const filePath = path.join(root, "quiet.md");
    const backup = await seedBackup(root, [
      ["project/doc:quiet", "quiet.md", "original", "new"],
    ]);
    process.chdir(root);
    setStdoutIsTTY(true);

    await expect(
      runRestore({ at: backup.timestamp, quiet: true }),
    ).resolves.toBe(0);

    expect(promptMocks.confirm).not.toHaveBeenCalled();
    await expect(readText(filePath)).resolves.toBe("original");
    expect(stdout).toBe("");
  });

  test("not initialized returns exit 3", async () => {
    const root = fixtureDir();
    process.chdir(root);

    await expect(runRestore({ list: true })).resolves.toBe(3);

    expect(stderr).toContain("No .memento directory found");
    expect(stderr).toContain("Run `memento init` first.");
  });
});

type SeedEntry = [
  groupKey: string,
  relativePath: string,
  previousContent: string,
  newContent: string,
];

async function initializedProject(): Promise<string> {
  const root = fixtureDir();
  await fs.mkdir(mementoDir(root), { recursive: true });
  return root;
}

async function seedBackup(root: string, entries: SeedEntry[]) {
  const targets = [];

  for (const [groupKey, relativePath, previousContent] of entries) {
    const absPath = path.join(root, relativePath);
    await writeText(absPath, previousContent);
    targets.push({
      absPath,
      previousContent,
      groupKey,
    });
  }

  const handle = await createBackup(mementoDir(root), targets);

  for (const [, relativePath, , newContent] of entries) {
    await writeText(path.join(root, relativePath), newContent);
  }

  return handle;
}

function mementoDir(root: string): string {
  return path.join(root, ".memento");
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}
