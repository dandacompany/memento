import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeResourceSlug } from "../core/resource-identity.js";
import type {
  ResourceDoc,
  ResourceFile,
  ResourceScope,
} from "../core/resource-types.js";
import type { ProviderId, Tier } from "../core/types.js";
import { atomicWrite, sha256Hex } from "../adapters/shared/io.js";
import { parseMarkdown } from "../adapters/shared/markdown.js";
import type { ResourceWriteReport } from "../adapters/types.js";

export interface SkillRoot {
  path: string;
  provider: ProviderId;
  scope: ResourceScope;
  tier: Tier;
  writeable?: boolean;
}

const defaultExcludes = [
  "node_modules",
  ".git",
  ".DS_Store",
  ".memento",
] as const;

export async function readSkillResources(
  roots: SkillRoot[],
): Promise<ResourceDoc[]> {
  const docs: ResourceDoc[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const skillDirs = await listSkillDirs(root.path);

    for (const skillDir of skillDirs) {
      const resolved = path.resolve(skillDir);

      if (seen.has(resolved)) {
        continue;
      }

      seen.add(resolved);
      docs.push(await readSkillResource(root, skillDir));
    }
  }

  return docs;
}

export async function readSkillResource(
  root: SkillRoot,
  skillDir: string,
): Promise<ResourceDoc> {
  const entryPath = path.join(skillDir, "SKILL.md");
  const entryRaw = await fs.readFile(entryPath, "utf8");
  const parsed = parseMarkdown(entryRaw);
  const frontmatterName =
    typeof parsed.frontmatter?.name === "string"
      ? parsed.frontmatter.name
      : undefined;
  const slug = normalizeResourceSlug(frontmatterName ?? path.basename(skillDir));
  const files = await readBundleFiles(skillDir);
  const mtime = await maxMtime(skillDir, files);
  const bodyHash = bundleHash(files);

  return {
    kind: "skill",
    body: {
      type: "skill-bundle",
      files,
    },
    meta: {
      provider: root.provider,
      scope: root.scope,
      tier: root.tier,
      identityKey: `skill:${slug}`,
      sourcePath: skillDir,
      sourceFormat: "directory",
      sensitive: false,
      redactions: [],
      mtime,
      bodyHash,
      rawHash: bodyHash,
      title: frontmatterName ?? slug,
      writeable: root.writeable ?? true,
    },
  };
}

export async function writeSkillResources(
  roots: SkillRoot[],
  docs: ResourceDoc[],
): Promise<ResourceWriteReport> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const doc of docs) {
    const root = selectWritableRoot(roots, doc);

    if (!root || !isSkillBundle(doc)) {
      skipped.push(doc.meta.sourcePath);
      continue;
    }

    if (doc.body.files.some((file) => file.binary)) {
      skipped.push(doc.meta.sourcePath);
      continue;
    }

    const skillDir = targetSkillDir(root, doc);
    await writeSkillBundle(skillDir, doc.body.files);
    written.push(skillDir);
  }

  return { written, skipped };
}

async function listSkillDirs(rootPath: string): Promise<string[]> {
  let entries: string[];

  try {
    entries = await fs.readdir(rootPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const dirs: string[] = [];

  for (const entry of entries.sort()) {
    if (shouldSkipName(entry)) {
      continue;
    }

    const dirPath = path.join(rootPath, entry);
    const stat = await fs.stat(dirPath).catch(() => null);

    if (!stat?.isDirectory()) {
      continue;
    }

    const entryPath = path.join(dirPath, "SKILL.md");
    const entryStat = await fs.stat(entryPath).catch(() => null);

    if (entryStat?.isFile()) {
      dirs.push(dirPath);
    }
  }

  return dirs;
}

async function readBundleFiles(skillDir: string): Promise<ResourceFile[]> {
  const paths = await walk(skillDir);
  const files: ResourceFile[] = [];

  for (const filePath of paths) {
    const relativePath = path.relative(skillDir, filePath).split(path.sep).join("/");

    if (relativePath === "" || shouldSkipRelativePath(relativePath)) {
      continue;
    }

    const buffer = await fs.readFile(filePath);
    const binary = isLikelyBinary(buffer);

    files.push({
      relativePath,
      contentHash: sha256Hex(buffer.toString("binary")),
      content: binary ? undefined : buffer.toString("utf8"),
      binary,
    });
  }

  return files.sort(compareResourceFiles);
}

async function walk(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (shouldSkipName(entry.name)) {
      continue;
    }

    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function maxMtime(
  skillDir: string,
  files: ResourceFile[],
): Promise<number> {
  let max = 0;

  for (const file of files) {
    const stat = await fs.stat(path.join(skillDir, file.relativePath));
    max = Math.max(max, stat.mtimeMs);
  }

  return max;
}

function bundleHash(files: ResourceFile[]): string {
  return sha256Hex(
    JSON.stringify(
      files.map((file) => ({
        path: file.relativePath,
        hash: file.contentHash,
        binary: file.binary,
      })),
    ),
  );
}

function compareResourceFiles(a: ResourceFile, b: ResourceFile): number {
  if (a.relativePath === "SKILL.md") {
    return -1;
  }

  if (b.relativePath === "SKILL.md") {
    return 1;
  }

  return a.relativePath.localeCompare(b.relativePath);
}

function selectWritableRoot(
  roots: SkillRoot[],
  doc: ResourceDoc,
): SkillRoot | undefined {
  return (
    roots.find((root) => root.writeable !== false && root.tier === doc.meta.tier) ??
    roots.find((root) => root.writeable !== false)
  );
}

function isSkillBundle(
  doc: ResourceDoc,
): doc is ResourceDoc & { body: { type: "skill-bundle"; files: ResourceFile[] } } {
  return (
    doc.kind === "skill" &&
    typeof doc.body === "object" &&
    doc.body.type === "skill-bundle"
  );
}

function targetSkillDir(root: SkillRoot, doc: ResourceDoc): string {
  if (
    doc.meta.provider === root.provider &&
    doc.meta.sourcePath !== "" &&
    path.isAbsolute(doc.meta.sourcePath)
  ) {
    return doc.meta.sourcePath;
  }

  const slug = doc.meta.identityKey.startsWith("skill:")
    ? doc.meta.identityKey.slice("skill:".length)
    : normalizeResourceSlug(doc.meta.identityKey);

  return path.join(root.path, slug);
}

async function writeSkillBundle(
  skillDir: string,
  files: ResourceFile[],
): Promise<void> {
  await fs.mkdir(skillDir, { recursive: true });
  const desired = new Set(files.map((file) => file.relativePath));

  await removeExtraneousFiles(skillDir, desired);

  for (const file of files) {
    if (file.binary || file.content === undefined) {
      continue;
    }

    await atomicWrite(path.join(skillDir, file.relativePath), file.content);
  }
}

async function removeExtraneousFiles(
  skillDir: string,
  desired: Set<string>,
): Promise<void> {
  const existing = await walk(skillDir).catch((error) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const filePath of existing) {
    const relativePath = path.relative(skillDir, filePath).split(path.sep).join("/");

    if (shouldSkipRelativePath(relativePath) || desired.has(relativePath)) {
      continue;
    }

    await fs.rm(filePath);
  }
}

function shouldSkipName(name: string): boolean {
  return name.startsWith(".") || defaultExcludes.includes(name as never);
}

function shouldSkipRelativePath(relativePath: string): boolean {
  if (relativePath.endsWith(".log")) {
    return true;
  }

  return relativePath.split("/").some(shouldSkipName);
}

function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
