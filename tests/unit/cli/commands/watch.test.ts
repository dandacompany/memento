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
import type { Cache } from "../../../../src/core/cache.js";
import { defaultConfig, saveConfig } from "../../../../src/core/config.js";
import type { ResourceKind, ResourceScope } from "../../../../src/core/resource-types.js";
import type {
  MementoConfig,
  MemoryDoc,
  ProviderId,
} from "../../../../src/core/types.js";
import { fixtureDir } from "../../tmp-fixture.js";

const chokidarMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class FakeWatcher {
    readonly handlers = new Map<string, Handler[]>();
    readonly close = vi.fn(async () => {
      this.closed = true;
    });
    closed = false;

    constructor(
      readonly paths: string[],
      readonly options: Record<string, unknown>,
    ) {}

    on(event: string, handler: Handler): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  const watchers: FakeWatcher[] = [];
  const watch = vi.fn((paths: string[], options: Record<string, unknown>) => {
    const watcher = new FakeWatcher(paths, options);
    watchers.push(watcher);
    return watcher;
  });

  return { watchers, watch };
});

const syncMock = vi.hoisted(() =>
  vi.fn(async () => ({
    groupsTotal: 0,
    groupsIdentical: 0,
    groupsPropagated: 0,
    groupsConflictResolved: 0,
    groupsSkipped: 0,
    groupsFailed: 0,
    writes: [],
    cacheUpdated: true,
    dryRun: false,
    durationMs: 1,
  })),
);

let testRegistry: AdapterRegistry;

vi.mock("chokidar", () => ({
  default: {
    watch: chokidarMock.watch,
  },
}));

vi.mock("../../../../src/core/sync.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/core/sync.js")
  >("../../../../src/core/sync.js");

  return {
    ...actual,
    sync: syncMock,
  };
});

vi.mock("../../../../src/cli/helpers/registry.js", () => ({
  createCliRegistry: () => testRegistry,
}));

const { runWatch } = await import("../../../../src/cli/commands/watch.js");

const originalCwd = process.cwd();

