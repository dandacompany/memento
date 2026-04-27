import { promises as fs } from "node:fs";
import path from "node:path";

export interface BackupTarget {
  absPath: string;
  previousContent: string | null;
  groupKey: string;
}

export interface BackupHandle {
  timestamp: string;
  dir: string;
  entries: BackupEntry[];
}

export interface BackupEntry {
  groupKey: string;
  originalPath: string;
  backupPath: string;
  previousMtime: number | null;
}

export interface RestoreOpts {
  groupKey?: string;
}

const manifestName = "manifest.json";

export async function createBackup(
  mementoDir: string,
  targets: BackupTarget[],
): Promise<BackupHandle> {
  const backupRoot = path.join(mementoDir, "backup");
  await fs.mkdir(backupRoot, { recursive: true });

  const { timestamp, dir } = await createSnapshotDir(backupRoot);
  const entries: BackupEntry[] = [];

  for (const target of targets) {
    if (target.previousContent === null) {
      continue;
    }

    const backupPath = backupPathFor(dir, target.absPath);
    await atomicWriteFile(backupPath, target.previousContent);

    entries.push({
      groupKey: target.groupKey,
      originalPath: target.absPath,
      backupPath,
      previousMtime: await previousMtime(target.absPath),
    });
  }

  const handle: BackupHandle = { timestamp, dir, entries };
  await atomicWriteJson(path.join(dir, manifestName), handle);

  return handle;
}

export async function listBackups(mementoDir: string): Promise<BackupHandle[]> {
  const backupRoot = path.join(mementoDir, "backup");
  let directories: string[];

  try {
    directories = (await fs.readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const handles: BackupHandle[] = [];

  for (const directory of directories) {
    const dir = path.join(backupRoot, directory);
    const handle = await readManifest(path.join(dir, manifestName), dir);

    if (handle) {
      handles.push(handle);
    }
  }

  return handles.sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  );
}

export async function restoreBackup(
  handle: BackupHandle,
  opts: RestoreOpts = {},
): Promise<{ restored: string[]; skipped: string[] }> {
  const restored: string[] = [];
  const skipped: string[] = [];

  for (const entry of handle.entries) {
    if (opts.groupKey !== undefined && entry.groupKey !== opts.groupKey) {
      skipped.push(entry.originalPath);
      continue;
    }

    await atomicCopyFile(entry.backupPath, entry.originalPath);
    restored.push(entry.originalPath);
  }

  return { restored, skipped };
}

export async function pruneOldBackups(
  mementoDir: string,
  keepCount: number,
): Promise<{ removed: string[] }> {
  const handles = await listBackups(mementoDir);
  const removeFrom = Math.max(0, keepCount);
  const removed: string[] = [];

  for (const handle of handles.slice(removeFrom)) {
    await fs.rm(handle.dir, { recursive: true, force: true });
    removed.push(handle.dir);
  }

  return { removed };
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\./g, "_");
}

async function createSnapshotDir(
  backupRoot: string,
): Promise<{ timestamp: string; dir: string }> {
  const now = Date.now();

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const timestamp = safeTimestamp(new Date(now + attempt));
    const dir = path.join(backupRoot, timestamp);

    try {
      await fs.mkdir(dir);
      return { timestamp, dir };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to create a unique backup directory");
}

function backupPathFor(backupDir: string, absPath: string): string {
  const resolved = path.resolve(absPath);
  const parsed = path.parse(resolved);
  const relativePath = path.relative(parsed.root, resolved);
  const rootLabel =
    parsed.root === path.sep ? "" : sanitizeSegment(parsed.root);

  return path.join(backupDir, rootLabel, relativePath);
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[:.\\/]/g, "-").replace(/-+$/g, "");
}

async function previousMtime(absPath: string): Promise<number | null> {
  try {
    return (await fs.stat(absPath)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readManifest(
  manifestPath: string,
  dir: string,
): Promise<BackupHandle | null> {
  let raw: string;

  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isBackupHandle(parsed)) {
      return null;
    }

    return {
      timestamp: parsed.timestamp,
      dir,
      entries: parsed.entries,
    };
  } catch {
    return null;
  }
}

function isBackupHandle(value: unknown): value is BackupHandle {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.timestamp === "string" &&
    typeof value.dir === "string" &&
    Array.isArray(value.entries) &&
    value.entries.every(isBackupEntry)
  );
}

function isBackupEntry(value: unknown): value is BackupEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.groupKey === "string" &&
    typeof value.originalPath === "string" &&
    typeof value.backupPath === "string" &&
    (value.previousMtime === null || typeof value.previousMtime === "number")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);

  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

async function atomicCopyFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  const tempPath = tempPathFor(to);

  await fs.copyFile(from, tempPath);
  await fs.rename(tempPath, to);
}

function tempPathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
