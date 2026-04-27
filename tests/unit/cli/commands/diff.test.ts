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

describe("runDiff", () => {
  test("all in-sync reports no differences by default", async () => {
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

    const { runDiff } = await importDiff();

    await expect(runDiff({})).resolves.toBe(0);
    expect(stdout).toBe("No differences\n");
    expect(stderr).toBe("");
    expect(await readCache(root)).toEqual(
      cacheWith("project/agents-md:main", "same"),
    );
  });

  test("modified group reports modified status", async () => {
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

    const { runDiff } = await importDiff();

    await expect(runDiff({})).resolves.toBe(0);
    expect(stdout).toContain("[modified] project/agents-md:main");
    expect(stdout).toContain("✓ codex @ /repo/AGENTS.md");
    expect(stdout).toContain("✓ gemini-cli @ /repo/GEMINI.md");
  });

  test("conflict group reports conflict status", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "old")]),
        mockAdapter("claude-code", [
          doc("claude-code", "/repo/CLAUDE.md", "new"),
        ]),
        mockAdapter("gemini-cli", [
          doc("gemini-cli", "/repo/GEMINI.md", "newer"),
        ]),
      ],
      cacheWith("project/agents-md:main", "old"),
    );
    process.chdir(root);

    const { runDiff } = await importDiff();

    await expect(runDiff({})).resolves.toBe(0);
    expect(stdout).toContain("[conflict] project/agents-md:main");
  });

  test("--group filters to a single group", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [
          doc("codex", "/repo/AGENTS.md", "old"),
          doc("codex", "/repo/rules/typescript.md", "ts", 1, "rule:typescript"),
        ]),
        mockAdapter("gemini-cli", [
          doc("gemini-cli", "/repo/GEMINI.md", "new"),
        ]),
      ],
      cacheWithEntries([
        ["project/agents-md:main", "old"],
        ["project/rule:typescript", "ts"],
      ]),
    );
    process.chdir(root);

    const { runDiff } = await importDiff();

    await expect(runDiff({ group: "project/rule:typescript" })).resolves.toBe(
      0,
    );
    expect(stdout).toContain("[identical] project/rule:typescript");
    expect(stdout).not.toContain("agents-md:main");
  });

  test("--all includes identical groups", async () => {
    const root = await initializedProject(
      [mockAdapter("codex", [doc("codex", "/repo/AGENTS.md", "same")])],
      cacheWith("project/agents-md:main", "same"),
    );
    process.chdir(root);

    const { runDiff } = await importDiff();

    await expect(runDiff({ all: true })).resolves.toBe(0);
    expect(stdout).toContain("[identical] project/agents-md:main");
  });

  test("--unified prints a text diff for differing sources", async () => {
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

    const { runDiff } = await importDiff();

    await expect(runDiff({ unified: true })).resolves.toBe(0);
    expect(stdout).toContain("--- codex @ /repo/AGENTS.md");
    expect(stdout).toContain("+++ gemini-cli @ /repo/GEMINI.md");
    expect(stdout).toContain("-old");
    expect(stdout).toContain("+new");
  });

  test("--json emits structured groups without source bodies", async () => {
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

    const { runDiff } = await importDiff();

    await expect(runDiff({ json: true })).resolves.toBe(0);
    const parsed = JSON.parse(stdout) as {
      groups: Array<{
        key: string;
        status: string;
        sources: Array<{ provider: string; body?: string }>;
      }>;
    };

    expect(parsed.groups).toEqual([
      expect.objectContaining({
        key: "project/agents-md:main",
        status: "modified",
      }),
    ]);
    expect(parsed.groups[0]?.sources[0]?.body).toBeUndefined();
  });

  test("not initialized returns exit 3", async () => {
    const root = fixtureDir();
    process.chdir(root);

    const { runDiff } = await importDiff();

    await expect(runDiff({})).resolves.toBe(3);
    expect(stderr).toContain("No .memento directory found");
    expect(stderr).toContain("Run `memento init` first.");
  });

  test("--tier limits output to that tier", async () => {
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
        ["project-local/agents-md:main", "old-local"],
      ]),
    );
    process.chdir(root);

    const { runDiff } = await importDiff();

    await expect(runDiff({ tier: "project-local", all: true })).resolves.toBe(
      0,
    );
    expect(stdout).toContain("project-local/agents-md:main");
    expect(stdout).not.toContain("[identical] project/agents-md:main");
  });

  test("--provider limits output to that provider", async () => {
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

    const { runDiff } = await importDiff();

    await expect(runDiff({ provider: "codex", all: true })).resolves.toBe(0);
    expect(stdout).toContain("✓ codex @ /repo/AGENTS.md");
    expect(stdout).not.toContain("gemini-cli");
  });

  test("--include-global includes global tier groups", async () => {
    const root = await initializedProject(
      [
        mockAdapter("codex", [
          doc("codex", "/repo/AGENTS.md", "project"),
          doc(
            "codex",
            "/home/.codex/AGENTS.md",
            "global-new",
            1,
            "agents-md:main",
            "global",
          ),
        ]),
        mockAdapter("gemini-cli", [
          doc(
            "gemini-cli",
            "/home/.gemini/GEMINI.md",
            "global-old",
            1,
            "agents-md:main",
            "global",
          ),
        ]),
      ],
      cacheWithEntries([
        ["project/agents-md:main", "project"],
        ["global/agents-md:main", "global-old"],
      ]),
    );
    process.chdir(root);

    const { runDiff } = await importDiff();

    await expect(runDiff({ includeGlobal: true })).resolves.toBe(0);
    expect(stdout).toContain("[modified] global/agents-md:main");
  });
});

async function importDiff(): Promise<
  typeof import("../../../../src/cli/commands/diff.js")
> {
  return import("../../../../src/cli/commands/diff.js");
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
    return {
      installed: this.installed,
      hasMemory: this.docs.length > 0,
      active: this.installed || this.docs.length > 0,
      activeTiers: [...new Set(this.docs.map((memory) => memory.meta.tier))],
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
): Promise<string> {
  const root = fixtureDir();
  const mementoDir = path.join(root, ".memento");
  const config = defaultConfig(adapters.map((adapter) => adapter.id));

  registryState.adapters = adapters;
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
