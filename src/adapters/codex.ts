import type { ParsedMarkdown } from "./shared/markdown.js";
import path from "node:path";

import { AdapterError } from "../core/errors.js";
import { deriveIdentityKey } from "../core/identity.js";
import type {
  ResourceDoc,
  ResourceKind,
  ResourceScope,
} from "../core/resource-types.js";
import type { MemoryDoc, Tier } from "../core/types.js";
import {
  readSkillResources,
  writeSkillResources,
  type SkillRoot,
} from "../resources/skill.js";
import {
  readMcpResources,
  writeMcpResources,
  type McpRoot,
} from "../resources/mcp.js";
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
  ResourceCapability,
  TierPaths,
  WriteReport,
  ResourceWriteReport,
} from "./types.js";

type CodexMemoryDoc = MemoryDoc & {
  meta: MemoryDoc["meta"] & {
    rawHints?: ParsedMarkdown["rawHints"];
  };
};

const providerId = "codex" as const;
const tierOrder: Tier[] = ["project", "project-local", "global"];

export class CodexAdapter implements ProviderAdapter {
  readonly id = providerId;
  readonly displayName = "OpenAI Codex CLI";

  constructor(private readonly cwd = process.cwd()) {}

  async probe(): Promise<ProbeResult> {
    const binaryPath = await which("codex");
    const configDirPath = expandHome("~/.codex");

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
        hint: "Codex config directory exists, but the codex binary was not found on PATH.",
      };
    }

    return {
      installStatus: "not-installed",
      hint: "Install OpenAI Codex CLI or create a Codex memory file to activate this provider.",
    };
  }

  paths(cwd: string): TierPaths {
    return {
      project: [path.join(cwd, "AGENTS.md")],
      "project-local": [path.join(cwd, "AGENTS.local.md")],
      global: [expandHome("~/.codex/AGENTS.md")],
    };
  }

  resourceCapabilities(): ResourceCapability[] {
    return [
      {
        kind: "memory",
        scopes: ["local", "project", "cross-cli"],
        readable: true,
        writeable: true,
      },
      {
        kind: "skill",
        scopes: ["local", "project", "cross-cli"],
        readable: true,
        writeable: true,
      },
      {
        kind: "mcp",
        scopes: ["local", "project", "cross-cli"],
        readable: true,
        writeable: true,
      },
    ];
  }

  async readResources(
    kind: ResourceKind,
    scope: ResourceScope,
  ): Promise<ResourceDoc[]> {
    if (kind === "skill") {
      return readSkillResources(this.skillRoots(scope));
    }

    if (kind === "mcp") {
      return readMcpResources(this.mcpRoots(scope));
    }

    return [];
  }

  resourceWatchPaths(
    _cwd: string,
    scope: ResourceScope,
    kinds: ResourceKind[],
  ): string[] {
    const paths: string[] = [];

    if (kinds.includes("skill")) {
      paths.push(...this.skillRoots(scope).map((root) => root.path));
    }

    if (kinds.includes("mcp")) {
      paths.push(...this.mcpRoots(scope).map((root) => root.path));
    }

    return paths;
  }

  async writeResources(
    kind: ResourceKind,
    scope: ResourceScope,
    docs: ResourceDoc[],
  ): Promise<ResourceWriteReport> {
    if (kind === "skill") {
      return writeSkillResources(this.skillRoots(scope), docs);
    }

    if (kind === "mcp") {
      return writeMcpResources(this.mcpRoots(scope), docs);
    }

    return { written: [], skipped: docs.map((doc) => doc.meta.sourcePath) };
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
        const meta: CodexMemoryDoc["meta"] = {
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
        "CODEX_READ_FAILED",
        `Failed to read Codex ${tier} memory`,
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

        const codexDoc = doc as CodexMemoryDoc;
        const frontmatter = doc.meta.frontmatter ?? null;
        const rawHints = codexDoc.meta.rawHints;
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
        "CODEX_WRITE_FAILED",
        `Failed to write Codex ${tier} memory`,
        { cause: error },
      );
    }

    return { written, skipped };
  }

  private skillRoots(scope: ResourceScope): SkillRoot[] {
    const roots: SkillRoot[] = [];

    if (scope === "project" || scope === "local") {
      roots.push({
        path: path.join(this.cwd, ".agents", "skills"),
        provider: this.id,
        scope,
        tier: "project",
      });
    }

    if (scope === "local" || scope === "cross-cli") {
      roots.push(
        {
          path: expandHome("~/.agents/skills"),
          provider: this.id,
          scope,
          tier: "global",
        },
        {
          path: "/etc/codex/skills",
          provider: this.id,
          scope,
          tier: "global",
          writeable: false,
        },
      );
    }

    return roots;
  }

  private mcpRoots(scope: ResourceScope): McpRoot[] {
    const roots: McpRoot[] = [];

    if (scope === "project" || scope === "local") {
      roots.push({
        path: path.join(this.cwd, ".codex", "config.toml"),
        provider: this.id,
        scope,
        tier: "project",
        format: "toml",
      });
    }

    if (scope === "local" || scope === "cross-cli") {
      roots.push({
        path: expandHome("~/.codex/config.toml"),
        provider: this.id,
        scope,
        tier: "global",
        format: "toml",
      });
    }

    return roots;
  }
}

export function createCodexAdapter(cwd = process.cwd()): CodexAdapter {
  return new CodexAdapter(cwd);
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const filePath of paths) {
    if (await fileExists(filePath)) {
      return true;
    }
  }

  return false;
}
