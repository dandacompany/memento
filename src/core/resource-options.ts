import { MementoError } from "./errors.js";
import type { ResourceKind, ResourceScope } from "./resource-types.js";

export const DEFAULT_RESOURCE_KINDS = [
  "memory",
  "skill",
  "mcp",
] as const satisfies readonly ResourceKind[];

export const DEFAULT_RESOURCE_SCOPE = "local" satisfies ResourceScope;

const resourceAliases = new Map<string, ResourceKind>([
  ["memory", "memory"],
  ["memories", "memory"],
  ["skill", "skill"],
  ["skills", "skill"],
  ["mcp", "mcp"],
  ["mcps", "mcp"],
]);

const resourceScopes = new Set<ResourceScope>([
  "local",
  "project",
  "cross-cli",
]);

export interface ResourceSelectionInput {
  resources?: string;
  noMcp?: boolean;
  noSkills?: boolean;
}

export function parseResourceKinds(
  input: ResourceSelectionInput = {},
): ResourceKind[] {
  const selected = input.resources
    ? parseExplicitResourceList(input.resources)
    : [...DEFAULT_RESOURCE_KINDS];

  const filtered = selected.filter((kind) => {
    if (kind === "mcp" && input.noMcp) {
      return false;
    }

    if (kind === "skill" && input.noSkills) {
      return false;
    }

    return true;
  });

  return [...new Set(filtered)];
}

export function parseResourceScope(value?: string): ResourceScope {
  if (!value) {
    return DEFAULT_RESOURCE_SCOPE;
  }

  if (resourceScopes.has(value as ResourceScope)) {
    return value as ResourceScope;
  }

  throw new MementoError(
    "INVALID_SCOPE",
    `Invalid resource scope: ${value}`,
    {
      exitCode: 2,
      hint: "Use one of: local, project, cross-cli.",
    },
  );
}

function parseExplicitResourceList(value: string): ResourceKind[] {
  const parts = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new MementoError("INVALID_RESOURCES", "No resources selected.", {
      exitCode: 2,
      hint: "Use a comma-separated list such as memory,skills,mcp.",
    });
  }

  return parts.map((part) => {
    const kind = resourceAliases.get(part);

    if (!kind) {
      throw new MementoError(
        "INVALID_RESOURCES",
        `Invalid resource kind: ${part}`,
        {
          exitCode: 2,
          hint: "Use one or more of: memory, skill, mcp.",
        },
      );
    }

    return kind;
  });
}
