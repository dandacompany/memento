import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { AdapterRegistry } from "../../src/adapters/registry.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  ResourceWriteReport,
  TierPaths,
  WriteReport,
} from "../../src/adapters/types.js";
import { sha256Hex } from "../../src/adapters/shared/io.js";
import type { Cache } from "../../src/core/cache.js";
import { AdapterError } from "../../src/core/errors.js";
import type { ResourceDoc, ResourceKind, ResourceScope } from "../../src/core/resource-types.js";
import {
  applyExclusions,
  cachePrevForGroup,
  groupBy,
  resolveTierFilter,
  sync,
} from "../../src/core/sync.js";
import type { MemoryDoc, ProviderId, Tier } from "../../src/core/types.js";
import { fixtureDir } from "./tmp-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const quietLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
};

describe("resolveTierFilter", () => {
  test.each([
    [{}, ["project", "project-local"]],
    [{ tier: "global" as const }, ["global"]],
    [{ includeGlobal: true }, ["project", "project-local", "global"]],
    [{ globalOnly: true }, ["global"]],
    [
      { tier: "project-local" as const, includeGlobal: true, globalOnly: true },
      ["project-local"],
    ],
  ])("maps %j to %j", (opts, expected) => {
    expect(resolveTierFilter(opts)).toEqual(expected);
  });
});

describe("groupBy", () => {
  test("groups array items by computed key", () => {
    expect(groupBy([1, 2, 3, 4], (item) => String(item % 2))).toEqual(
      new Map([
        ["1", [1, 3]],
        ["0", [2, 4]],
      ]),
    );
  });
});

describe("applyExclusions", () => {
  test("returns the original docs when no patterns are provided", () => {
    const docs = [memoryDoc("codex", "/repo/AGENTS.md", "body")];

    expect(applyExclusions(docs)).toBe(docs);
  });

  test("excludes docs by exact path and globstar patterns", () => {
    const docs = [
      memoryDoc("codex", "/repo/AGENTS.md", "a"),
      memoryDoc("codex", "/repo/private/secret.md", "b"),
      memoryDoc("codex", "/repo/rules/typescript.md", "c", 1, "rule:ts"),
    ];

    expect(
      applyExclusions(docs, ["/repo/AGENTS.md", "**/private/*.md"]).map(
        (doc) => doc.meta.sourcePath,
      ),
    ).toEqual(["/repo/rules/typescript.md"]);
  });

  test("excludes docs by basename-only patterns", () => {
    const docs = [
      memoryDoc("codex", "/repo/AGENTS.md", "a"),
      memoryDoc("codex", "/repo/CLAUDE.local.md", "b"),
    ];

    expect(
      applyExclusions(docs, ["*.local.md"]).map((doc) => doc.meta.sourcePath),
    ).toEqual(["/repo/AGENTS.md"]);
  });
});

describe("cachePrevForGroup", () => {
  test("returns previous body hash and timestamp for a cache hit", () => {
    const cache = emptyCache();
    cache.entries["project/agents-md:main"] = {
      bodyHash: "abc",
      rawHashesByPath: {},
      lastResolvedFrom: "codex",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };

    expect(cachePrevForGroup(cache, "project/agents-md:main")).toEqual({
      bodyHash: "abc",
      mtime: Date.parse("2026-04-27T00:00:00.000Z"),
    });
  });

  test("returns undefined for a cache miss", () => {
    expect(cachePrevForGroup(emptyCache(), "missing")).toBeUndefined();
  });
});

