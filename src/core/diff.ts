import type { AdapterRegistry } from "../adapters/registry.js";
import type { DetectResult, ProviderAdapter } from "../adapters/types.js";
import type { Cache } from "./cache.js";
import { applyOverrides } from "./identity.js";
import { applyExclusions, groupBy } from "./sync.js";
import type { MemoryDoc, ProviderId, Subtype, Tier } from "./types.js";

export interface GroupDiff {
  key: string;
  tier: Tier;
  identityKey: string;
  subtype: Subtype;
  sources: {
    provider: ProviderId;
    sourcePath: string;
    bodyHash: string;
  }[];
  status: "identical" | "modified" | "conflict" | "orphan";
}

export interface DiffSourceBody {
  provider: ProviderId;
  sourcePath: string;
  bodyHash: string;
  body: string;
}

export interface GroupDiffWithBodies extends GroupDiff {
  sources: DiffSourceBody[];
}

export interface ComputeDiffsOpts {
  cwd: string;
  mementoDir: string;
  registry: AdapterRegistry;
  cache: Cache;
  tierFilter: Tier[];
  mappingOverrides?: Record<string, string[]>;
  excludePaths?: string[];
}

interface AdapterDetection {
  adapter: ProviderAdapter;
  detect: DetectResult;
}

const tierOrder: Record<Tier, number> = {
  project: 0,
  "project-local": 1,
  global: 2,
};

function intersectTiers(activeTiers: Tier[], tierFilter: Tier[]): Tier[] {
  const active = new Set(activeTiers);

  return tierFilter.filter((tier) => active.has(tier));
}

function groupKeyForDoc(
  doc: MemoryDoc,
  mappingOverrides?: Record<string, string[]>,
): string {
  return `${doc.meta.tier}/${applyOverrides(
    doc.meta.identityKey,
    mappingOverrides,
  )}`;
}

function splitGroupKey(key: string): { tier: Tier; identityKey: string } {
  const [tier, ...identityParts] = key.split("/");

  return {
    tier: tier as Tier,
    identityKey: identityParts.join("/"),
  };
}

function isOrphanOnlyGroup(
  docs: MemoryDoc[],
  detectionsByProvider: Map<ProviderId, DetectResult>,
): boolean {
  if (docs.length !== 1) {
    return false;
  }

  const doc = docs[0];
  if (!doc) {
    return false;
  }

  const detect = detectionsByProvider.get(doc.meta.source);

  return Boolean(detect && !detect.installed && detect.hasMemory);
}

function statusForGroup(
  docs: MemoryDoc[],
  cache: Cache,
  key: string,
  detectionsByProvider: Map<ProviderId, DetectResult>,
): GroupDiff["status"] {
  if (isOrphanOnlyGroup(docs, detectionsByProvider)) {
    return "orphan";
  }

  const bodyHashes = [...new Set(docs.map((doc) => doc.meta.bodyHash))];

  if (bodyHashes.length <= 1) {
    return "identical";
  }

  const cacheBodyHash = cache.entries[key]?.bodyHash;
  if (!cacheBodyHash) {
    return "conflict";
  }

  const changedHashes = bodyHashes.filter((hash) => hash !== cacheBodyHash);

  return changedHashes.length === 1 ? "modified" : "conflict";
}

async function detectActiveAdapters(
  registry: AdapterRegistry,
  cwd: string,
): Promise<AdapterDetection[]> {
  const detections = await Promise.all(
    registry.all().map(async (adapter) => ({
      adapter,
      detect: await adapter.detect(cwd),
    })),
  );

  return detections.filter(({ detect }) => detect.active);
}

async function collectDocs(
  detections: AdapterDetection[],
  tierFilter: Tier[],
): Promise<MemoryDoc[]> {
  const docs: MemoryDoc[] = [];

  for (const { adapter, detect } of detections) {
    for (const tier of intersectTiers(detect.activeTiers, tierFilter)) {
      docs.push(...(await adapter.read(tier)));
    }
  }

  return docs;
}

function buildGroupDiff(
  key: string,
  docs: MemoryDoc[],
  cache: Cache,
  detectionsByProvider: Map<ProviderId, DetectResult>,
): GroupDiffWithBodies {
  const { tier, identityKey } = splitGroupKey(key);
  const sortedDocs = [...docs].sort((a, b) =>
    `${a.meta.source}\0${a.meta.sourcePath}`.localeCompare(
      `${b.meta.source}\0${b.meta.sourcePath}`,
    ),
  );
  const subtype = sortedDocs[0]?.meta.subtype ?? "agents-md";

  return {
    key,
    tier,
    identityKey,
    subtype,
    status: statusForGroup(sortedDocs, cache, key, detectionsByProvider),
    sources: sortedDocs.map((doc) => ({
      provider: doc.meta.source,
      sourcePath: doc.meta.sourcePath,
      bodyHash: doc.meta.bodyHash,
      body: doc.body,
    })),
  };
}

export async function computeDiffs(
  opts: ComputeDiffsOpts,
): Promise<GroupDiffWithBodies[]> {
  void opts.mementoDir;

  const detections = await detectActiveAdapters(opts.registry, opts.cwd);
  const detectionsByProvider = new Map(
    detections.map(({ adapter, detect }) => [adapter.id, detect]),
  );
  const docs = applyExclusions(
    opts.registry.dedupeSharedGlobal(
      await collectDocs(detections, opts.tierFilter),
    ),
    opts.excludePaths,
  );
  const groups = groupBy(docs, (doc) =>
    groupKeyForDoc(doc, opts.mappingOverrides),
  );

  return [...groups.entries()]
    .map(([key, groupDocs]) =>
      buildGroupDiff(key, groupDocs, opts.cache, detectionsByProvider),
    )
    .sort((a, b) => {
      const tierCompare = tierOrder[a.tier] - tierOrder[b.tier];
      return tierCompare === 0 ? a.key.localeCompare(b.key) : tierCompare;
    });
}
