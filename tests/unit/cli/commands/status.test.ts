import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AdapterRegistry } from "../../../../src/adapters/registry.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "../../../../src/adapters/types.js";
import { sha256Hex } from "../../../../src/adapters/shared/io.js";
import type { Cache } from "../../../../src/core/cache.js";
import { defaultConfig, saveConfig } from "../../../../src/core/config.js";
import type {
  MemoryDoc,
  ProviderId,
  Tier,
} from "../../../../src/core/types.js";
import { fixtureDir } from "../../tmp-fixture.js";

const registryState = vi.hoisted(() => ({
  adapters: [] as ProviderAdapter[],
}));

vi.mock("../../../../src/cli/helpers/registry.js", () => ({
  createCliRegistry: () => {
    const registry = new AdapterRegistry();

    for (const adapter of registryState.adapters) {
      registry.register(adapter);
    }

    return registry;
  },
}));

const originalCwd = process.cwd();
let stdout = "";
let stderr = "";

beforeEach(() => {
  registryState.adapters = [];
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("runStatus", () => {
  test("all in-sync reports clean", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "same")]),
        mockAdapter("gemini-cli", [
          doc("gemini-cli", "/repo/GEMINI.md", "same"),
        ]),
      ],
      cacheWith("project/agents-md:main", "same"),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout).toContain("agents-md:main\tin-sync");
    expect(stdout).toContain("summary\tclean");
    expect(await readCache(root)).toEqual(
      cacheWith("project/agents-md:main", "same"),
    );
  });

  test("one provider modified against cache marks group modified", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "old")]),
        mockAdapter("gemini-cli", [
          doc("gemini-cli", "/repo/GEMINI.md", "new"),
        ]),
      ],
      cacheWith("project/agents-md:main", "old"),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout).toContain("agents-md:main\tmodified");
  });

  test("brand new provider group not in cache marks new", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [
          doc("codex", "/repo/rules/typescript.md", "rule", 1, "rule:ts"),
        ]),
      ],
      emptyCache(),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout).toContain("rule:ts\tnew");
  });

  test("not-installed provider with memory is flagged orphan", async () => {
    const root = await initializedProject(
      [
        mockAdapter(
          "codex",
          [doc("codex", "/repo/AGENTS.md", "orphaned")],
          false,
        ),
      ],
      cacheWith("project/agents-md:main", "orphaned"),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout).toContain("agents-md:main\torphan");
  });

  test("--include-global expands report to global tier", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [
          doc("codex", "/repo/AGENTS.md", "project"),
          doc(
            "codex",
            "/home/.codex/AGENTS.md",
            "global",
            1,
            "agents-md:main",
            "global",
          ),
        ]),
      ],
      cacheWithEntries([
        ["project/agents-md:main", "project"],
        ["global/agents-md:main", "global"],
      ]),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({ includeGlobal: true })).resolves.toBe(0);
    expect(stdout).toContain("project\tagents-md:main\tin-sync");
    expect(stdout).toContain("global\tagents-md:main\tin-sync");
  });

  test("--tier project only reports project tier", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [
          doc("codex", "/repo/AGENTS.md", "project"),
          doc(
            "codex",
            "/repo/AGENTS.local.md",
            "local",
            1,
            "agents-md:main",
            "project-local",
          ),
        ]),
      ],
      cacheWithEntries([
        ["project/agents-md:main", "project"],
        ["project-local/agents-md:main", "local"],
      ]),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({ tier: "project" })).resolves.toBe(0);
    expect(stdout).toContain("project\tagents-md:main\tin-sync");
    expect(stdout).not.toContain("project-local");
  });

  test("--json emits structured status report", async () => {
    const root = await initializedProject(
      [mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "same")])],
      cacheWith("project/agents-md:main", "same"),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({ json: true })).resolves.toBe(0);
    const parsed = JSON.parse(stdout) as {
      providers: unknown[];
      tiers: Record<string, { total: number; inSync: number }>;
      groups: Array<{ key: string; status: string; providers: string[] }>;
    };
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.tiers.project).toMatchObject({ total: 1, inSync: 1 });
    expect(parsed.groups).toEqual([
      expect.objectContaining({
        key: "project/agents-md:main",
        status: "in-sync",
        providers: ["codex"],
      }),
    ]);
  });

  test("not initialized returns exit 3 with init hint", async () => {
    const root = fixtureDir();
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(3);
    expect(stderr).toContain("No .memento directory found");
    expect(stderr).toContain("Run `memento init` first.");
  });

  test("mapping overrides group aliases under configured key", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "same")]),
        mockAdapter("gemini-cli", [
          doc("gemini-cli", "/repo/GEMINI.md", "same", 1, "agents-md:gemini"),
        ]),
      ],
      cacheWith("project/agents-md:main", "same"),
      {
        "agents-md:main": ["agents-md:gemini"],
      },
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout.match(/agents-md:main/g)?.length).toBe(1);
    expect(stdout).toContain("codex,gemini-cli");
  });

  test("exclude paths remove matching docs from the report", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [
          doc("codex", "/repo/AGENTS.md", "same"),
          doc("codex", "/repo/private.md", "secret", 1, "rule:private"),
        ]),
      ],
      cacheWith("project/agents-md:main", "same"),
      undefined,
      ["/repo/private.md"],
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout).toContain("agents-md:main");
    expect(stdout).not.toContain("rule:private");
  });

  test("TTY output uses rich badges and sections", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const root = await initializedProject(
      [mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "same")])],
      cacheWith("project/agents-md:main", "same"),
    );
    process.chdir(root);

    const { runStatus } = await importStatus();

    await expect(runStatus({})).resolves.toBe(0);
    expect(stdout).toContain("memento status");
    expect(stdout).toContain("✓ in-sync");
    expect(stdout).toContain("✓ clean");
  });
});

