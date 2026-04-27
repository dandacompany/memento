import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  AdapterRegistry,
  createDefaultRegistry,
} from "../../../src/adapters/registry.js";
import type {
  DetectResult,
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "../../../src/adapters/types.js";
import type { MemoryDoc, ProviderId, Tier } from "../../../src/core/types.js";

const fakeA = "fake-a" as ProviderId;
const fakeB = "fake-b" as ProviderId;
const fakeC = "fake-c" as ProviderId;

const installedProbe: ProbeResult = {
  installStatus: "installed",
  binaryPath: "/bin/fake",
};

function detectResult(active: boolean): DetectResult {
  return {
    installed: true,
    hasMemory: active,
    active,
    activeTiers: active ? ["project", "global"] : [],
    probe: installedProbe,
  };
}

function tierPaths(paths?: Partial<TierPaths>): TierPaths {
  return {
    project: [],
    "project-local": [],
    global: [],
    ...paths,
  };
}

function mockAdapter(
  id: ProviderId,
  options: {
    displayName?: string;
    active?: boolean;
    paths?: TierPaths;
  } = {},
): ProviderAdapter {
  return {
    id,
    displayName: options.displayName ?? id,
    probe: vi.fn(async () => installedProbe),
    paths: vi.fn(() => options.paths ?? tierPaths()),
    detect: vi.fn(async () => detectResult(options.active ?? true)),
    read: vi.fn(async () => []),
    write: vi.fn(
      async () => ({ written: [], skipped: [] }) satisfies WriteReport,
    ),
  };
}

function memoryDoc(
  provider: ProviderId,
  sourcePath: string,
  tier: Tier = "global",
): MemoryDoc {
  return {
    body: `${provider}:${sourcePath}`,
    meta: {
      tier,
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: provider,
      sourcePath,
      mtime: 1,
      bodyHash: `${provider}:body`,
      rawHash: `${provider}:raw`,
    },
  };
}

describe("AdapterRegistry", () => {
  test("createDefaultRegistry returns an empty registry", () => {
    const registry = createDefaultRegistry();

    expect(registry.all()).toEqual([]);
  });

  test("register and get returns the adapter by provider id", () => {
    const registry = new AdapterRegistry();
    const adapter = mockAdapter(fakeA);

    registry.register(adapter);

    expect(registry.get(fakeA)).toBe(adapter);
  });

  test("register replaces an adapter with the same provider id", () => {
    const registry = new AdapterRegistry();
    const first = mockAdapter(fakeA, { displayName: "first" });
    const second = mockAdapter(fakeA, { displayName: "second" });

    registry.register(first);
    registry.register(second);

    expect(registry.get(fakeA)).toBe(second);
    expect(registry.all()).toEqual([second]);
  });

  test("all returns adapters in registration order", () => {
    const registry = new AdapterRegistry();
    const adapterA = mockAdapter(fakeA);
    const adapterB = mockAdapter(fakeB);
    const adapterC = mockAdapter(fakeC);

    registry.register(adapterA);
    registry.register(adapterB);
    registry.register(adapterC);

    expect(registry.all()).toEqual([adapterA, adapterB, adapterC]);
  });

  test("activeAdapters filters adapters where detect returns active true", async () => {
    const registry = new AdapterRegistry();
    const cwd = "/repo/project";
    const adapterA = mockAdapter(fakeA, { active: true });
    const adapterB = mockAdapter(fakeB, { active: false });
    const adapterC = mockAdapter(fakeC, { active: true });

    registry.register(adapterA);
    registry.register(adapterB);
    registry.register(adapterC);

    await expect(registry.activeAdapters(cwd)).resolves.toEqual([
      adapterA,
      adapterC,
    ]);
    expect(adapterA.detect).toHaveBeenCalledWith(cwd);
    expect(adapterB.detect).toHaveBeenCalledWith(cwd);
    expect(adapterC.detect).toHaveBeenCalledWith(cwd);
  });

  test("sharedGlobalPaths detects overlapping canonical global paths", async () => {
    const registry = new AdapterRegistry();
    const shared = path.join(process.cwd(), "tmp-shared", "GEMINI.md");

    registry.register(
      mockAdapter(fakeA, {
        paths: tierPaths({ global: [shared] }),
      }),
    );
    registry.register(
      mockAdapter(fakeB, {
        paths: tierPaths({
          global: [
            path.join(
              process.cwd(),
              "tmp-shared",
              "..",
              "tmp-shared",
              "GEMINI.md",
            ),
          ],
        }),
      }),
    );
    registry.register(
      mockAdapter(fakeC, {
        paths: tierPaths({ global: [path.join(process.cwd(), "unique.md")] }),
      }),
    );

    const sharedPaths = registry.sharedGlobalPaths();

    expect(sharedPaths).toEqual(
      new Map([[path.resolve(shared), [fakeA, fakeB]]]),
    );
  });

  test("sharedGlobalPaths returns an empty map when no paths overlap", async () => {
    const registry = new AdapterRegistry();

    registry.register(
      mockAdapter(fakeA, {
        paths: tierPaths({ global: [path.join(process.cwd(), "a.md")] }),
      }),
    );
    registry.register(
      mockAdapter(fakeB, {
        paths: tierPaths({ global: [path.join(process.cwd(), "b.md")] }),
      }),
    );

    expect(registry.sharedGlobalPaths()).toEqual(new Map());
  });

  test("dedupeSharedGlobal keeps one global doc per shared path by alphabetically first provider id", () => {
    const registry = new AdapterRegistry();
    const shared = path.join(process.cwd(), "shared.md");
    const docB = memoryDoc(fakeB, path.join(process.cwd(), ".", "shared.md"));
    const docA = memoryDoc(fakeA, shared);
    const docC = memoryDoc(fakeC, path.join(process.cwd(), "unique.md"));

    expect(registry.dedupeSharedGlobal([docB, docA, docC])).toEqual([
      docA,
      docC,
    ]);
  });

  test("dedupeSharedGlobal preserves project docs even when their paths overlap", () => {
    const registry = new AdapterRegistry();
    const shared = path.join(process.cwd(), "AGENTS.md");
    const docA = memoryDoc(fakeA, shared, "project");
    const docB = memoryDoc(fakeB, shared, "project");

    expect(registry.dedupeSharedGlobal([docA, docB])).toEqual([docA, docB]);
  });

  test("dedupeSharedGlobal leaves unique global docs unchanged", () => {
    const registry = new AdapterRegistry();
    const docA = memoryDoc(fakeA, path.join(process.cwd(), "a.md"));
    const docB = memoryDoc(fakeB, path.join(process.cwd(), "b.md"));

    expect(registry.dedupeSharedGlobal([docA, docB])).toEqual([docA, docB]);
  });
});