describe("sync", () => {
  test("single Claude adapter with no memory is a no-op", async () => {
    const root = fixtureDir();
    const cwd = path.join(root, "repo");
    const home = await makeHome(root);
    await fs.mkdir(cwd, { recursive: true });
    stubHome(home);
    vi.stubEnv("PATH", "");
    const registry = new AdapterRegistry();
    registry.register(new ClaudeCodeAdapter(cwd));

    const report = await sync({
      cwd,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache: emptyCache(),
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsTotal).toBe(0);
    expect(report.writes).toEqual([]);
    expect(report.cacheUpdated).toBe(true);
  });

  test("single Claude adapter with one file is identical with no writes", async () => {
    const root = fixtureDir();
    const cwd = path.join(root, "repo");
    const home = await makeHome(root);
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# Memory\n", "utf8");
    stubHome(home);
    vi.stubEnv("PATH", "");
    const registry = new AdapterRegistry();
    registry.register(new ClaudeCodeAdapter(cwd));

    const report = await sync({
      cwd,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache: emptyCache(),
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsTotal).toBe(1);
    expect(report.groupsIdentical).toBe(1);
    expect(report.writes).toEqual([]);
  });

  test("two mock adapters with the same body are identical with no writes", async () => {
    const root = fixtureDir();
    const registry = registryWith(
      mockAdapter("codex", [memoryDoc("codex", "/repo/AGENTS.md", "same")]),
      mockAdapter("gemini-cli", [
        memoryDoc("gemini-cli", "/repo/GEMINI.md", "same"),
      ]),
    );

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache: emptyCache(),
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsTotal).toBe(1);
    expect(report.groupsIdentical).toBe(1);
    expect(report.writes).toEqual([]);
  });

  test("two mock adapters with only one changed since cache propagate to the other", async () => {
    const root = fixtureDir();
    const oldDoc = memoryDoc("codex", "/repo/AGENTS.md", "old", 100);
    const changedDoc = memoryDoc("gemini-cli", "/repo/GEMINI.md", "new", 200);
    const codex = mockAdapter("codex", [oldDoc]);
    const gemini = mockAdapter("gemini-cli", [changedDoc]);
    const registry = registryWith(codex, gemini);
    const cache = cacheWith("project/agents-md:main", "old");

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache,
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsPropagated).toBe(1);
    expect(report.writes).toEqual([
      {
        provider: "codex",
        tier: "project",
        written: ["/repo/AGENTS.md"],
        skipped: [],
      },
    ]);
    expect(codex.docs[0]?.body).toBe("new");
    expect(gemini.writeCalls).toHaveLength(0);
  });

  test("two mock adapters both changed since cache resolve with lww and write older target", async () => {
    const root = fixtureDir();
    const codex = mockAdapter("codex", [
      memoryDoc("codex", "/repo/AGENTS.md", "changed-a", 200),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", "/repo/GEMINI.md", "changed-b", 300),
    ]);
    const registry = registryWith(codex, gemini);

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache: cacheWith("project/agents-md:main", "old"),
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsConflictResolved).toBe(1);
    expect(report.writes).toEqual([
      {
        provider: "codex",
        tier: "project",
        written: ["/repo/AGENTS.md"],
        skipped: [],
      },
    ]);
    expect(codex.docs[0]?.body).toBe("changed-b");
  });

  test("dryRun with conflict populates counters but skips backup write and cache update", async () => {
    const root = fixtureDir();
    const codex = mockAdapter("codex", [
      memoryDoc("codex", "/repo/AGENTS.md", "changed-a", 200),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", "/repo/GEMINI.md", "changed-b", 300),
    ]);

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, gemini),
      cache: cacheWith("project/agents-md:main", "old"),
      dryRun: true,
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsConflictResolved).toBe(1);
    expect(report.writes).toEqual([]);
    expect(report.cacheUpdated).toBe(false);
    expect(codex.writeCalls).toHaveLength(0);
    await expect(
      fs.stat(path.join(root, ".memento", "backup")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("excludePaths drops docs before grouping", async () => {
    const root = fixtureDir();
    const registry = registryWith(
      mockAdapter("codex", [
        memoryDoc("codex", "/repo/AGENTS.md", "same"),
        memoryDoc("codex", "/repo/secret.md", "private", 1, "rule:secret"),
      ]),
    );

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache: emptyCache(),
      excludePaths: ["**/secret.md"],
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsTotal).toBe(1);
    expect(Object.keys(await readCache(path.join(root, ".memento")))).toEqual([
      "project/agents-md:main",
    ]);
  });

  test("provider filter warns and does no work for inactive provider", async () => {
    const root = fixtureDir();
    const codex = mockAdapter("codex", [], false);
    const registry = registryWith(codex);
    const logger = { ...quietLogger, warn: vi.fn() };

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry,
      cache: emptyCache(),
      provider: "codex",
      strategy: "lww",
      isTTY: false,
      logger,
    });

    expect(report.groupsTotal).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider codex is not active; skipping sync.",
    );
  });

  test("adapter write AdapterError increments failed groups and continues", async () => {
    const root = fixtureDir();
    const codex = mockAdapter(
      "codex",
      [memoryDoc("codex", "/repo/AGENTS.md", "old", 100)],
      true,
      true,
    );
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", "/repo/GEMINI.md", "new", 200),
    ]);

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, gemini),
      cache: cacheWith("project/agents-md:main", "old"),
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsPropagated).toBe(1);
    expect(report.groupsFailed).toBe(1);
    expect(report.writes).toEqual([]);
    expect(await readCache(path.join(root, ".memento"))).toMatchObject({
      "project/agents-md:main": { bodyHash: sha256Hex("old") },
    });
  });

  test("global memory sync creates a missing Codex global target", async () => {
    const root = fixtureDir();
    const codexPath = path.join(root, "home", ".codex", "AGENTS.md");
    const geminiPath = path.join(root, "home", ".gemini", "GEMINI.md");
    const codex = mockAdapter("codex", [], true, false, [], {
      global: [codexPath],
    });
    const gemini = mockAdapter(
      "gemini-cli",
      [
        memoryDoc(
          "gemini-cli",
          geminiPath,
          "# Global\n",
          100,
          "agents-md:main",
          "global",
        ),
      ],
      true,
      false,
      [],
      { global: [geminiPath] },
    );

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, gemini),
      cache: emptyCache(),
      globalOnly: true,
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsPropagated).toBe(1);
    expect(report.writes).toEqual([
      {
        provider: "codex",
        tier: "global",
        written: [codexPath],
        skipped: [],
      },
    ]);
    expect(codex.docs).toHaveLength(1);
    expect(codex.docs[0]).toMatchObject({
      body: "# Global\n",
      meta: {
        tier: "global",
        identityKey: "agents-md:main",
        source: "codex",
        sourcePath: codexPath,
      },
    });
    await expect(
      fs.stat(path.join(root, ".memento", "backup")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("global memory sync does not create an excluded missing target", async () => {
    const root = fixtureDir();
    const codexPath = path.join(root, "home", ".codex", "AGENTS.md");
    const geminiPath = path.join(root, "home", ".gemini", "GEMINI.md");
    const codex = mockAdapter("codex", [], true, false, [], {
      global: [codexPath],
    });
    const gemini = mockAdapter(
      "gemini-cli",
      [
        memoryDoc(
          "gemini-cli",
          geminiPath,
          "# Global\n",
          100,
          "agents-md:main",
          "global",
        ),
      ],
      true,
      false,
      [],
      { global: [geminiPath] },
    );

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, gemini),
      cache: emptyCache(),
      globalOnly: true,
      excludePaths: [codexPath],
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsIdentical).toBe(1);
    expect(report.writes).toEqual([]);
    expect(codex.docs).toHaveLength(0);
  });

  test("global memory sync does not duplicate shared global paths", async () => {
    const root = fixtureDir();
    const sharedPath = path.join(root, "home", ".gemini", "GEMINI.md");
    const gemini = mockAdapter(
      "gemini-cli",
      [
        memoryDoc(
          "gemini-cli",
          sharedPath,
          "# Shared\n",
          100,
          "agents-md:main",
          "global",
        ),
      ],
      true,
      false,
      [],
      { global: [sharedPath] },
    );
    const antigravity = mockAdapter("antigravity", [], true, false, [], {
      global: [sharedPath],
    });

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(gemini, antigravity),
      cache: emptyCache(),
      globalOnly: true,
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsIdentical).toBe(1);
    expect(report.writes).toEqual([]);
    expect(antigravity.docs).toHaveLength(0);
  });

  test("skill resource sync creates missing provider targets", async () => {
    const root = fixtureDir();
    const codex = mockAdapter("codex", [], true, false, [
      skillDoc("codex", "/repo/.agents/skills/review", "# Review\n", 100),
    ]);
    const claude = mockAdapter("claude-code", []);

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, claude),
      cache: emptyCache(),
      resourceKinds: ["skill"],
      resourceScope: "project",
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsPropagated).toBe(1);
    expect(report.writes).toEqual([
      {
        provider: "claude-code",
        tier: "project",
        written: ["claude-code/skill:review"],
        skipped: [],
      },
    ]);
    expect(claude.resourceDocs).toHaveLength(1);
    expect(claude.resourceDocs[0]).toMatchObject({
      kind: "skill",
      meta: {
        provider: "claude-code",
        identityKey: "skill:review",
      },
    });
  });

  test("skill resource sync resolves conflicts with latest mtime", async () => {
    const root = fixtureDir();
    const codex = mockAdapter("codex", [], true, false, [
      skillDoc("codex", "/repo/.agents/skills/review", "# Old\n", 100),
    ]);
    const claude = mockAdapter("claude-code", [], true, false, [
      skillDoc("claude-code", "/repo/.claude/skills/review", "# New\n", 200),
    ]);

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, claude),
      cache: emptyCache(),
      resourceKinds: ["skill"],
      resourceScope: "project",
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsConflictResolved).toBe(1);
    expect(codex.resourceDocs[0]?.body).toMatchObject({
      type: "skill-bundle",
      files: [
        {
          relativePath: "SKILL.md",
          content: "# New\n",
        },
      ],
    });
  });

  test("mcp resource sync creates missing provider targets", async () => {
    const root = fixtureDir();
    const codex = mockAdapter("codex", [], true, false, [
      mcpDoc("codex", "/repo/.codex/config.toml", "playwright", 100),
    ]);
    const claude = mockAdapter("claude-code", []);

    const report = await sync({
      cwd: root,
      mementoDir: path.join(root, ".memento"),
      registry: registryWith(codex, claude),
      cache: emptyCache(),
      resourceKinds: ["mcp"],
      resourceScope: "project",
      strategy: "lww",
      isTTY: false,
      logger: quietLogger,
    });

    expect(report.groupsPropagated).toBe(1);
    expect(claude.resourceDocs[0]).toMatchObject({
      kind: "mcp",
      body: {
        type: "mcp-server",
        server: {
          name: "playwright",
          command: "npx",
        },
      },
      meta: {
        provider: "claude-code",
        identityKey: "mcp:playwright",
      },
    });
  });
});

