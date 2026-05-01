import { promises as fs } from "node:fs";
import path from "node:path";

import * as TOML from "@iarna/toml";

import { MementoError } from "./errors.js";
import type { MementoConfig, ProviderId } from "./types.js";
import type { ResourceKind, ResourceScope } from "./resource-types.js";

export interface MementoConfigFile extends MementoConfig {
  version?: 1;
}

const providerIds = [
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "windsurf",
] as const satisfies readonly ProviderId[];

type ProviderConfig = MementoConfig["providers"][ProviderId];
type ResourceConfig = NonNullable<MementoConfig["resources"]>;
type ProviderResourceConfig = NonNullable<ProviderConfig["resources"]>[ResourceKind];
type JsonValue =
  | boolean
  | number
  | string
  | Date
  | JsonMap
  | boolean[]
  | number[]
  | string[]
  | Date[]
  | JsonMap[]
  | JsonMap[][];
interface JsonMap {
  [key: string]: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length === value.length ? strings : undefined;
}

function normalizeProviderConfig(
  value: unknown,
  fallback: ProviderConfig,
): ProviderConfig {
  if (!isRecord(value)) {
    return fallback;
  }

  return {
    enabled:
      typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    auto: typeof value.auto === "boolean" ? value.auto : fallback.auto,
    include_orphan:
      typeof value.include_orphan === "boolean"
        ? value.include_orphan
        : fallback.include_orphan,
    resources: normalizeProviderResources(value.resources, fallback.resources),
  };
}

function normalizeProviderResources(
  value: unknown,
  fallback: ProviderConfig["resources"],
): ProviderConfig["resources"] {
  if (!isRecord(value)) {
    return fallback;
  }

  return {
    memory: normalizeProviderResource(value.memory, fallback?.memory),
    skill: normalizeProviderResource(value.skill, fallback?.skill),
    mcp: normalizeProviderResource(value.mcp, fallback?.mcp),
  };
}

function normalizeProviderResource(
  value: unknown,
  fallback: ProviderResourceConfig | undefined,
): ProviderResourceConfig | undefined {
  if (!isRecord(value) && !fallback) {
    return undefined;
  }

  const record = isRecord(value) ? value : {};

  return {
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : (fallback?.enabled ?? false),
    write:
      typeof record.write === "boolean" ? record.write : (fallback?.write ?? true),
    experimental:
      typeof record.experimental === "boolean"
        ? record.experimental
        : fallback?.experimental,
  };
}

function normalizeDefaultScope(value: unknown): ResourceScope {
  return value === "project" || value === "cross-cli" || value === "local"
    ? value
    : "local";
}

function normalizeDefaultResources(value: unknown): ResourceKind[] {
  const values = stringArray(value);
  const allowed = new Set<ResourceKind>(["memory", "skill", "mcp"]);

  if (!values) {
    return ["memory", "skill", "mcp"];
  }

  const normalized = values.filter((item): item is ResourceKind =>
    allowed.has(item as ResourceKind),
  );

  return normalized.length > 0 ? [...new Set(normalized)] : ["memory", "skill", "mcp"];
}

function normalizeResources(value: unknown): ResourceConfig {
  const record = isRecord(value) ? value : {};
  const memory = isRecord(record.memory) ? record.memory : {};
  const skill = isRecord(record.skill) ? record.skill : {};
  const mcp = isRecord(record.mcp) ? record.mcp : {};
  const skillInclude = stringArray(skill.include);
  const skillExclude = stringArray(skill.exclude);

  return {
    memory: {
      enabled:
        typeof memory.enabled === "boolean" ? memory.enabled : true,
    },
    skill: {
      enabled: typeof skill.enabled === "boolean" ? skill.enabled : true,
      include: skillInclude ?? ["SKILL.md", "scripts/**", "assets/**", "references/**"],
      exclude: skillExclude ?? ["node_modules/**", ".*/**", "**/*.log"],
    },
    mcp: {
      enabled: typeof mcp.enabled === "boolean" ? mcp.enabled : true,
      redact_output:
        typeof mcp.redact_output === "boolean" ? mcp.redact_output : true,
      project_secret_policy:
        mcp.project_secret_policy === "fail" ||
        mcp.project_secret_policy === "placeholder" ||
        mcp.project_secret_policy === "env" ||
        mcp.project_secret_policy === "wizard"
          ? mcp.project_secret_policy
          : "wizard",
    },
  };
}

