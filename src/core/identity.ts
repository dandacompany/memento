import path from "node:path";

import { AdapterError } from "./errors.js";
import type { ProviderId, Subtype, Tier } from "./types.js";

interface IdentityResult {
  tier: Tier;
  identityKey: string;
  subtype: Subtype;
}

const AGENTS_MD_FILES = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  "CLAUDE.local.md",
  "AGENTS.local.md",
  "GEMINI.local.md",
  ".cursorrules",
  ".cursorrules.local",
  ".windsurfrules",
  ".windsurfrules.local",
]);

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function inferAgentsTier(filePath: string): Tier {
  const normalized = normalizePath(filePath);
  const basename = path.basename(filePath);

  if (
    normalized.includes("/.claude/") ||
    normalized.includes("/.codex/") ||
    normalized.includes("/.gemini/") ||
    normalized.includes("/.cursor/") ||
    normalized.includes("/.windsurf/")
  ) {
    return "global";
  }

  if (basename.includes(".local") || basename.endsWith(".local")) {
    return "project-local";
  }

  return "project";
}

function inferRuleTier(filePath: string): Tier {
  const normalized = normalizePath(filePath);
  const basename = path.basename(filePath);

  if (
    normalized.includes("/.cursor/rules/") ||
    normalized.includes("/.windsurf/rules/")
  ) {
    if (
      normalized.includes("/.cursor/rules/") &&
      normalized.startsWith(`${normalizePath(process.env.HOME ?? "")}/.cursor/`)
    ) {
      return "global";
    }

    if (
      normalized.includes("/.windsurf/rules/") &&
      normalized.startsWith(
        `${normalizePath(process.env.HOME ?? "")}/.windsurf/`,
      )
    ) {
      return "global";
    }
  }

  if (basename.includes(".local.")) {
    return "project-local";
  }

  return "project";
}

function inferAntigravityTier(filePath: string): Tier {
  const normalized = normalizePath(filePath);
  const basename = path.basename(filePath);

  if (
    normalized.includes("/.gemini/antigravity/") ||
    normalized.includes("/.antigravity/")
  ) {
    return "global";
  }

  if (basename.endsWith(".local.md")) {
    return "project-local";
  }

  return "project";
}

function stripKnownRuleExtension(basename: string): string {
  if (basename.endsWith(".local.mdc")) {
    return basename.slice(0, -".local.mdc".length);
  }

  if (basename.endsWith(".local.md")) {
    return basename.slice(0, -".local.md".length);
  }

  if (basename.endsWith(".mdc")) {
    return basename.slice(0, -".mdc".length);
  }

  if (basename.endsWith(".md")) {
    return basename.slice(0, -".md".length);
  }

  return basename;
}

function memoryBankSlug(normalized: string): string | null {
  const marker = "/memory-bank/";
  const markerIndex = normalized.indexOf(marker);
  const relative =
    markerIndex >= 0
      ? normalized.slice(markerIndex + marker.length)
      : normalized.startsWith("memory-bank/")
        ? normalized.slice("memory-bank/".length)
        : null;

  if (!relative || !relative.endsWith(".md")) {
    return null;
  }

  return relative.slice(0, -".md".length);
}

export function deriveIdentityKey(
  filePath: string,
  providerId: ProviderId,
): IdentityResult {
  const normalized = normalizePath(path.normalize(filePath));
  const basename = path.basename(filePath);

  if (AGENTS_MD_FILES.has(basename)) {
    return {
      tier: inferAgentsTier(filePath),
      identityKey: "agents-md:main",
      subtype: "agents-md",
    };
  }

  if (
    normalized.includes("/.cursor/rules/") &&
    (basename.endsWith(".mdc") || basename.endsWith(".local.mdc"))
  ) {
    const slug = stripKnownRuleExtension(basename);

    return {
      tier: inferRuleTier(filePath),
      identityKey: `rule:${slug}`,
      subtype: "rule",
    };
  }

  if (
    normalized.includes("/.windsurf/rules/") &&
    (basename.endsWith(".md") || basename.endsWith(".local.md"))
  ) {
    const slug = stripKnownRuleExtension(basename);

    return {
      tier: inferRuleTier(filePath),
      identityKey: `rule:${slug}`,
      subtype: "rule",
    };
  }

  if (
    normalized.endsWith("/.agent/skills/SKILL.md") ||
    normalized.includes("/.agent/skills/")
  ) {
    const parts = normalized.split("/");
    const skillIndex = parts.lastIndexOf("skills");
    const skillName = parts[skillIndex + 1];

    if (skillName && basename === "SKILL.md") {
      return {
        tier: inferAntigravityTier(filePath),
        identityKey: `skill:${skillName}`,
        subtype: "skill",
      };
    }
  }

  if (
    normalized.includes("/.gemini/antigravity/skills/") &&
    basename === "SKILL.md"
  ) {
    const parts = normalized.split("/");
    const skillIndex = parts.lastIndexOf("skills");
    const skillName = parts[skillIndex + 1];

    if (skillName) {
      return {
        tier: "global",
        identityKey: `skill:${skillName}`,
        subtype: "skill",
      };
    }
  }

  const bankSlug = memoryBankSlug(normalized);

  if (bankSlug) {
    return {
      tier: inferAntigravityTier(filePath),
      identityKey: `memory-bank:${bankSlug.replace(/\.local$/, "")}`,
      subtype: "memory-bank",
    };
  }

  throw new AdapterError(
    providerId,
    "read",
    "IDENTITY_UNRESOLVED",
    `Cannot derive identity for ${filePath}`,
    {
      hint: "Add an explicit mapping in .memento/config.toml or use a supported memory path.",
    },
  );
}

export function applyOverrides(
  key: string,
  mapping?: Record<string, string[]>,
): string {
  if (!mapping) {
    return key;
  }

  for (const [overrideKey, aliases] of Object.entries(mapping)) {
    if (overrideKey === key || aliases.includes(key)) {
      return overrideKey;
    }
  }

  return key;
}