beforeEach(() => {
  testRegistry = new AdapterRegistry();
  chokidarMock.watch.mockClear();
  chokidarMock.watchers.length = 0;
  syncMock.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runWatch", () => {
  test("starts watcher and emits started message", async () => {
    const root = await projectWithConfig(["codex"]);
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    const stdout = captureStdout();

    const promise = runWatch({});
    await waitForWatcher();

    expect(stdout.text()).toContain("Watching 1 files across 1 providers");
    expect(chokidarMock.watchers).toHaveLength(1);
    await stopWithSignal(promise, "SIGINT");
  });

  test("starts chokidar with daemon-safe options", async () => {
    const root = await projectWithConfig(["codex"]);
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    const stdout = captureStdout();

    const promise = runWatch({});
    await waitForWatcher();

    expect(stdout.text()).toContain("(Ctrl+C to stop)");
    expect(chokidarMock.watchers[0]?.options).toMatchObject({
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
      usePolling: process.platform === "win32",
    });
    await stopWithSignal(promise, "SIGTERM");
  });

  test("watches file paths plus their parent directories", async () => {
    const root = await projectWithConfig(["cursor"]);
    const rule = path.join(root, ".cursor", "rules", "team.mdc");
    register(
      mockAdapter("cursor", {
        project: [rule],
        "project-local": [],
        global: [],
      }),
    );
    process.chdir(root);
    captureStdout();

    const promise = runWatch({});
    await waitForWatcher();

    expect(chokidarMock.watchers[0]?.paths).toEqual(
      expect.arrayContaining([rule, path.dirname(rule)]),
    );
    await stopWithSignal(promise, "SIGINT");
  });

  test("file change debounces and calls sync once", async () => {
    const root = await projectWithConfig(["codex"]);
    const filePath = path.join(root, "AGENTS.md");
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    await writeCache(root, emptyCache());
    captureStdout();

    const promise = runWatch({ debounce: 25 });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit("all", "change", filePath);
    await vi.advanceTimersByTimeAsync(24);
    expect(syncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForSyncCalls(1);

    expect(syncMock).toHaveBeenCalledTimes(1);
    await stopWithSignal(promise, "SIGINT");
  });

  test("ignores changes inside .memento", async () => {
    const root = await projectWithConfig(["codex"]);
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    await writeCache(root, emptyCache());
    captureStdout();

    const promise = runWatch({ debounce: 10 });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit(
      "all",
      "change",
      path.join(root, ".memento", "cache.json"),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(syncMock).not.toHaveBeenCalled();
    await stopWithSignal(promise, "SIGINT");
  });

  test("multiple file changes within debounce window call sync once", async () => {
    const root = await projectWithConfig(["codex"]);
    register(
      mockAdapter("codex", pathsFor(root, ["AGENTS.md", "AGENTS.local.md"])),
    );
    process.chdir(root);
    await writeCache(root, emptyCache());
    const stdout = captureStdout();

    const promise = runWatch({ debounce: 50 });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit(
      "all",
      "change",
      path.join(root, "AGENTS.md"),
    );
    await vi.advanceTimersByTimeAsync(25);
    chokidarMock.watchers[0]?.emit(
      "all",
      "change",
      path.join(root, "AGENTS.local.md"),
    );
    await vi.advanceTimersByTimeAsync(50);
    await waitForSyncCalls(1);

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(stdout.text()).toContain("2 files changed");
    await stopWithSignal(promise, "SIGINT");
  });

  test("file changes after debounce window call sync again", async () => {
    const root = await projectWithConfig(["codex"]);
    const filePath = path.join(root, "AGENTS.md");
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    await writeCache(root, emptyCache());
    captureStdout();

    const promise = runWatch({ debounce: 10 });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit("all", "change", filePath);
    await vi.advanceTimersByTimeAsync(10);
    chokidarMock.watchers[0]?.emit("all", "change", filePath);
    await vi.advanceTimersByTimeAsync(10);
    await waitForSyncCalls(2);

    expect(syncMock).toHaveBeenCalledTimes(2);
    await stopWithSignal(promise, "SIGINT");
  });

  test("SIGINT closes watcher and returns 0", async () => {
    const root = await projectWithConfig(["codex"]);
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    captureStdout();

    const promise = runWatch({});
    await waitForWatcher();
    const watcher = chokidarMock.watchers[0];

    await expect(stopWithSignal(promise, "SIGINT")).resolves.toBe(0);
    expect(watcher?.close).toHaveBeenCalledTimes(1);
    expect(watcher?.closed).toBe(true);
  });

  test("SIGTERM closes watcher and returns 0", async () => {
    const root = await projectWithConfig(["codex"]);
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    captureStdout();

    const promise = runWatch({});
    await waitForWatcher();

    await expect(stopWithSignal(promise, "SIGTERM")).resolves.toBe(0);
    expect(chokidarMock.watchers[0]?.close).toHaveBeenCalledTimes(1);
  });

  test("not initialized returns exit 3", async () => {
    const root = fixtureDir();
    process.chdir(root);
    const stderr = captureStderr();

    await expect(runWatch({})).resolves.toBe(3);
    expect(stderr.text()).toContain("No .memento directory found");
    expect(chokidarMock.watch).not.toHaveBeenCalled();
  });

  test("no active providers returns exit 4", async () => {
    const root = await projectWithConfig(["codex"]);
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"]), false));
    process.chdir(root);
    const stderr = captureStderr();

    await expect(runWatch({})).resolves.toBe(4);
    expect(stderr.text()).toContain("No active providers");
    expect(chokidarMock.watch).not.toHaveBeenCalled();
  });

  test("sync is forced to lww and non-interactive", async () => {
    const root = await projectWithConfig(["codex"]);
    const filePath = path.join(root, "AGENTS.md");
    register(mockAdapter("codex", pathsFor(root, ["AGENTS.md"])));
    process.chdir(root);
    await writeCache(root, emptyCache());
    captureStdout();

    const promise = runWatch({
      debounce: 10,
      ...flagObject({ strategy: "prompt", dryRun: true }),
    });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit("all", "change", filePath);
    await vi.advanceTimersByTimeAsync(10);
    await waitForSyncCalls(1);

    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: "lww",
        dryRun: false,
        isTTY: false,
      }),
    );
    await stopWithSignal(promise, "SIGINT");
  });

  test("provider and tier filters are passed through to sync", async () => {
    const root = await projectWithConfig(["codex", "claude-code"]);
    const codex = mockAdapter("codex", pathsFor(root, ["AGENTS.md"]));
    const claude = mockAdapter(
      "claude-code",
      pathsFor(root, ["CLAUDE.md", "CLAUDE.local.md"]),
    );
    register(codex, claude);
    process.chdir(root);
    await writeCache(root, emptyCache());
    captureStdout();

    const promise = runWatch({
      debounce: 10,
      provider: "claude-code",
      tier: "project-local",
    });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit(
      "all",
      "change",
      path.join(root, "CLAUDE.local.md"),
    );
    await vi.advanceTimersByTimeAsync(10);
    await waitForSyncCalls(1);

    expect(chokidarMock.watchers[0]?.paths).toEqual(
      expect.arrayContaining([path.join(root, "CLAUDE.local.md")]),
    );
    expect(chokidarMock.watchers[0]?.paths).not.toContain(
      path.join(root, "AGENTS.md"),
    );
    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-code",
        tier: "project-local",
      }),
    );
    await stopWithSignal(promise, "SIGINT");
  });

  test("resource paths are watched and passed through to sync", async () => {
    const root = await projectWithConfig(["codex"]);
    const skillPath = path.join(root, ".agents", "skills");
    register(
      mockAdapter("codex", pathsFor(root, ["AGENTS.md"]), true, [skillPath]),
    );
    process.chdir(root);
    await writeCache(root, emptyCache());
    captureStdout();

    const promise = runWatch({
      debounce: 10,
      resources: "skills",
      scope: "project",
    });
    await waitForWatcher();
    vi.useFakeTimers();

    chokidarMock.watchers[0]?.emit(
      "all",
      "change",
      path.join(skillPath, "review", "SKILL.md"),
    );
    await vi.advanceTimersByTimeAsync(10);
    await waitForSyncCalls(1);

    expect(chokidarMock.watchers[0]?.paths).toContain(skillPath);
    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKinds: ["skill"],
        resourceScope: "project",
      }),
    );
    await stopWithSignal(promise, "SIGINT");
  });
});

