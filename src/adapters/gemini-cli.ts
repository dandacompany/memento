import type { ParsedMarkdown } from "./shared/markdown.js";
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
import { parseMarkdown, serializeMarkdown } from "./shared/markdown.js";
import {
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

type GeminiMemoryDoc = MemoryDoc & {
  meta: MemoryDoc["meta"] & {
    rawHints?: ParsedMarkdown["rawHints"];
  };
};

const providerId = "gemini-cli" as const;
const tierOrder: Tier[] = ["project", "project-local", "global"];

export class GeminiCliAdapter implements ProviderAdapter {
  readonly id = providerId;
  readonly displayName = "Gemini CLI";

  constructor(private readonly cwd = process.cwd()) {}

  async probe(): Promise<ProbeResult> {
    const binaryPath = await which("gemini");
    const configDirPath = expandHome("~/.gemini");

    if (binaryPath) {
      const version = await runCmdVersion(binaryPath);
      const configDir = (await dirExists(configDirPath))
        ? configDirPath
        : undefined;

      return {
        installStatus: "installed",
        binaryPath,
        configDirPath: configDir,
        version: version ?? undefined,
      };
    }

    if (await dirExists(configDirPath)) {
      return {
        installStatus: "unknown",
        configDirPath,
        hint: "Gemini CLI config directory exists, but the gemini binary was not found on PATH.",
      };
    }

    return {
      installStatus: "not-installed",
      hint: "Install Gemini CLI or create a Gemini memory file to activate this provider.",
    };
  }

  paths(cwd: string): TierPaths {
    return {
      project: [path.join(cwd, "GEMINI.md")],
      "project-local": [path.join(cwd, "GEMINI.local.md")],
      global: [expandHome("~/.gemini/GEMINI.md")],
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

        const parsed = parseMarkdown(raw);
        const identity = deriveIdentityKey(sourcePath, this.id);
        const mtime = (await statMtime(sourcePath)) ?? 0;
        const meta: GeminiMemoryDoc["meta"] = {
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
        "GEMINI_CLI_READ_FAILED",
        `Failed to read Gemini CLI ${tier} memory`,
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
        if (doc.meta.tier !== tier) {
          skipped.push(doc.meta.sourcePath);
          continue;
        }

        const geminiDoc = doc as GeminiMemoryDoc;
        const frontmatter = doc.meta.frontmatter ?? null;
        const rawHints = geminiDoc.meta.rawHints;
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
        "GEMINI_CLI_WRITE_FAILED",
        `Failed to write Gemini CLI ${tier} memory`,
        { cause: error },
      );
    }

    return { written, skipped };
  }
}

export function createGeminiCliAdapter(cwd = process.cwd()): GeminiCliAdapter {
  return new GeminiCliAdapter(cwd);
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const filePath of paths) {
    if (await fileExists(filePath)) {
      return true;
    }
  }

  return false;
}
