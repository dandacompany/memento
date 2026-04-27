import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AdapterRegistry } from "../../../../src/adapters/registry.js";
import { sha256Hex } from "../../../../src/adapters/shared/io.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "../../../../src/adapters/types.js";
import type { Cache } from "../../../../src/core/cache.js";
import { defaultConfig, saveConfig } from "../../../../src/core/config.js";
import type {
  MementoConfig,
  MemoryDoc,
  ProviderId,
  Tier,
} from "../../../../src/core/types.js";
import { fixtureDir } from "../../tmp-fixture.js";

let testRegistry: AdapterRegistry;

vi.mock("../../../../src/cli/helpers/registry.js", () => ({
  createCliRegistry: () => testRegistry,
}));

const { runSync } = await import("../../../../src/cli/commands/sync.js");

const originalCwd = process.cwd();
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  testRegistry = new AdapterRegistry();
  setStdoutIsTTY(false);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }
});

describe("runSync", () => {
  test("fresh sync with active providers and no memory writes nothing", async () => {
    const root = await projectWithConfig(["codex"]);
    const codex = mockAdapter("codex", [], { activeTiers: ["project"] });
    testRegistry.register(codex);
    process.chdir(root);
    const stdout = captureStdout();

    await writeCache(root, emptyCache());

    await expect(runSync({})).resolves.toBe(0);
    expect(stdout.text()).toContain("synced\t0");
    expect(codex.writeCalls).toHaveLength(0);
  });

  test("propagates one provider modified since cache", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "old", 100),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "new", 200),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(root, cacheWith("project/agents-md:main", "old"));

    await expect(runSync({})).resolves.toBe(0);
    expect(codex.docs[0]?.body).toBe("new");
    expect(gemini.writeCalls).toHaveLength(0);
  });

  test("conflict with lww resolves to the latest mtime", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "changed-a", 200),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "changed-b", 300),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(root, cacheWith("project/agents-md:main", "old"));

    await expect(runSync({ strategy: "lww" })).resolves.toBe(0);
    expect(codex.docs[0]?.body).toBe("changed-b");
  });

  test("conflict with fail returns exit 2", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    register(
      mockAdapter("codex", [
        memoryDoc("codex", path.join(root, "AGENTS.md"), "changed-a", 200),
      ]),
      mockAdapter("gemini-cli", [
        memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "changed-b", 300),
      ]),
    );
    process.chdir(root);
    await writeCache(root, cacheWith("project/agents-md:main", "old"));

    await expect(runSync({ strategy: "fail" })).resolves.toBe(2);
  });

  test("prompt strategy on non-TTY falls back to lww with warning", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const stderr = captureStderr();
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "changed-a", 200),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "changed-b", 300),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(root, cacheWith("project/agents-md:main", "old"));

    await expect(runSync({ strategy: "prompt" })).resolves.toBe(0);
    expect(stderr.text()).toContain("--strategy prompt requires a TTY");
    expect(codex.docs[0]?.body).toBe("changed-b");
  });

  test("dry-run does not write or update cache", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "changed-a", 200),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "changed-b", 300),
    ]);
    register(codex, gemini);
    process.chdir(root);
    const cache = cacheWith("project/agents-md:main", "old");
    await writeCache(root, cache);
    const before = await readCacheRaw(root);

    await expect(runSync({ dryRun: true, strategy: "lww" })).resolves.toBe(0);
    expect(codex.docs[0]?.body).toBe("changed-a");
    expect(codex.writeCalls).toHaveLength(0);
    await expect(readCacheRaw(root)).resolves.toBe(before);
  });

  test("provider filter only detects and syncs that adapter", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "same", 100),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "same", 100),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(root, emptyCache());

    await expect(runSync({ provider: "codex" })).resolves.toBe(0);
    expect(codex.detectCalls).toHaveBeenCalled();
    expect(gemini.detectCalls).not.toHaveBeenCalled();
  });

  test("tier project only excludes global tier", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "old", 100),
      memoryDoc("codex", path.join(root, "global-a.md"), "old-g", 100, {
        tier: "global",
      }),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "new", 200),
      memoryDoc("gemini-cli", path.join(root, "global-b.md"), "new-g", 200, {
        tier: "global",
      }),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(
      root,
      cacheWithMany([
        ["project/agents-md:main", "old"],
        ["global/agents-md:main", "old-g"],
      ]),
    );

    await expect(
      runSync({ tier: "project", includeGlobal: true }),
    ).resolves.toBe(0);
    expect(codex.docs[0]?.body).toBe("new");
    expect(codex.docs[1]?.body).toBe("old-g");
  });

  test("include-global includes the global tier", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "old", 100),
      memoryDoc("codex", path.join(root, "global-a.md"), "old-g", 100, {
        tier: "global",
      }),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "new", 200),
      memoryDoc("gemini-cli", path.join(root, "global-b.md"), "new-g", 200, {
        tier: "global",
      }),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(
      root,
      cacheWithMany([
        ["project/agents-md:main", "old"],
        ["global/agents-md:main", "old-g"],
      ]),
    );

    await expect(runSync({ includeGlobal: true })).resolves.toBe(0);
    expect(codex.docs[0]?.body).toBe("new");
    expect(codex.docs[1]?.body).toBe("new-g");
  });

  test("not initialized returns exit 3", async () => {
    const root = fixtureDir();
    process.chdir(root);

    await expect(runSync({})).resolves.toBe(3);
  });

  test("no active providers returns exit 4", async () => {
    const root = await projectWithConfig(["codex"]);
    testRegistry.register(mockAdapter("codex", [], { active: false }));
    process.chdir(root);

    await expect(runSync({})).resolves.toBe(4);
  });

  test("json output is a SyncReport object", async () => {
    const root = await projectWithConfig(["codex"]);
    const stdout = captureStdout();
    testRegistry.register(
      mockAdapter("codex", [
        memoryDoc("codex", path.join(root, "AGENTS.md"), "same"),
      ]),
    );
    process.chdir(root);
    await writeCache(root, emptyCache());

    await expect(runSync({ json: true })).resolves.toBe(0);
    const report = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(report).toMatchObject({
      groupsTotal: 1,
      groupsIdentical: 1,
      groupsPropagated: 0,
      groupsConflictResolved: 0,
      groupsSkipped: 0,
      groupsFailed: 0,
      cacheUpdated: true,
      dryRun: false,
    });
    expect(Array.isArray(report.writes)).toBe(true);
    expect(typeof report.durationMs).toBe("number");
  });

  test("yes coerces prompt to lww without trying prompt", async () => {
    const root = await projectWithConfig(["codex", "gemini-cli"]);
    const stderr = captureStderr();
    setStdoutIsTTY(true);
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "changed-a", 200),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      memoryDoc("gemini-cli", path.join(root, "GEMINI.md"), "changed-b", 300),
    ]);
    register(codex, gemini);
    process.chdir(root);
    await writeCache(root, cacheWith("project/agents-md:main", "old"));

    await expect(runSync({ strategy: "prompt", yes: true })).resolves.toBe(0);
    expect(codex.docs[0]?.body).toBe("changed-b");
    expect(stderr.text()).not.toContain("Conflict prompt is not available");
  });

  test("exclude paths from config are passed into sync", async () => {
    const root = await projectWithConfig(["codex"], {
      exclude: { paths: ["**/secret.md"] },
    });
    const codex = mockAdapter("codex", [
      memoryDoc("codex", path.join(root, "AGENTS.md"), "public", 100),
      memoryDoc("codex", path.join(root, "secret.md"), "private", 100, {
        identityKey: "rule:secret",
      }),
    ]);
    testRegistry.register(codex);
    process.chdir(root);
    await writeCache(root, emptyCache());

    await expect(runSync({})).resolves.toBe(0);
    const cache = await readCache(root);
    expect(Object.keys(cache.entries)).toEqual(["project/agents-md:main"]);
  });
});

