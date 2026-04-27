import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  loadCache,
  migrateCacheIfNeeded,
  saveCache,
  type Cache,
} from "../../src/core/cache.js";
import { MementoError } from "../../src/core/errors.js";
import type { Logger } from "../../src/core/logger.js";
import { fixtureDir } from "./tmp-fixture.js";

function testLogger() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
      startSpinner: vi.fn(),
      stopSpinner: vi.fn(),
    } satisfies Logger,
  };
}

describe("cache", () => {
  test("missing file returns empty cache", async () => {
    const { logger } = testLogger();
    const cache = await loadCache(
      "/tmp/memento-cache-does-not-exist.json",
      logger,
    );

    expect(cache).toEqual({
      version: 1,
      lastSyncAt: null,
      entries: {},
    });
  });

  test("corrupt JSON returns empty cache and logs warning", async () => {
    const root = fixtureDir();
    const cachePath = path.join(root, "cache.json");
    const { logger } = testLogger();
    await fs.writeFile(cachePath, "{ broken", "utf8");

    await expect(loadCache(cachePath, logger)).resolves.toEqual({
      version: 1,
      lastSyncAt: null,
      entries: {},
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  test("valid v1 cache is loaded as-is", async () => {
    const root = fixtureDir();
    const cachePath = path.join(root, "cache.json");
    const expected: Cache = {
      version: 1,
      lastSyncAt: "2026-04-25T00:00:00.000Z",
      entries: {
        "project/agents-md:main": {
          bodyHash: "body",
          rawHashesByPath: {
            "/repo/AGENTS.md": "raw",
          },
          lastResolvedFrom: "codex",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      },
    };
    await fs.writeFile(cachePath, JSON.stringify(expected), "utf8");

    await expect(loadCache(cachePath)).resolves.toEqual(expected);
  });

  test("unknown future version throws MementoError", () => {
    expect(() =>
      migrateCacheIfNeeded({
        version: 2,
        lastSyncAt: null,
        entries: {},
      }),
    ).toThrow(MementoError);

    try {
      migrateCacheIfNeeded({
        version: 2,
        lastSyncAt: null,
        entries: {},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MementoError);
      expect((error as MementoError).code).toBe("CACHE_VERSION_UNSUPPORTED");
    }
  });

  test("saveCache and loadCache round-trip", async () => {
    const root = fixtureDir();
    const cachePath = path.join(root, ".memento", "cache.json");
    const expected: Cache = {
      version: 1,
      lastSyncAt: null,
      entries: {
        "project/rule:typescript": {
          bodyHash: "body-hash",
          rawHashesByPath: {
            "/repo/.cursor/rules/typescript.mdc": "raw-hash",
          },
          lastResolvedFrom: "cursor",
          updatedAt: "2026-04-25T01:00:00.000Z",
        },
      },
    };

    await saveCache(cachePath, expected);
    await expect(loadCache(cachePath)).resolves.toEqual(expected);
  });
});
