import { promises as fs } from "node:fs";
import path from "node:path";

import { MementoError } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";
import type { ResourceKind } from "./resource-types.js";
import type { ProviderId } from "./types.js";

export interface Cache {
  version: 1;
  lastSyncAt: string | null;
  entries: Record<string, CacheEntry>;
}

export interface CacheEntry {
  bodyHash: string;
  rawHashesByPath: Record<string, string>;
  lastResolvedFrom: ProviderId | null;
  updatedAt: string;
}

export function resourceCacheKey(
  kind: ResourceKind,
  legacyGroupKey: string,
): string {
  return `${kind}/${legacyGroupKey}`;
}

export function getCacheEntry(
  cache: Cache,
  legacyGroupKey: string,
  kind: ResourceKind = "memory",
): CacheEntry | undefined {
  return (
    cache.entries[resourceCacheKey(kind, legacyGroupKey)] ??
    (kind === "memory" ? cache.entries[legacyGroupKey] : undefined)
  );
}

const emptyCache = (): Cache => ({
  version: 1,
  lastSyncAt: null,
  entries: {},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.bodyHash === "string" &&
    isRecord(value.rawHashesByPath) &&
    Object.values(value.rawHashesByPath).every(
      (hash) => typeof hash === "string",
    ) &&
    (value.lastResolvedFrom === null ||
      typeof value.lastResolvedFrom === "string") &&
    typeof value.updatedAt === "string"
  );
}

export function migrateCacheIfNeeded(raw: unknown): Cache {
  if (!isRecord(raw)) {
    return emptyCache();
  }

  if (raw.version !== 1) {
    throw new MementoError(
      "CACHE_VERSION_UNSUPPORTED",
      "Unsupported cache version",
      {
        hint: "Delete .memento/cache.json and run memento sync again.",
        exitCode: 1,
      },
    );
  }

  const entries: Record<string, CacheEntry> = {};

  if (isRecord(raw.entries)) {
    for (const [key, value] of Object.entries(raw.entries)) {
      if (isCacheEntry(value)) {
        entries[key] = value;
      }
    }
  }

  return {
    version: 1,
    lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
    entries,
  };
}

export async function loadCache(
  cachePath: string,
  logger: Logger = createLogger(),
): Promise<Cache> {
  let contents: string;

  try {
    contents = await fs.readFile(cachePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      logger.warn(
        `Cache file not found at ${cachePath}; starting with an empty cache.`,
      );
      return emptyCache();
    }

    throw error;
  }

  try {
    return migrateCacheIfNeeded(JSON.parse(contents));
  } catch (error) {
    if (error instanceof MementoError) {
      throw error;
    }

    logger.warn(
      `Cache file at ${cachePath} is corrupt; starting with an empty cache.`,
    );
    return emptyCache();
  }
}

export async function saveCache(
  cachePath: string,
  cache: Cache,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(cachePath),
    `.${path.basename(cachePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, cachePath);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