async function importStatus(): Promise<
  typeof import("../../../../src/cli/commands/status.js")
> {
  return import("../../../../src/cli/commands/status.js");
}

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
        .filter((memory) => memory.meta.tier === "project")
        .map((memory) => memory.meta.sourcePath),
      "project-local": this.docs
        .filter((memory) => memory.meta.tier === "project-local")
        .map((memory) => memory.meta.sourcePath),
      global: this.docs
        .filter((memory) => memory.meta.tier === "global")
        .map((memory) => memory.meta.sourcePath),
    };
  }

  async detect(): Promise<DetectResult> {
    const activeTiers = [
      ...new Set(this.docs.map((memory) => memory.meta.tier)),
    ];

    return {
      installed: this.installed,
      hasMemory: this.docs.length > 0,
      active: this.installed || this.docs.length > 0,
      activeTiers,
      probe: await this.probe(),
    };
  }

  async read(tier: Tier): Promise<MemoryDoc[]> {
    return this.docs.filter((memory) => memory.meta.tier === tier);
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

async function initializedProject(
  adapters: ProviderAdapter[],
  cache: Cache,
  mapping?: Record<string, string[]>,
  excludePaths: string[] = [],
): Promise<string> {
  const root = fixtureDir();
  const mementoDir = path.join(root, ".memento");
  const config = defaultConfig(adapters.map((adapter) => adapter.id));

  registryState.adapters = adapters;
  config.mapping = mapping;
  config.exclude = { paths: excludePaths };
  for (const adapter of adapters) {
    config.providers[adapter.id].include_orphan = true;
  }

  await fs.mkdir(mementoDir, { recursive: true });
  await saveConfig(mementoDir, config);
  await fs.writeFile(
    path.join(mementoDir, "cache.json"),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );

  return root;
}

function emptyCache(): Cache {
  return {
    version: 1,
    lastSyncAt: null,
    entries: {},
  };
}

function cacheWith(groupKey: string, body: string): Cache {
  return cacheWithEntries([[groupKey, body]]);
}

function cacheWithEntries(entries: Array<[string, string]>): Cache {
  const cache = emptyCache();

  for (const [key, body] of entries) {
    cache.entries[key] = {
      bodyHash: sha256Hex(body),
      rawHashesByPath: {},
      lastResolvedFrom: "codex",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
  }

  return cache;
}

function doc(
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

async function readCache(root: string): Promise<Cache> {
  const raw = await fs.readFile(
    path.join(root, ".memento", "cache.json"),
    "utf8",
  );

  return JSON.parse(raw) as Cache;
}