class MockAdapter implements ProviderAdapter {
  readonly displayName: string;
  readonly writeCalls = vi.fn<(tier: Tier, docs: MemoryDoc[]) => void>();
  readonly detectCalls = vi.fn<() => void>();

  constructor(
    readonly id: ProviderId,
    readonly docs: MemoryDoc[],
    private readonly opts: {
      active?: boolean;
      activeTiers?: Tier[];
    } = {},
  ) {
    this.displayName = id;
  }

  async probe(): Promise<ProbeResult> {
    return { installStatus: "installed" };
  }

  paths(): TierPaths {
    return {
      project: this.pathsFor("project"),
      "project-local": this.pathsFor("project-local"),
      global: this.pathsFor("global"),
    };
  }

  async detect(): Promise<DetectResult> {
    this.detectCalls();

    const activeTiers =
      this.opts.activeTiers ??
      ([...new Set(this.docs.map((doc) => doc.meta.tier))] as Tier[]);

    return {
      installed: true,
      hasMemory: this.docs.length > 0,
      active: this.opts.active ?? true,
      activeTiers,
      probe: { installStatus: "installed" },
    };
  }

  async read(tier: Tier): Promise<MemoryDoc[]> {
    return this.docs.filter((doc) => doc.meta.tier === tier);
  }

