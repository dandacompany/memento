import type { ParsedMarkdown } from "./shared/markdown.js";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AdapterError } from "../core/errors.js";
import { matchGlob } from "../core/glob.js";
import { deriveIdentityKey } from "../core/identity.js";
import type { MemoryDoc, Tier } from "../core/types.js";
import {
  atomicWrite,
  readFileText,
  sha256Hex,
  statMtime,
} from "./shared/io.js";
import { parseMarkdown, serializeMarkdown } from "./shared/markdown.js";
import {
  dirExists,
  expandHome,
  fileExists,
  isMac,
  isWindows,
} from "./shared/probe.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "./types.js";

type AntigravityMemoryDoc = MemoryDoc & {
  meta: MemoryDoc["meta"] & {
    rawHints?: ParsedMarkdown["rawHints"];
  };
};

const providerId = "antigravity" as const;
const tierOrder: Tier[] = ["project", "project-local", "global"];

export class AntigravityAdapter implements ProviderAdapter {
  readonly id = providerId;
  readonly displayName = "Antigravity";

  private static readonly BRAIN_BLOCKLIST = [
    "~/.antigravity/brain/**",
    "**/conversations/**",
    "**/.git/**",
  ];

  constructor(private readonly cwd = process.cwd()) {}

  async probe(): Promise<ProbeResult> {
    const skillStorePath = expandHome("~/.gemini/antigravity");
    const configDirPath = expandHome("~/.antigravity");
    const skillStoreExists = await dirExists(skillStorePath);
    const configDirExists = await dirExists(configDirPath);
    if (skillStoreExists) {
      return {
        installStatus: "installed",
        configDirPath: skillStorePath,
      };
    }

    const appPaths = osInstallPaths();

    for (const appPath of appPaths) {
      if (await dirExists(appPath)) {
        return {
          installStatus: "installed",
          appPath,
          configDirPath: configDirExists ? configDirPath : undefined,
        };
      }
    }

    if (configDirExists) {
      return {
        installStatus: "unknown",
        configDirPath,
        hint: "Antigravity config directory exists, but no app installation was found.",
      };
    }

    return {
      installStatus: "not-installed",
      hint: "Install Antigravity or create an Antigravity memory file to activate this provider.",
    };
  }

  paths(cwd: string): TierPaths {
    return AntigravityAdapter.filterTierPaths({
      project: expandGlobsSync(cwd, [
        ".agent/skills/**/SKILL.md",
        "memory-bank/**/*.md",
      ]),
      "project-local": expandGlobsSync(cwd, ["memory-bank/**/*.local.md"]),
      global: AntigravityAdapter.filterBlockedPaths([
        ...expandGlobsSync(cwd, [
          expandHome("~/.gemini/antigravity/skills/**/SKILL.md"),
        ]),
        expandHome("~/.gemini/GEMINI.md"),
      ]),
    });
  }

  async detect(cwd: string): Promise<DetectResult> {
    const probe = await this.probe();
    const installed = probe.installStatus === "installed";
    const tierPaths = await this.expandedPaths(cwd);
    const activeTiers: Tier[] = [];

    for (const tier of tierOrder) {
      if (await anyPathExists(tierPaths[tier])) {
        activeTiers.push(tier);
      }
    }

    const hasMemory = activeTiers.length > 0;

    return {
      installed,
      hasMemory,
      active: installed || hasMemory,
      activeTiers,
      probe,
    };
  }

  async read(tier: Tier): Promise<MemoryDoc[]> {
    const docs: MemoryDoc[] = [];

    try {
      const tierPaths = await this.expandedPaths(this.cwd);

      for (const sourcePath of tierPaths[tier]) {
        if (AntigravityAdapter.isBlockedPath(sourcePath)) {
          continue;
        }

        const raw = await readFileText(sourcePath);
        if (raw === null) {
          continue;
        }

        const parsed = parseMarkdown(raw);
        const identity = deriveIdentityKey(sourcePath, this.id);
        const mtime = (await statMtime(sourcePath)) ?? 0;
        const meta: AntigravityMemoryDoc["meta"] = {
          tier: identity.tier,
          identityKey: identity.identityKey,
          subtype: identity.subtype,
          source: this.id,
          sourcePath,
          mtime,
          bodyHash: sha256Hex(parsed.body),
          rawHash: sha256Hex(raw),
          ...(parsed.frontmatter === null
            ? {}
            : { frontmatter: parsed.frontmatter }),
          rawHints: parsed.rawHints,
        };

        docs.push({
          body: parsed.body,
          meta,
        });
      }
    } catch (error) {
      if (error instanceof AdapterError) {
        throw error;
      }

      throw new AdapterError(
        this.id,
        "read",
        "ANTIGRAVITY_READ_FAILED",
        `Failed to read Antigravity ${tier} memory`,
        { cause: error },
      );
    }

    return docs;
  }