class MockAdapter implements ProviderAdapter {
  readonly displayName: string;

  constructor(
    readonly id: ProviderId,
    private readonly tierPaths: TierPaths,
    private readonly active = true,
    private readonly resourcePaths: string[] = [],
  ) {
    this.displayName = id;
  }

  async probe(): Promise<ProbeResult> {
    return { installStatus: "installed" };
  }

  paths(): TierPaths {
    return this.tierPaths;
  }

  async detect(): Promise<DetectResult> {
    return {
      installed: true,
      hasMemory: true,
      active: this.active,
      activeTiers: ["project", "project-local", "global"],
      probe: { installStatus: "installed" },
    };
  }

  async read(): Promise<MemoryDoc[]> {
    return [];
  }

  resourceWatchPaths(
    _cwd: string,
    _scope: ResourceScope,
    _kinds: ResourceKind[],
  ): string[] {
    return this.resourcePaths;
  }

  async write(): Promise<WriteReport> {
    return { written: [], skipped: [] };
  }
}

function mockAdapter(
  id: ProviderId,
  tierPaths: TierPaths,
  active = true,
  resourcePaths: string[] = [],
): MockAdapter {
  return new MockAdapter(id, tierPaths, active, resourcePaths);
}

function pathsFor(root: string, files: string[]): TierPaths {
  return {
    project: files
      .filter((file) => !file.includes(".local."))
      .map((file) => path.join(root, file)),
    "project-local": files
      .filter((file) => file.includes(".local."))
      .map((file) => path.join(root, file)),
    global: [],
  };
}

function register(...adapters: ProviderAdapter[]): void {
  for (const adapter of adapters) {
    testRegistry.register(adapter);
  }
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

function emptyCache(): Cache {
  return { version: 1, lastSyncAt: null, entries: {} };
}

async function writeCache(root: string, cache: Cache): Promise<void> {
  await fs.writeFile(
    path.join(root, ".memento", "cache.json"),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

async function waitForWatcher(): Promise<void> {
  await vi.waitFor(() => {
    expect(chokidarMock.watchers).toHaveLength(1);
  });
}

async function waitForSyncCalls(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(syncMock).toHaveBeenCalledTimes(count);
  });
}

async function stopWithSignal(
  promise: Promise<number>,
  signal: "SIGINT" | "SIGTERM",
): Promise<number> {
  process.emit(signal);
  return promise;
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

function flagObject(value: Record<string, unknown>): Record<string, never> {
  return value as Record<string, never>;
}
