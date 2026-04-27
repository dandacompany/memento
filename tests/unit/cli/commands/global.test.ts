import { promises as fs } from "node:fs";
import os from "node:os";
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
import { createBackup } from "../../../../src/core/backup.js";
import type { Cache } from "../../../../src/core/cache.js";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
} from "../../../../src/core/config.js";
import type {
  MemoryDoc,
  ProviderId,
  Tier,
} from "../../../../src/core/types.js";
import { fixtureDir } from "../../tmp-fixture.js";

const registryState = vi.hoisted(() => ({
  adapters: [] as ProviderAdapter[],
}));

const watchState = vi.hoisted(() => ({
  on: vi.fn(),
  watch: vi.fn(),
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

vi.mock("chokidar", () => ({
  default: {
    watch: watchState.watch,
  },
  watch: watchState.watch,
}));

const {
  runGlobalDiff,
  runGlobalInit,
  runGlobalRestore,
  runGlobalStatus,
  runGlobalSync,
  runGlobalWatch,
} = await import("../../../../src/cli/commands/global.js");
const { createProgram } = await import("../../../../src/cli/index.js");

const originalCwd = process.cwd();
let stdout = "";
let stderr = "";

beforeEach(() => {
  registryState.adapters = [];
  stdout = "";
  stderr = "";
  process.exitCode = undefined;
  watchState.on.mockReturnThis();
  watchState.watch.mockReturnValue({
    on: watchState.on,
    close: vi.fn(),
  });
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

describe("global commands", () => {
  test("memento global init creates ~/.memento and writes config", async () => {
    const home = useHome();
    registryState.adapters = [
      mockAdapter("codex", [
        doc("codex", path.join(home, ".codex", "AGENTS.md"), "global", {
          tier: "global",
        }),
      ]),
    ];

    await expect(runGlobalInit({})).resolves.toBe(0);

    const config = await loadConfig(path.join(home, ".memento"));
    expect(config.providers.codex.enabled).toBe(true);
    await expect(
      fs.readFile(path.join(home, ".memento", "config.toml"), "utf8"),
    ).resolves.toContain("[providers.codex]");
    await expect(fs.stat(path.join(home, ".gitignore"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("memento global status reads from global context", async () => {
    const home = useHome();
    await initializedGlobal(home, [
      mockAdapter("codex", [
        doc("codex", path.join(home, ".codex", "AGENTS.md"), "same", {
          tier: "global",
          identityKey: "agents-md:global",
        }),
        doc("codex", "/repo/AGENTS.md", "project", {
          tier: "project",
          identityKey: "agents-md:project",
        }),
      ]),
    ]);

    await expect(runGlobalStatus({})).resolves.toBe(0);

    expect(stdout).toContain("global\tagents-md:global");
    expect(stdout).not.toContain("agents-md:project");
  });

  test("memento global sync reads and writes global tier only", async () => {
    const home = useHome();
    const codex = mockAdapter("codex", [
      doc("codex", "/repo/AGENTS.md", "project-old", {
        tier: "project",
        identityKey: "agents-md:project",
      }),
      doc("codex", path.join(home, ".codex", "AGENTS.md"), "global-old", {
        tier: "global",
        identityKey: "agents-md:global",
        mtime: 100,
      }),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      doc("gemini-cli", "/repo/GEMINI.md", "project-new", {
        tier: "project",
        identityKey: "agents-md:project",
        mtime: 200,
      }),
      doc("gemini-cli", path.join(home, ".gemini", "GEMINI.md"), "global-new", {
        tier: "global",
        identityKey: "agents-md:global",
        mtime: 300,
      }),
    ]);
    await initializedGlobal(
      home,
      [codex, gemini],
      cacheWithEntries([
        ["project/agents-md:project", "project-old"],
        ["global/agents-md:global", "global-old"],
      ]),
    );

    await expect(runGlobalSync({ strategy: "lww" })).resolves.toBe(0);

    expect(codex.readCalls).toEqual(["global"]);
    expect(gemini.readCalls).toEqual(["global"]);
    expect(
      codex.docs.find((memory) => memory.meta.tier === "global")?.body,
    ).toBe("global-new");
    expect(
      codex.docs.find((memory) => memory.meta.tier === "project")?.body,
    ).toBe("project-old");
  });

  test("memento global sync ignores project tier flags", async () => {
    const home = useHome();
    const codex = mockAdapter("codex", [
      doc("codex", "/repo/AGENTS.md", "project", {
        tier: "project",
        identityKey: "agents-md:project",
      }),
      doc("codex", path.join(home, ".codex", "AGENTS.md"), "global", {
        tier: "global",
        identityKey: "agents-md:global",
      }),
    ]);
    await initializedGlobal(home, [codex]);

    await expect(
      runGlobalSync({ tier: "project", includeGlobal: true }),
    ).resolves.toBe(0);

    expect(codex.readCalls).toEqual(["global"]);
  });

  test("memento global diff reads global tier only", async () => {
    const home = useHome();
    const codex = mockAdapter("codex", [
      doc("codex", "/repo/AGENTS.md", "project-a", {
        tier: "project",
        identityKey: "agents-md:project",
      }),
      doc("codex", path.join(home, ".codex", "AGENTS.md"), "global-a", {
        tier: "global",
        identityKey: "agents-md:global",
      }),
    ]);
    const gemini = mockAdapter("gemini-cli", [
      doc("gemini-cli", "/repo/GEMINI.md", "project-b", {
        tier: "project",
        identityKey: "agents-md:project",
      }),
      doc("gemini-cli", path.join(home, ".gemini", "GEMINI.md"), "global-b", {
        tier: "global",
        identityKey: "agents-md:global",
      }),
    ]);
    await initializedGlobal(home, [codex, gemini]);

    await expect(
      runGlobalDiff({ all: true, tier: "project", includeGlobal: true }),
    ).resolves.toBe(0);

    expect(codex.readCalls).toEqual(["global"]);
    expect(stdout).toContain("[conflict] global/agents-md:global");
    expect(stdout).not.toContain("agents-md:project");
  });

  test("memento global restore --list reads ~/.memento/backup", async () => {
    const home = useHome();
    const mementoDir = path.join(home, ".memento");
    await fs.mkdir(mementoDir, { recursive: true });
    const handle = await createBackup(mementoDir, [
      {
        absPath: path.join(home, ".codex", "AGENTS.md"),
        previousContent: "before",
        groupKey: "global/agents-md:global",
      },
    ]);

    await expect(runGlobalRestore({ list: true })).resolves.toBe(0);

    expect(stdout).toContain(handle.timestamp);
    expect(stdout).toContain("global/agents-md:global");
  });

  test("memento global watch uses global paths", async () => {
    const home = useHome();
    await initializedGlobal(home, [
      mockAdapter("codex", [
        doc("codex", "/repo/AGENTS.md", "project", {
          tier: "project",
          identityKey: "agents-md:project",
        }),
        doc("codex", path.join(home, ".codex", "AGENTS.md"), "global", {
          tier: "global",
          identityKey: "agents-md:global",
        }),
      ]),
    ]);

    const result = runGlobalWatch({ tier: "project", includeGlobal: true });

    await vi.waitFor(() => expect(watchState.watch).toHaveBeenCalled());
    process.emit("SIGINT");
    await expect(result).resolves.toBe(0);

    const [watchedPaths] = watchState.watch.mock.calls[0] as [string[]];
    expect(watchedPaths).toContain(path.join(home, ".codex", "AGENTS.md"));
    expect(watchedPaths).not.toContain("/repo/AGENTS.md");
  });

  test("global CLI status ignores --include-global and invalid --tier", async () => {
    const home = useHome();
    await initializedGlobal(home, [
      mockAdapter("codex", [
        doc("codex", path.join(home, ".codex", "AGENTS.md"), "global", {
          tier: "global",
          identityKey: "agents-md:global",
        }),
      ]),
    ]);
    const program = createProgram();

    await expect(
      program.parseAsync(
        [
          "node",
          "memento",
          "global",
          "status",
          "--include-global",
          "--tier",
          "not-a-tier",
        ],
        { from: "node" },
      ),
    ).resolves.toBe(program);

    expect(process.exitCode).toBe(0);
    expect(stdout).toContain("global\tagents-md:global");
    expect(stderr).toBe("");
  });
});

function useHome(): string {
  const home = fixtureDir();
  vi.spyOn(os, "homedir").mockReturnValue(home);
  process.chdir(fixtureDir());
  return home;
}

async function initializedGlobal(
  home: string,
  adapters: ProviderAdapter[],
  cache: Cache = emptyCache(),
): Promise<void> {
  const mementoDir = path.join(home, ".memento");
  const config = defaultConfig(adapters.map((adapter) => adapter.id));

  registryState.adapters = adapters;

  await fs.mkdir(mementoDir, { recursive: true });
  await saveConfig(mementoDir, config);
  await fs.writeFile(
    path.join(mementoDir, "cache.json"),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

class MockAdapter implements ProviderAdapter {
  readonly displayName: string;
  readonly readCalls: Tier[] = [];
  readonly writeCalls = vi.fn<(tier: Tier, docs: MemoryDoc[]) => void>();

  constructor(
    readonly id: ProviderId,
    readonly docs: MemoryDoc[],
    private readonly installed = true,
  ) {
    this.displayName = id;
  }

  async probe(): Promise<ProbeResult> {
    return { installStatus: this.installed ? "installed" : "not-installed" };
  }

  paths(): TierPaths {
    return {
      project: this.pathsFor("project"),
      "project-local": this.pathsFor("project-local"),
      global: this.pathsFor("global"),
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
    this.readCalls.push(tier);
    return this.docs.filter((memory) => memory.meta.tier === tier);
  }

  async write(tier: Tier, docs: MemoryDoc[]): Promise<WriteReport> {
    this.writeCalls(tier, docs);

    for (const memory of docs) {
      const index = this.docs.findIndex(
        (existing) => existing.meta.sourcePath === memory.meta.sourcePath,
      );

      if (index >= 0) {
        this.docs[index] = memory;
      }
    }

    return {
      written: docs.map((memory) => memory.meta.sourcePath),
      skipped: [],
    };
  }

  private pathsFor(tier: Tier): string[] {
    return this.docs
      .filter((memory) => memory.meta.tier === tier)
      .map((memory) => memory.meta.sourcePath);
  }
}

function mockAdapter(
  id: ProviderId,
  docs: MemoryDoc[],
  installed = true,
): MockAdapter {
  return new MockAdapter(id, docs, installed);
}

function doc(
  source: ProviderId,
  sourcePath: string,
  body: string,
  opts: {
    tier?: Tier;
    identityKey?: string;
    mtime?: number;
  } = {},
): MemoryDoc {
  const identityKey = opts.identityKey ?? "agents-md:main";

  return {
    body,
    meta: {
      tier: opts.tier ?? "project",
      identityKey,
      subtype: identityKey.startsWith("rule:") ? "rule" : "agents-md",
      source,
      sourcePath,
      mtime: opts.mtime ?? 1,
      bodyHash: sha256Hex(body),
      rawHash: sha256Hex(body),
    },
  };
}

function emptyCache(): Cache {
  return {
    version: 1,
    lastSyncAt: null,
    entries: {},
  };
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