  async write(tier: Tier, docs: MemoryDoc[]): Promise<WriteReport> {
    const written: string[] = [];
    const skipped: string[] = [];

    try {
      for (const doc of docs) {
        if (AntigravityAdapter.isBlockedPath(doc.meta.sourcePath)) {
          throw new AdapterError(
            this.id,
            "write",
            "BRAIN_WRITE_REFUSED",
            `Refusing to write blocked Antigravity memory path: ${doc.meta.sourcePath}`,
          );
        }

        if (doc.meta.tier !== tier) {
          skipped.push(doc.meta.sourcePath);
          continue;
        }

        const antigravityDoc = doc as AntigravityMemoryDoc;
        const frontmatter = doc.meta.frontmatter ?? null;
        const rawHints = antigravityDoc.meta.rawHints;
        const content =
          rawHints === undefined
            ? serializeMarkdown(doc.body, frontmatter)
            : serializeMarkdown(doc.body, frontmatter, rawHints);

        await fs.mkdir(path.dirname(doc.meta.sourcePath), { recursive: true });
        await atomicWrite(doc.meta.sourcePath, content);
        written.push(doc.meta.sourcePath);
      }
    } catch (error) {
      if (error instanceof AdapterError) {
        throw error;
      }

      throw new AdapterError(
        this.id,
        "write",
        "ANTIGRAVITY_WRITE_FAILED",
        `Failed to write Antigravity ${tier} memory`,
        { cause: error },
      );
    }

    return { written, skipped };
  }

  private async expandedPaths(cwd: string): Promise<TierPaths> {
    return AntigravityAdapter.filterTierPaths({
      project: await expandGlobs(cwd, [
        ".agent/skills/**/SKILL.md",
        "memory-bank/**/*.md",
      ]),
      "project-local": await expandGlobs(cwd, ["memory-bank/**/*.local.md"]),
      global: AntigravityAdapter.filterBlockedPaths([
        ...(await expandGlobs(cwd, [
          expandHome("~/.gemini/antigravity/skills/**/SKILL.md"),
        ])),
        expandHome("~/.gemini/GEMINI.md"),
      ]),
    });
  }

  private static filterTierPaths(paths: TierPaths): TierPaths {
    return {
      project: AntigravityAdapter.filterBlockedPaths(paths.project),
      "project-local": AntigravityAdapter.filterBlockedPaths(
        paths["project-local"],
      ),
      global: AntigravityAdapter.filterBlockedPaths(paths.global),
    };
  }

  private static filterBlockedPaths(paths: string[]): string[] {
    return paths.filter(
      (filePath) => !AntigravityAdapter.isBlockedPath(filePath),
    );
  }

  private static isBlockedPath(filePath: string): boolean {
    return AntigravityAdapter.BRAIN_BLOCKLIST.some((pattern) =>
      matchGlob(filePath, AntigravityAdapter.expandBlocklistPattern(pattern)),
    );
  }

  private static expandBlocklistPattern(pattern: string): string {
    return pattern.startsWith("~") ? expandHome(pattern) : pattern;
  }
}

export function createAntigravityAdapter(
  cwd = process.cwd(),
): AntigravityAdapter {
  return new AntigravityAdapter(cwd);
}

export async function expandGlobs(
  cwd: string,
  patterns: string[],
): Promise<string[]> {
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const absolutePattern = absoluteGlob(cwd, pattern);
    const root = globRoot(absolutePattern);
    const files = await walkFiles(root);

    for (const filePath of files) {
      if (!matchGlob(filePath, absolutePattern) || seen.has(filePath)) {
        continue;
      }

      seen.add(filePath);
      matches.push(filePath);
    }
  }

  return matches.sort((left, right) => left.localeCompare(right));
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const filePath of paths) {
    if (await fileExists(filePath)) {
      return true;
    }
  }

  return false;
}

function osInstallPaths(): string[] {
  if (isMac()) {
    return ["/Applications/Antigravity.app"];
  }

  if (isWindows()) {
    const paths: string[] = [];

    if (process.env.LOCALAPPDATA) {
      paths.push(
        path.join(process.env.LOCALAPPDATA, "Programs", "antigravity"),
      );
    }

    if (process.env.APPDATA) {
      paths.push(path.join(process.env.APPDATA, "antigravity"));
    }

    return paths;
  }

  return [];
}

function expandGlobsSync(cwd: string, patterns: string[]): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const absolutePattern = absoluteGlob(cwd, pattern);
    const root = globRoot(absolutePattern);
    const files = walkFilesSync(root);

    for (const filePath of files) {
      if (!matchGlob(filePath, absolutePattern) || seen.has(filePath)) {
        continue;
      }

      seen.add(filePath);
      matches.push(filePath);
    }
  }

  return matches.sort((left, right) => left.localeCompare(right));
}

function absoluteGlob(cwd: string, pattern: string): string {
  if (path.isAbsolute(pattern)) {
    return path.normalize(pattern);
  }

  return path.join(cwd, pattern);
}

function globRoot(pattern: string): string {
  const parsed = path.parse(pattern);
  const segments = pattern.slice(parsed.root.length).split(path.sep);
  const rootSegments: string[] = [];

  for (const segment of segments) {
    if (segment.includes("*") || segment.includes("?")) {
      break;
    }

    rootSegments.push(segment);
  }

  return path.join(parsed.root, ...rootSegments);
}

async function walkFiles(root: string): Promise<string[]> {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files: string[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(childPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(childPath);
    }
  }

  return files;
}

function walkFilesSync(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const stat = statSync(root);
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFilesSync(childPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(childPath);
    }
  }

  return files;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
