import { promises as fs } from "node:fs";
import path from "node:path";

import * as TOML from "@iarna/toml";

import { MementoError } from "./errors.js";
import type { MementoConfig, ProviderId } from "./types.js";

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
      };
      return acc;
    },
    {} as MementoConfigFile["providers"],
  );

  return {
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