function normalizeConfig(value: unknown): MementoConfigFile {
  const fallback = defaultConfig([]);
  if (!isRecord(value)) {
    return fallback;
  }

  const providersValue = isRecord(value.providers) ? value.providers : {};
  const providers = providerIds.reduce<MementoConfigFile["providers"]>(
    (acc, providerId) => {
      acc[providerId] = normalizeProviderConfig(
        providersValue[providerId],
        fallback.providers[providerId],
      );
      return acc;
    },
    {} as MementoConfigFile["providers"],
  );

  const mappingValue = isRecord(value.mapping) ? value.mapping : undefined;
  const mapping = mappingValue
    ? Object.fromEntries(
        Object.entries(mappingValue).flatMap(([key, mapped]) => {
          const values = stringArray(mapped);
          return values ? [[key, values]] : [];
        }),
      )
    : undefined;

  const excludeValue = isRecord(value.exclude) ? value.exclude : undefined;
  const excludePaths = excludeValue
    ? stringArray(excludeValue.paths)
    : undefined;

  return {
    default_scope: normalizeDefaultScope(value.default_scope),
    default_resources: normalizeDefaultResources(value.default_resources),
    resources: normalizeResources(value.resources),
    providers,
    mapping,
    exclude: {
      paths: excludePaths ?? [],
    },
  };
}

function tomlSafeConfig(config: MementoConfigFile): JsonMap {
  return JSON.parse(JSON.stringify(config)) as JsonMap;
}

export function defaultConfig(
  activeProviders: ProviderId[],
): MementoConfigFile {
  const activeProviderSet = new Set<ProviderId>(activeProviders);
  const providers = providerIds.reduce<MementoConfigFile["providers"]>(
    (acc, providerId) => {
      acc[providerId] = {
        enabled: activeProviderSet.has(providerId),
        auto: true,
        include_orphan: false,
        resources: {
          memory: {
            enabled: true,
            write: true,
          },
          skill: {
            enabled: true,
            write: true,
          },
          mcp: {
            enabled: providerId !== "antigravity",
            write: providerId !== "antigravity",
            experimental: providerId === "antigravity" ? true : undefined,
          },
        },
      };
      return acc;
    },
    {} as MementoConfigFile["providers"],
  );

  return {
    default_scope: "local",
    default_resources: ["memory", "skill", "mcp"],
    resources: normalizeResources(undefined),
    providers,
    exclude: {
      paths: [],
    },
  };
}

export async function loadConfig(
  mementoDir: string,
): Promise<MementoConfigFile> {
  const configPath = path.join(mementoDir, "config.toml");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    return normalizeConfig(TOML.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return defaultConfig([]);
    }

    throw new MementoError(
      "CONFIG_PARSE_ERROR",
      "Failed to parse config.toml.",
      {
        exitCode: 1,
        hint: "Fix .memento/config.toml or remove it to use defaults.",
        cause: error,
      },
    );
  }
}

export async function saveConfig(
  mementoDir: string,
  config: MementoConfigFile,
): Promise<void> {
  await fs.mkdir(mementoDir, { recursive: true });

  const configPath = path.join(mementoDir, "config.toml");
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = TOML.stringify(tomlSafeConfig(config));

  await fs.writeFile(tmpPath, serialized, "utf8");
  await fs.rename(tmpPath, configPath);
}