  async write(tier: Tier, docs: MemoryDoc[]): Promise<WriteReport> {
    this.writeCalls(tier, docs);

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

  private pathsFor(tier: Tier): string[] {
    return this.docs
      .filter((doc) => doc.meta.tier === tier)
      .map((doc) => doc.meta.sourcePath);
  }
}

function mockAdapter(
  id: ProviderId,
  docs: MemoryDoc[],
  opts: { active?: boolean; activeTiers?: Tier[] } = {},
): MockAdapter {
  return new MockAdapter(id, docs, opts);
}

function register(...adapters: ProviderAdapter[]): void {
  for (const adapter of adapters) {
    testRegistry.register(adapter);
  }
}

function emptyCache(): Cache {
  return { version: 1, lastSyncAt: null, entries: {} };
}

function cacheWith(groupKey: string, body: string): Cache {
  return cacheWithMany([[groupKey, body]]);
}

function cacheWithMany(entries: [string, string][]): Cache {
  const cache = emptyCache();

  for (const [groupKey, body] of entries) {
    cache.entries[groupKey] = {
      bodyHash: sha256Hex(body),
      rawHashesByPath: {},
      lastResolvedFrom: "codex",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
  }

  return cache;
}

function memoryDoc(
  source: ProviderId,
  sourcePath: string,
  body: string,
  mtime = 1,
  opts: {
    identityKey?: string;
    tier?: Tier;
  } = {},
): MemoryDoc {
  const identityKey = opts.identityKey ?? "agents-md:main";
  const tier = opts.tier ?? "project";

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

async function projectWithConfig(
  enabledProviders: ProviderId[],
  overrides: Partial<MementoConfig> = {},
): Promise<string> {
  const root = fixtureDir();
  const mementoDir = path.join(root, ".memento");
  const config = {
    ...defaultConfig(enabledProviders),
    ...overrides,
  };

  await saveConfig(mementoDir, config);
  return root;
}

async function writeCache(root: string, cache: Cache): Promise<void> {
  await fs.writeFile(
    path.join(root, ".memento", "cache.json"),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

async function readCache(root: string): Promise<Cache> {
  const raw = await readCacheRaw(root);
  return JSON.parse(raw) as Cache;
}

async function readCacheRaw(root: string): Promise<string> {
  return fs.readFile(path.join(root, ".memento", "cache.json"), "utf8");
}

function captureStdout(): { text: () => string } {
  let output = "";

  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });

  return { text: () => output };
}

function captureStderr(): { text: () => string } {
  let output = "";

  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });

  return { text: () => output };
}
