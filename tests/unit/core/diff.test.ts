import path from "node:path";

import { describe, expect, test } from "vitest";

import { AdapterRegistry } from "../../../src/adapters/registry.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "../../../src/adapters/types.js";
import { sha256Hex } from "../../../src/adapters/shared/io.js";
import type { Cache } from "../../../src/core/cache.js";
import { computeDiffs } from "../../../src/core/diff.js";
import type { MemoryDoc, ProviderId, Tier } from "../../../src/core/types.js";
import { fixtureDir } from "../tmp-fixture.js";

describe("computeDiffs", () => {
  test("marks groups with matching hashes identical", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [memoryDoc("codex", "/repo/AGENTS.md", "same")]),
        mockAdapter("gemini-cli", [
          memoryDoc("gemini-cli", "/repo/GEMINI.md", "same"),
        ]),
      ),
      cache: cacheWith("project/agents-md:main", "same"),
      tierFilter: ["project"],
    });

    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      key: "project/agents-md:main",
      status: "identical",
    });
  });

  test("marks one changed hash against cache modified", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [memoryDoc("codex", "/repo/AGENTS.md", "old")]),
        mockAdapter("gemini-cli", [
          memoryDoc("gemini-cli", "/repo/GEMINI.md", "new"),
        ]),
      ),
      cache: cacheWith("project/agents-md:main", "old"),
      tierFilter: ["project"],
    });

    expect(diffs[0]?.status).toBe("modified");
  });

  test("marks multiple changed hashes against cache conflict", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [memoryDoc("codex", "/repo/AGENTS.md", "old")]),
        mockAdapter("claude-code", [
          memoryDoc("claude-code", "/repo/CLAUDE.md", "new"),
        ]),
        mockAdapter("gemini-cli", [
          memoryDoc("gemini-cli", "/repo/GEMINI.md", "newer"),
        ]),
      ),
      cache: cacheWith("project/agents-md:main", "old"),
      tierFilter: ["project"],
    });

    expect(diffs[0]?.status).toBe("conflict");
  });

  test("marks a single not-installed provider doc orphan", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter(
          "codex",
          [memoryDoc("codex", "/repo/AGENTS.md", "orphaned")],
          false,
        ),
      ),
      cache: cacheWith("project/agents-md:main", "orphaned"),
      tierFilter: ["project"],
    });

    expect(diffs[0]?.status).toBe("orphan");
  });

  test("uses mapping overrides when grouping aliases", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("cursor", [
          memoryDoc(
            "cursor",
            "/repo/.cursor/rules/typescript.mdc",
            "same",
            1,
            "rule:ts",
          ),
        ]),
        mockAdapter("windsurf", [
          memoryDoc(
            "windsurf",
            "/repo/.windsurf/rules/typescript.md",
            "same",
            1,
            "rule:typescript",
          ),
        ]),
      ),
      cache: cacheWith("project/rule:typescript", "same"),
      tierFilter: ["project"],
      mappingOverrides: {
        "rule:typescript": ["rule:ts"],
      },
    });

    expect(diffs.map((diff) => diff.key)).toEqual(["project/rule:typescript"]);
    expect(diffs[0]?.sources.map((source) => source.provider)).toEqual([
      "cursor",
      "windsurf",
    ]);
  });

  test("excludes paths before grouping", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [
          memoryDoc("codex", "/repo/AGENTS.md", "same"),
          memoryDoc("codex", "/repo/private.md", "secret", 1, "rule:private"),
        ]),
      ),
      cache: emptyCache(),
      tierFilter: ["project"],
      excludePaths: ["/repo/private.md"],
    });

    expect(diffs.map((diff) => diff.key)).toEqual(["project/agents-md:main"]);
  });

  test("keeps project and global tiers separate", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [
          memoryDoc("codex", "/repo/AGENTS.md", "project"),
          memoryDoc(
            "codex",
            "/home/.codex/AGENTS.md",
            "global",
            1,
            "agents-md:main",
            "global",
          ),
        ]),
      ),
      cache: emptyCache(),
      tierFilter: ["project", "global"],
    });

    expect(diffs.map((diff) => diff.key)).toEqual([
      "project/agents-md:main",
      "global/agents-md:main",
    ]);
  });

  test("treats cache misses with divergent hashes as conflicts", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [memoryDoc("codex", "/repo/AGENTS.md", "a")]),
        mockAdapter("gemini-cli", [
          memoryDoc("gemini-cli", "/repo/GEMINI.md", "b"),
        ]),
      ),
      cache: emptyCache(),
      tierFilter: ["project"],
    });

    expect(diffs[0]?.status).toBe("conflict");
  });

  test("treats cache misses with matching hashes as identical", async () => {
    const root = fixtureDir();
    const diffs = await computeDiffs({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(
        mockAdapter("codex", [memoryDoc("codex", "/repo/AGENTS.md", "same")]),
        mockAdapter("gemini-cli", [
          memoryDoc("gemini-cli", "/repo/GEMINI.md", "same"),
        ]),
      ),
      cache: emptyCache(),
      tierFilter: ["project"],
    });

    expect(diffs[0]?.status).toBe("identical");
  });
});

class MockAdapter implements ProviderAdapter {
  readonly displayName: string;

  constructor(
    readonly id: ProviderId,
    private readonly docs: MemoryDoc[],
    private readonly installed = true,
  ) {
    this.displayName = id;
  }

  async probe(): Promise<ProbeResult> {
    return { installStatus: this.installed ? "installed" : "not-installed" };
  }

  paths(): TierPaths {
    return {
      project: this.docs
        .filter((doc) => doc.meta.tier === "project")
        .map((doc) => doc.meta.sourcePath),
      "project-local": this.docs
        .filter((doc) => doc.meta.tier === "project-local")
        .map((doc) => doc.meta.sourcePath),
      global: this.docs
        .filter((doc) => doc.meta.tier === "global")
        .map((doc) => doc.meta.sourcePath),
    };
  }

  async detect(): Promise<DetectResult> {
    return {
      installed: this.installed,
      hasMemory: this.docs.length > 0,
      active: this.installed || this.docs.length > 0,
      activeTiers: [...new Set(this.docs.map((doc) => doc.meta.tier))],
      probe: await this.probe(),
    };
  }

  async read(tier: Tier): Promise<MemoryDoc[]> {
    return this.docs.filter((doc) => doc.meta.tier === tier);
  }

  async write(): Promise<WriteReport> {
    return { written: [], skipped: [] };
  }
}

function mockAdapter(
  id: ProviderId,
  docs: MemoryDoc[],
  installed = true,
): ProviderAdapter {
  return new MockAdapter(id, docs, installed);
}

function registryWith(...adapters: ProviderAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return registry;
}

function emptyCache(): Cache {
  return { version: 1, lastSyncAt: null, entries: {} };
}

function cacheWith(groupKey: string, body: string): Cache {
  const cache = emptyCache();
  cache.entries[groupKey] = {
    bodyHash: sha256Hex(body),
    rawHashesByPath: {},
    lastResolvedFrom: "codex",
    updatedAt: "2026-04-27T00:00:00.000Z",
  };

  return cache;
}

function memoryDoc(
  source: ProviderId,
  sourcePath: string,
  body: string,
  mtime = 1,
  identityKey = "agents-md:main",
  tier: Tier = "project",
): MemoryDoc {
  return {
    body,
    meta: {
      tier,
      identityKey,
      subtype: identityKey.startsWith("rule:") ? "rule" : "agents-md",
      source,
      sourcePath,
      mtime,
      bodyHash: sha256Hex(body),
      rawHash: sha256Hex(body),
    },
  };
}
