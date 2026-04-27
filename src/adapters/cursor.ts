import { type Dirent, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { AdapterError } from "../core/errors.js";
import { deriveIdentityKey } from "../core/identity.js";
import type { MemoryDoc, Tier } from "../core/types.js";
import {
  atomicWrite,
  readFileText,
  sha256Hex,
  statMtime,
} from "./shared/io.js";
import type { ParsedMarkdown } from "./shared/markdown.js";
import {
  normalizeBody,
  parseMarkdown,
  serializeMarkdown,
} from "./shared/markdown.js";
import {
  appPath,
  dirExists,
  expandHome,
  fileExists,
  runCmdVersion,
  which,
} from "./shared/probe.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "./types.js";

type CursorMemoryDoc = MemoryDoc & {
  meta: MemoryDoc["meta"] & {
    rawHints?: ParsedMarkdown["rawHints"];
  };
};

interface CursorAdapterOptions {
  migrateLegacy?: boolean;
}

const providerId = "cursor" as const;
const tierOrder: Tier[] = ["project", "project-local", "global"];

export class CursorAdapter implements ProviderAdapter {
  readonly id = providerId;
  readonly displayName = "Cursor";

  private readonly cwd: string;
  private readonly migrateLegacy: boolean;

  constructor(cwd = process.cwd(), options: CursorAdapterOptions = {}) {
    this.cwd = cwd;
    this.migrateLegacy = options.migrateLegacy ?? false;
  }

  async probe(): Promise<ProbeResult> {
    const binaryPath = await which("cursor");
    const configDirPath = expandHome("~/.cursor");
    const configDir = (await dirExists(configDirPath))
      ? configDirPath
      : undefined;

    if (binaryPath) {
      const version = await runCmdVersion(binaryPath);

      return {
        installStatus: "installed",
        binaryPath,
        configDirPath: configDir,
        version: version ?? undefined,
      };
    }

    const installedAppPath = await firstExistingDir(appPath("Cursor"));
    if (installedAppPath) {
      return {
        installStatus: "installed",
        appPath: installedAppPath,
        configDirPath: configDir,
      };
    }

    if (configDir) {
      return {
        installStatus: "unknown",
        configDirPath: configDir,
        hint: "Cursor config directory exists, but the cursor binary or app was not found.",
      };
    }

    return {
      installStatus: "not-installed",
      hint: "Install Cursor or create Cursor rules to activate this provider.",
    };
  }

  paths(cwd: string): TierPaths {
    const projectRulesDir = path.join(cwd, ".cursor", "rules");
    const projectRules = listMdcFiles(projectRulesDir, false).filter(
      (filePath) => !path.basename(filePath).endsWith(".local.mdc"),
    );
    const legacyPath = path.join(cwd, ".cursorrules");

    return {
      project: [
        ...projectRules,
        ...(fileExistsSync(legacyPath) ? [legacyPath] : []),
      ],
      "project-local": listMdcFiles(projectRulesDir, false).filter((filePath) =>
        path.basename(filePath).endsWith(".local.mdc"),
      ),
      global: listMdcFiles(expandHome("~/.cursor/rules"), true),
    };
  }

  async detect(cwd: string): Promise<DetectResult> {
    const probe = await this.probe();
    const installed = probe.installStatus === "installed";
    const tierPaths = this.paths(cwd);
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
      for (const sourcePath of this.paths(this.cwd)[tier]) {
        const raw = await readFileText(sourcePath);
        if (raw === null) {
          continue;
        }

        const parsed = isLegacyPath(sourcePath)
          ? parseLegacyMarkdown(raw)
          : parseMarkdown(raw);
        const identity = identityFor(sourcePath, this.id);
        const mtime = (await statMtime(sourcePath)) ?? 0;
        const meta: CursorMemoryDoc["meta"] = {
          tier,
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
        "CURSOR_READ_FAILED",
        `Failed to read Cursor ${tier} memory`,
        { cause: error },
      );
    }

    return docs;
  }

  async write(tier: Tier, docs: MemoryDoc[]): Promise<WriteReport> {
    const written: string[] = [];
    const skipped: string[] = [];

    try {
      const hasNewProjectRules =
        tier === "project" &&
        this.paths(this.cwd).project.some((filePath) => isMdcPath(filePath));

      for (const doc of docs) {
        if (doc.meta.tier !== tier) {
          skipped.push(doc.meta.sourcePath);
          continue;
        }

        const targetPath = this.targetPathForWrite(
          doc,
          tier,
          hasNewProjectRules,
        );
        if (targetPath !== doc.meta.sourcePath) {
          skipped.push(doc.meta.sourcePath);
        }

        const cursorDoc = doc as CursorMemoryDoc;
        const frontmatter = isLegacyPath(targetPath)
          ? null
          : (doc.meta.frontmatter ?? null);
        const rawHints =
          isLegacyPath(targetPath) && !isLegacyPath(doc.meta.sourcePath)
            ? undefined
            : cursorDoc.meta.rawHints;
        const content =
          rawHints === undefined
            ? serializeMarkdown(doc.body, frontmatter)
            : serializeMarkdown(doc.body, frontmatter, rawHints);

        await atomicWrite(targetPath, content);
        written.push(targetPath);
      }
    } catch (error) {
      throw new AdapterError(
        this.id,
        "write",
        "CURSOR_WRITE_FAILED",
        `Failed to write Cursor ${tier} memory`,
        { cause: error },
      );
    }

    return { written, skipped };
  }

  private targetPathForWrite(
    doc: MemoryDoc,
    tier: Tier,
    hasNewProjectRules: boolean,
  ): string {
    if (
      tier === "project" &&
      isLegacyPath(doc.meta.sourcePath) &&
      (this.migrateLegacy || hasNewProjectRules)
    ) {
      return path.join(this.cwd, ".cursor", "rules", "legacy.mdc");
    }

    return doc.meta.sourcePath;
  }
}

export function createCursorAdapter(
  cwd = process.cwd(),
  options: CursorAdapterOptions = {},
): CursorAdapter {
  return new CursorAdapter(cwd, options);
}

async function firstExistingDir(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await dirExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const filePath of paths) {
    if (await fileExists(filePath)) {
      return true;
    }
  }

  return false;
}

function listMdcFiles(dirPath: string, recursive: boolean): string[] {
  const files: string[] = [];

  for (const entry of readDirEntries(dirPath)) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...listMdcFiles(entryPath, true));
      }

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".mdc")) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function readDirEntries(dirPath: string): Dirent[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileExistsSync(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function identityFor(
  sourcePath: string,
  provider: typeof providerId,
): Pick<ReturnType<typeof deriveIdentityKey>, "identityKey" | "subtype"> {
  if (path.basename(sourcePath) === ".cursorrules") {
    return {
      identityKey: "rule:legacy",
      subtype: "rule",
    };
  }

  const identity = deriveIdentityKey(sourcePath, provider);

  return {
    identityKey: identity.identityKey,
    subtype: identity.subtype,
  };
}

function parseLegacyMarkdown(raw: string): ParsedMarkdown {
  const body = normalizeBody(raw);

  return {
    body,
    frontmatter: null,
    rawHints: {
      hadCRLF: raw.includes("\r\n"),
      hadBOM: raw.charCodeAt(0) === 0xfeff,
      trailingNewline: raw.endsWith("\n"),
      originalContent: raw,
      normalizedBody: body,
      frontmatterJson: "null",
    },
  };
}

function isLegacyPath(filePath: string): boolean {
  return path.basename(filePath) === ".cursorrules";
}

function isMdcPath(filePath: string): boolean {
  return path.basename(filePath).endsWith(".mdc");
}
