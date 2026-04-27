import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createBackup,
  listBackups,
  pruneOldBackups,
  restoreBackup,
  type BackupTarget,
} from "../../src/core/backup.js";
import { fixtureDir } from "./tmp-fixture.js";

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

function mementoDir(root: string): string {
  return path.join(root, ".memento");
}

describe("backup", () => {
  test("createBackup with 0 targets creates an empty manifest", async () => {
    const root = fixtureDir();
    const handle = await createBackup(mementoDir(root), []);
    const manifest = JSON.parse(
      await readText(path.join(handle.dir, "manifest.json")),
    ) as unknown;

    expect(handle.entries).toEqual([]);
    expect(handle.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_\d{3}Z$/,
    );
    expect(manifest).toEqual(handle);
  });

  test("createBackup with 1 target writes previous content under backup dir", async () => {
    const root = fixtureDir();
    const filePath = path.join(root, "AGENTS.md");
    await writeText(filePath, "original");

    const handle = await createBackup(mementoDir(root), [
      {
        absPath: filePath,
        previousContent: "original",
        groupKey: "project/agents-md:main",
      },
    ]);

    expect(handle.entries).toHaveLength(1);
    expect(handle.entries[0]?.backupPath.startsWith(handle.dir)).toBe(true);
    await expect(readText(handle.entries[0]!.backupPath)).resolves.toBe(
      "original",
    );
    expect(handle.entries[0]?.previousMtime).toEqual(expect.any(Number));
  });

  test("createBackup with 3 targets records all restorable entries", async () => {
    const root = fixtureDir();
    const targets: BackupTarget[] = [
      {
        absPath: path.join(root, "one.md"),
        previousContent: "one",
        groupKey: "project/doc:one",
      },
      {
        absPath: path.join(root, "nested", "two.md"),
        previousContent: "two",
        groupKey: "project/doc:two",
      },
      {
        absPath: path.join(root, "nested", "deep", "three.md"),
        previousContent: "three",
        groupKey: "project/doc:three",
      },
    ];

    for (const target of targets) {
      await writeText(target.absPath, target.previousContent!);
    }

    const handle = await createBackup(mementoDir(root), targets);

    expect(handle.entries.map((entry) => entry.groupKey)).toEqual([
      "project/doc:one",
      "project/doc:two",
      "project/doc:three",
    ]);
    await expect(readText(handle.entries[2]!.backupPath)).resolves.toBe(
      "three",
    );
  });

  test("createBackup skips new files with null previousContent", async () => {
    const root = fixtureDir();
    const handle = await createBackup(mementoDir(root), [
      {
        absPath: path.join(root, "new.md"),
        previousContent: null,
        groupKey: "project/doc:new",
      },
    ]);

    expect(handle.entries).toEqual([]);
  });

  test("createBackup records null previousMtime if source disappeared", async () => {
    const root = fixtureDir();
    const handle = await createBackup(mementoDir(root), [
      {
        absPath: path.join(root, "missing.md"),
        previousContent: "last known content",
        groupKey: "project/doc:missing",
      },
    ]);

    expect(handle.entries[0]?.previousMtime).toBeNull();
    await expect(readText(handle.entries[0]!.backupPath)).resolves.toBe(
      "last known content",
    );
  });

  test("listBackups returns empty array when backup dir is missing", async () => {
    const root = fixtureDir();

    await expect(listBackups(mementoDir(root))).resolves.toEqual([]);
  });

  test("listBackups returns backups in descending timestamp order", async () => {
    const root = fixtureDir();
    const first = await createBackup(mementoDir(root), []);
    const second = await createBackup(mementoDir(root), []);
    const third = await createBackup(mementoDir(root), []);

    await expect(listBackups(mementoDir(root))).resolves.toEqual([
      third,
      second,
      first,
    ]);
  });

  test("listBackups skips corrupt manifests", async () => {
    const root = fixtureDir();
    const valid = await createBackup(mementoDir(root), []);
    const corruptDir = path.join(mementoDir(root), "backup", "corrupt");
    const missingManifestDir = path.join(
      mementoDir(root),
      "backup",
      "missing-manifest",
    );
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.mkdir(missingManifestDir, { recursive: true });
    await writeText(path.join(corruptDir, "manifest.json"), "{ nope");

    await expect(listBackups(mementoDir(root))).resolves.toEqual([valid]);
  });

  test("listBackups skips structurally invalid manifests", async () => {
    const root = fixtureDir();
    const valid = await createBackup(mementoDir(root), []);
    const invalidDir = path.join(mementoDir(root), "backup", "invalid");
    await fs.mkdir(invalidDir, { recursive: true });
    await writeText(
      path.join(invalidDir, "manifest.json"),
      JSON.stringify({ timestamp: "2026", dir: invalidDir, entries: [{}] }),
    );

    await expect(listBackups(mementoDir(root))).resolves.toEqual([valid]);
  });

  test("restoreBackup restores all entries", async () => {
    const root = fixtureDir();
    const one = path.join(root, "one.md");
    const two = path.join(root, "two.md");
    await writeText(one, "one-original");
    await writeText(two, "two-original");

    const handle = await createBackup(mementoDir(root), [
      {
        absPath: one,
        previousContent: "one-original",
        groupKey: "project/doc:one",
      },
      {
        absPath: two,
        previousContent: "two-original",
        groupKey: "project/doc:two",
      },
    ]);
    await writeText(one, "one-new");
    await writeText(two, "two-new");

    await expect(restoreBackup(handle)).resolves.toEqual({
      restored: [one, two],
      skipped: [],
    });
    await expect(readText(one)).resolves.toBe("one-original");
    await expect(readText(two)).resolves.toBe("two-original");
  });

  test("restoreBackup with groupKey filter restores only matching entries", async () => {
    const root = fixtureDir();
    const one = path.join(root, "one.md");
    const two = path.join(root, "two.md");
    await writeText(one, "one-original");
    await writeText(two, "two-original");

    const handle = await createBackup(mementoDir(root), [
      {
        absPath: one,
        previousContent: "one-original",
        groupKey: "project/doc:one",
      },
      {
        absPath: two,
        previousContent: "two-original",
        groupKey: "project/doc:two",
      },
    ]);
    await writeText(one, "one-new");
    await writeText(two, "two-new");

    await expect(
      restoreBackup(handle, { groupKey: "project/doc:two" }),
    ).resolves.toEqual({
      restored: [two],
      skipped: [one],
    });
    await expect(readText(one)).resolves.toBe("one-new");
    await expect(readText(two)).resolves.toBe("two-original");
  });

  test("restoreBackup creates missing parent directories", async () => {
    const root = fixtureDir();
    const filePath = path.join(root, "nested", "doc.md");
    await writeText(filePath, "original");
    const handle = await createBackup(mementoDir(root), [
      {
        absPath: filePath,
        previousContent: "original",
        groupKey: "project/doc:nested",
      },
    ]);
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });

    await restoreBackup(handle);

    await expect(readText(filePath)).resolves.toBe("original");
  });

  test("pruneOldBackups keeps N newest backups and removes the rest", async () => {
    const root = fixtureDir();
    const first = await createBackup(mementoDir(root), []);
    const second = await createBackup(mementoDir(root), []);
    const third = await createBackup(mementoDir(root), []);
    const fourth = await createBackup(mementoDir(root), []);

    await expect(pruneOldBackups(mementoDir(root), 2)).resolves.toEqual({
      removed: [second.dir, first.dir],
    });
    await expect(listBackups(mementoDir(root))).resolves.toEqual([
      fourth,
      third,
    ]);
  });

  test("pruneOldBackups with keepCount 0 removes all valid backups", async () => {
    const root = fixtureDir();
    const first = await createBackup(mementoDir(root), []);
    const second = await createBackup(mementoDir(root), []);

    await expect(pruneOldBackups(mementoDir(root), 0)).resolves.toEqual({
      removed: [second.dir, first.dir],
    });
    await expect(listBackups(mementoDir(root))).resolves.toEqual([]);
  });

  test("createBackup and restoreBackup round-trip original content", async () => {
    const root = fixtureDir();
    const filePath = path.join(root, "round-trip.md");
    await writeText(filePath, "original content\n");
    const handle = await createBackup(mementoDir(root), [
      {
        absPath: filePath,
        previousContent: await readText(filePath),
        groupKey: "project/doc:round-trip",
      },
    ]);

    await writeText(filePath, "modified content\n");
    await restoreBackup(handle);

    await expect(readText(filePath)).resolves.toBe("original content\n");
  });
});