class MockAdapter implements ProviderAdapter {
  readonly displayName: string;
  readonly writeCalls = vi.fn<(tier: Tier, docs: MemoryDoc[]) => void>();
  readonly resourceWriteCalls = vi.fn<
    (kind: ResourceKind, scope: ResourceScope, docs: ResourceDoc[]) => void
  >();

  constructor(
    readonly id: ProviderId,
    readonly docs: MemoryDoc[],
    private readonly active = true,
    private readonly failWrite = false,
    readonly resourceDocs: ResourceDoc[] = [],
    private readonly memoryPaths: Partial<TierPaths> = {},
  ) {
    this.displayName = id;
  }

  async probe(): Promise<ProbeResult> {
    return { installStatus: "installed" };
  }

  paths(): TierPaths {
    return {
      project:
        this.memoryPaths.project ??
        this.docs
          .filter((doc) => doc.meta.tier === "project")
          .map((doc) => doc.meta.sourcePath),
      "project-local":
        this.memoryPaths["project-local"] ??
        this.docs
          .filter((doc) => doc.meta.tier === "project-local")
          .map((doc) => doc.meta.sourcePath),
      global:
        this.memoryPaths.global ??
        this.docs
          .filter((doc) => doc.meta.tier === "global")
          .map((doc) => doc.meta.sourcePath),
    };
  }

