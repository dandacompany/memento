import type { ParsedMarkdown } from "./shared/markdown.js";
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

type WindsurfMemoryDoc = MemoryDoc & {
  meta: MemoryDoc["meta"] & {
    rawHints?: ParsedMarkdown["rawHints"];
  };
};

export interface WindsurfAdapterOptions {
  migrateLegacy?: boolean;
}

const providerId = "windsurf" as const;
const tierOrder: Tier[] = ["project", "project-local", "global"];

export class WindsurfAdapter implements ProviderAdapter {
  readonly id = providerId;
  readonly displayName = "Windsurf";

  private readonly migrateLegacy: boolean;

  constructor(
    private readonly cwd = process.cwd(),
    options: WindsurfAdapterOptions = {},
  ) {
    this.migrateLegacy = options.migrateLegacy ?? false;
  }

  async probe(): Promise<ProbeResult> {
    const binaryPath = await which("windsurf");
    const configDirPath = expandHome("~/.windsurf");
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

    const installedAppPath = await firstExistingDir(appPath("Windsurf"));
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
        configDirPath,
        hint: "Windsurf config directory exists, but the windsurf binary or app install was not found.",
      };
    }

    return {
      installStatus: "not-installed",
      hint: "Install Windsurf or create a Windsurf rule file to activate this provider.",
    };
  }

  paths(cwd: string): TierPaths {
    const projectRulesDir = path.join(cwd, ".windsurf", "rules");
    const legacyPath = path.join(cwd, ".windsurfrules");
    const projectPaths = listMarkdownFiles(projectRulesDir, {
      recursive: false,
      includeLocal: false,
    });

    if (fileExistsSync(legacyPath)) {
      projectPaths.push(legacyPath);
    }

    return {
      project: projectPaths,
      "project-local": listMarkdownFiles(projectRulesDir, {
        recursive: false,
        onlyLocal: true,
      }),
      global: listMarkdownFiles(expandHome("~/.windsurf/rules"), {
        recursive: true,
      }),
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
        const meta: WindsurfMemoryDoc["meta"] = {
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
        "WINDSURF_READ_FAILED",
        `Failed to read Windsurf ${tier} memory`,
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
        if (
          doc.meta.tier !== tier ||
          this.isReadOnlyLegacy(doc.meta.sourcePath)
        ) {
          skipped.push(doc.meta.sourcePath);
          continue;
        }

        const windsurfDoc = doc as WindsurfMemoryDoc;
        const frontmatter = isLegacyPath(doc.meta.sourcePath)
          ? null
          : (doc.meta.frontmatter ?? null);
        const rawHints = windsurfDoc.meta.rawHints;
        const content =
          rawHints === undefined
            ? serializeMarkdown(doc.body, frontmatter)
            : serializeMarkdown(doc.body, frontmatter, rawHints);

        await atomicWrite(doc.meta.sourcePath, content);
        written.push(doc.meta.sourcePath);
      }
    } catch (error) {
      throw new AdapterError(
        this.id,
        "write",
        "WINDSURF_WRITE_FAILED",
        `Failed to write Windsurf ${tier} memory`,
        { cause: error },
      );
    }

    return { written, skipped };
  }

  private isReadOnlyLegacy(sourcePath: string): boolean {
    return this.migrateLegacy && isLegacyPath(sourcePath);
  }
}

export function createWindsurfAdapter(
  cwd = process.cwd(),
  options: WindsurfAdapterOptions = {},
): WindsurfAdapter {
  return new WindsurfAdapter(cwd, options);
}

async function firstExistingDir(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await dirExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

interface ListMarkdownFilesOptions {
  recursive: boolean;
  includeLocal?: boolean;
  onlyLocal?: boolean;
}

function listMarkdownFiles(
  dirPath: string,
  options: ListMarkdownFilesOptions,
): string[] {
  const files: string[] = [];

  walk(dirPath, options.recursive, files);

  return files
    .filter((filePath) => filePath.endsWith(".md"))
    .filter((filePath) => {
      const isLocal = path.basename(filePath).endsWith(".local.md");

      if (options.onlyLocal === true) {
        return isLocal;
      }

      return options.includeLocal === false ? !isLocal : true;
    })
    .sort((left, right) => left.localeCompare(right));
}

function walk(dirPath: string, recursive: boolean, files: string[]): void {
  let entries: Dirent[];

  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (recursive) {
        walk(entryPath, recursive, files);
      }
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
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
  if (isLegacyPath(sourcePath)) {
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
  return path.basename(filePath) === ".windsurfrules";
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const filePath of paths) {
    if (await fileExists(filePath)) {
      return true;
    }
  }

  return false;
}
