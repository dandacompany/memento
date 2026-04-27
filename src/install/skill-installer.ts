import { promises as fs } from "node:fs";
import path from "node:path";

import matter from "gray-matter";

export interface InstallOptions {
  source: string;
  dest: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface InstallResult {
  mode: "created" | "updated" | "unchanged" | "skipped";
  copied: string[];
  skipped: string[];
  backupDir?: string;
  reason?: string;
}

export interface UninstallResult {
  removed: string[];
  skipped: string[];
}

interface SkillMeta {
  name?: string;
  version: string;
}

const skillFileName = "SKILL.md";

export async function installSkill(
  opts: InstallOptions,
): Promise<InstallResult> {
  const source = path.resolve(opts.source);
  const dest = path.resolve(opts.dest);
  const sourceFiles = await listFiles(source);
  const copied = sourceFiles.map((file) => path.relative(source, file));
  const sourceMeta = await readSkillMeta(path.join(source, skillFileName));
  const existingMeta = await readSkillMetaIfExists(
    path.join(dest, skillFileName),
  );
  const existingDest = await pathExists(dest);

  if (
    existingDest &&
    existingMeta.version === sourceMeta.version &&
    !opts.force
  ) {
    return {
      mode: "unchanged",
      copied: [],
      skipped: copied,
      reason: `version ${sourceMeta.version} already installed`,
    };
  }

  const mode: InstallResult["mode"] = existingDest ? "updated" : "created";
  const backupDir = existingDest ? backupPathFor(dest) : undefined;

  if (opts.dryRun) {
    return {
      mode,
      copied,
      skipped: [],
      ...(backupDir === undefined ? {} : { backupDir }),
      reason:
        mode === "updated"
          ? `would replace version ${existingMeta.version} with ${sourceMeta.version}`
          : `would install version ${sourceMeta.version}`,
    };
  }

  const parent = path.dirname(dest);
  await fs.mkdir(parent, { recursive: true });
  const tempDest = await createTempSibling(dest);

  try {
    await fs.cp(source, tempDest, {
      recursive: true,
      errorOnExist: false,
      force: true,
      preserveTimestamps: true,
    });
    await chmodExecutableScripts(tempDest);

    if (existingDest) {
      if (backupDir === undefined) {
        throw new Error("Missing backup directory for existing skill install");
      }

      await fs.rename(dest, backupDir);
    }

    await fs.rename(tempDest, dest);
  } catch (error) {
    await fs.rm(tempDest, { recursive: true, force: true });

    if (backupDir !== undefined && (await pathExists(backupDir))) {
      if (!(await pathExists(dest))) {
        await fs.rename(backupDir, dest);
      }
    }

    throw error;
  }

  return {
    mode,
    copied,
    skipped: [],
    ...(backupDir === undefined ? {} : { backupDir }),
  };
}

export async function uninstallSkill(opts: {
  dest: string;
  dryRun?: boolean;
}): Promise<UninstallResult> {
  const dest = path.resolve(opts.dest);

  if (!(await pathExists(dest))) {
    return { removed: [], skipped: [dest] };
  }

  const meta = await readSkillMetaIfExists(path.join(dest, skillFileName));

  if (meta.name !== "memento") {
    return { removed: [], skipped: [dest] };
  }

  const files = await listFiles(dest);
  const removed = files.map((file) => path.relative(dest, file));

  if (!opts.dryRun) {
    await fs.rm(dest, { recursive: true, force: true });
  }

  return { removed, skipped: [] };
}

async function readSkillMeta(skillPath: string): Promise<SkillMeta> {
  const raw = await fs.readFile(skillPath, "utf8");
  const parsed = matter(raw);
  const data = isRecord(parsed.data) ? parsed.data : {};

  return {
    name: typeof data.name === "string" ? data.name : undefined,
    version: typeof data.version === "string" ? data.version : "0.0.0",
  };
}

async function readSkillMetaIfExists(skillPath: string): Promise<SkillMeta> {
  try {
    return await readSkillMeta(skillPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: "0.0.0" };
    }

    throw error;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const child = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(child)));
      continue;
    }

    if (entry.isFile()) {
      files.push(child);
    }
  }

  return files.sort();
}

async function chmodExecutableScripts(root: string): Promise<void> {
  const scriptsDir = path.join(root, "scripts");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(scriptsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sh"))
      .map((entry) => fs.chmod(path.join(scriptsDir, entry.name), 0o755)),
  );
}

async function createTempSibling(target: string): Promise<string> {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, `.${path.basename(target)}-tmp-`));
}

function backupPathFor(dest: string): string {
  const parent = path.dirname(dest);
  const base = path.basename(dest);
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\./g, "_");

  return path.join(parent, `${base}-backup-${timestamp}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