  async detect(): Promise<DetectResult> {
    const tiers = [...new Set(this.docs.map((doc) => doc.meta.tier))] as Tier[];

    return {
      installed: true,
      hasMemory: this.docs.length > 0,
      active: this.active,
      activeTiers: tiers,
      probe: { installStatus: "installed" },
    };
  }

  async read(tier: Tier): Promise<MemoryDoc[]> {
    return this.docs.filter((doc) => doc.meta.tier === tier);
  }

  async write(tier: Tier, docs: MemoryDoc[]): Promise<WriteReport> {
    this.writeCalls(tier, docs);

    if (this.failWrite) {
      throw new AdapterError(this.id, "write", "MOCK_WRITE_FAILED", "failed");
    }

    const written: string[] = [];
    const skipped: string[] = [];

    for (const doc of docs) {
      if (doc.meta.tier !== tier) {
        skipped.push(doc.meta.sourcePath);
        continue;
      }

      const index = this.docs.findIndex(
        (existing) => existing.meta.sourcePath === doc.meta.sourcePath,
      );

      if (index >= 0) {
        this.docs[index] = doc;
      } else {
        this.docs.push(doc);
      }

      written.push(doc.meta.sourcePath);
    }

    return { written, skipped };
  }

  async readResources(
    kind: ResourceKind,
    scope: ResourceScope,
  ): Promise<ResourceDoc[]> {
    return this.resourceDocs.filter(
      (doc) => doc.kind === kind && doc.meta.scope === scope,
    );
  }

  async writeResources(
    kind: ResourceKind,
    scope: ResourceScope,
    docs: ResourceDoc[],
  ): Promise<ResourceWriteReport> {
    this.resourceWriteCalls(kind, scope, docs);

    const written: string[] = [];
    const skipped: string[] = [];

    for (const doc of docs) {
      if (doc.kind !== kind || doc.meta.scope !== scope) {
        skipped.push(doc.meta.sourcePath);
        continue;
      }

      const target = {
        ...doc,
        meta: {
          ...doc.meta,
          sourcePath: doc.meta.sourcePath || `${this.id}/${doc.meta.identityKey}`,
        },
      };
      const index = this.resourceDocs.findIndex(
        (existing) =>
          existing.kind === target.kind &&
          existing.meta.identityKey === target.meta.identityKey,
      );

      if (index >= 0) {
        this.resourceDocs[index] = target;
      } else {
        this.resourceDocs.push(target);
      }

      written.push(target.meta.sourcePath);
    }

    return { written, skipped };
  }
}

function mockAdapter(
  id: ProviderId,
  docs: MemoryDoc[],
  active = true,
  failWrite = false,
  resourceDocs: ResourceDoc[] = [],
  memoryPaths: Partial<TierPaths> = {},
): MockAdapter {
  return new MockAdapter(
    id,
    docs,
    active,
    failWrite,
    resourceDocs,
    memoryPaths,
  );
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

function skillDoc(
  provider: ProviderId,
  sourcePath: string,
  content: string,
  mtime = 1,
): ResourceDoc {
  const body = {
    type: "skill-bundle" as const,
    files: [
      {
        relativePath: "SKILL.md",
        contentHash: sha256Hex(content),
        content,
        binary: false,
      },
    ],
  };
  const bodyHash = sha256Hex(JSON.stringify(body.files));

  return {
    kind: "skill",
    body,
    meta: {
      provider,
      scope: "project",
      tier: "project",
      identityKey: "skill:review",
      sourcePath,
      sourceFormat: "directory",
      sensitive: false,
      redactions: [],
      mtime,
      bodyHash,
      rawHash: bodyHash,
    },
  };
}

function mcpDoc(
  provider: ProviderId,
  sourcePath: string,
  name: string,
  mtime = 1,
): ResourceDoc {
  const server = {
    name,
    transport: "stdio" as const,
    command: "npx",
    args: ["@playwright/mcp@latest"],
  };
  const bodyHash = sha256Hex(JSON.stringify(server));

  return {
    kind: "mcp",
    body: {
      type: "mcp-server",
      server,
    },
    meta: {
      provider,
      scope: "project",
      tier: "project",
      identityKey: `mcp:${name}`,
      sourcePath,
      sourceFormat: "toml",
      sensitive: false,
      redactions: [],
      mtime,
      bodyHash,
      rawHash: bodyHash,
    },
  };
}

async function makeHome(root: string): Promise<string> {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });

  return home;
}

function stubHome(home: string): void {
  vi.spyOn(os, "homedir").mockReturnValue(home);
}

async function readCache(mementoDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(mementoDir, "cache.json"), "utf8");
  const parsed = JSON.parse(raw) as Cache;

  return parsed.entries;
}
