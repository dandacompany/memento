import path from "node:path";

import type { AdapterRegistry } from "../adapters/registry.js";
import type { ProviderAdapter } from "../adapters/types.js";
import { AdapterError } from "./errors.js";
import { applyOverrides, deriveIdentityKey } from "./identity.js";
import { createBackup, type BackupTarget } from "./backup.js";
import { createLogger, type Logger } from "./logger.js";
import { resolveGroup, type ResolveOptions } from "./resolver.js";
import { saveCache, type Cache } from "./cache.js";
import { sha256Hex } from "../adapters/shared/io.js";
import type { ResourceDoc, ResourceKind, ResourceScope } from "./resource-types.js";
import { resourceGroupKeyForDoc } from "./resource-identity.js";
import type { MemoryDoc, ProviderId, ResolveStrategy, Tier } from "./types.js";
import { matchGlob } from "./glob.js";

export interface SyncOpts {
  cwd: string;
  mementoDir: string;
  registry: AdapterRegistry;
  cache: Cache;
  tier?: Tier;
  includeGlobal?: boolean;
  globalOnly?: boolean;
  provider?: ProviderId;
  resourceKinds?: ResourceKind[];
  resourceScope?: ResourceScope;
  dryRun?: boolean;
  strategy: ResolveStrategy;
  isTTY: boolean;
  promptUser?: ResolveOptions["promptUser"];
  mappingOverrides?: Record<string, string[]>;
  excludePaths?: string[];
  logger?: Logger;
}

export interface SyncReport {
  groupsTotal: number;
  groupsIdentical: number;
  groupsPropagated: number;
  groupsConflictResolved: number;
  groupsSkipped: number;
  groupsFailed: number;
  writes: {
    provider: ProviderId;
    tier: Tier;
    written: string[];
    skipped: string[];
  }[];
  cacheUpdated: boolean;
  dryRun: boolean;
  durationMs: number;
}

interface AdapterTier {
  adapter: ProviderAdapter;
  tier: Tier;
}

interface SourceDoc {
  adapter: ProviderAdapter;
  tier: Tier;
  doc: MemoryDoc;
  synthetic?: boolean;
}

interface PlannedWrite {
  groupKey: string;
  original: MemoryDoc;
  doc: MemoryDoc;
  synthetic?: boolean;
}

interface GroupStatus {
  status: Awaited<ReturnType<typeof resolveGroup>>["status"];
}

interface PlannedResourceWrite {
  groupKey: string;
  adapter: ProviderAdapter;
  doc: ResourceDoc;
}

const tierOrder: Tier[] = ["project", "project-local", "global"];

export function resolveTierFilter(
  opts: Pick<SyncOpts, "tier" | "includeGlobal" | "globalOnly">,
): Tier[] {
  if (opts.tier) {
    return [opts.tier];
  }

  if (opts.globalOnly) {
    return ["global"];
  }

  if (opts.includeGlobal) {
    return [...tierOrder];
  }

  return ["project", "project-local"];
}

export function groupBy<T>(
  arr: T[],
  keyFn: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of arr) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

export function applyExclusions(
  docs: MemoryDoc[],
  excludePaths?: string[],
): MemoryDoc[] {
  if (!excludePaths || excludePaths.length === 0) {
    return docs;
  }

  return docs.filter(
    (doc) =>
      !excludePaths.some((pattern) => matchGlob(doc.meta.sourcePath, pattern)),
  );
}

export function cachePrevForGroup(
  cache: Cache,
  key: string,
): { bodyHash: string; mtime: number } | undefined {
  const entry = cache.entries[key];

  if (!entry) {
    return undefined;
  }

  return {
    bodyHash: entry.bodyHash,
    mtime: Date.parse(entry.updatedAt) || 0,
  };
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

function adapterTierKey(provider: ProviderId, tier: Tier): string {
  return `${provider}/${tier}`;
}

function makeTargetDoc(original: MemoryDoc, resolved: MemoryDoc): MemoryDoc {
  return {
    ...original,
    body: resolved.body,
    meta: {
      ...original.meta,
      bodyHash: sha256Hex(resolved.body),
      frontmatter: resolved.meta.frontmatter ?? original.meta.frontmatter,
      tags: resolved.meta.tags ?? original.meta.tags,
      title: resolved.meta.title ?? original.meta.title,
    },
  };
}

function needsWrite(original: MemoryDoc, resolved: MemoryDoc): boolean {
  return original.body !== resolved.body;
}

function needsResourceWrite(original: ResourceDoc, resolved: ResourceDoc): boolean {
  return original.meta.bodyHash !== resolved.meta.bodyHash;
}

function emptyReport(dryRun: boolean, start: number): SyncReport {
  return {
    groupsTotal: 0,
    groupsIdentical: 0,
    groupsPropagated: 0,
    groupsConflictResolved: 0,
    groupsSkipped: 0,
    groupsFailed: 0,
    writes: [],
    cacheUpdated: false,
    dryRun,
    durationMs: Date.now() - start,
  };
}

async function activeAdapters(
  registry: AdapterRegistry,
  cwd: string,
  provider: ProviderId | undefined,
  logger: Logger,
): Promise<ProviderAdapter[]> {
  const active = await registry.activeAdapters(cwd);

  if (!provider) {
    return active;
  }

  const registered = registry.get(provider);

  if (!registered) {
    logger.warn(`Provider ${provider} is not registered; skipping sync.`);
    return [];
  }

  const activeMatch = active.find((adapter) => adapter.id === provider);

  if (!activeMatch) {
    logger.warn(`Provider ${provider} is not active; skipping sync.`);
    return [];
  }

  return [activeMatch];
}

function tallyResolveStatus(
  report: SyncReport,
  status: Awaited<ReturnType<typeof resolveGroup>>["status"],
): void {
  switch (status) {
    case "identical":
      report.groupsIdentical += 1;
      return;
    case "propagated":
      report.groupsPropagated += 1;
      return;
    case "lww-resolved":
    case "prompt-resolved":
      report.groupsConflictResolved += 1;
      return;
    case "skipped":
      report.groupsSkipped += 1;
      return;
    case "conflict-failed":
      report.groupsFailed += 1;
      return;
  }
}

function buildWritePlan(
  sourceDocs: SourceDoc[],
  resolved: Map<string, MemoryDoc | null>,
  mappingOverrides: Record<string, string[]> | undefined,
): Map<string, PlannedWrite[]> {
  const plan = new Map<string, PlannedWrite[]>();

  for (const sourceDoc of sourceDocs) {
    const groupKey = groupKeyForDoc(sourceDoc.doc, mappingOverrides);
    const resolvedDoc = resolved.get(groupKey);

    if (!resolvedDoc || !needsWrite(sourceDoc.doc, resolvedDoc)) {
      continue;
    }

    const key = adapterTierKey(sourceDoc.adapter.id, sourceDoc.tier);
    const writes = plan.get(key) ?? [];
    writes.push({
      groupKey,
      original: sourceDoc.doc,
      doc: makeTargetDoc(sourceDoc.doc, resolvedDoc),
      synthetic: sourceDoc.synthetic,
    });
    plan.set(key, writes);
  }

  return plan;
}

function hasSourceDocForTarget(
  sourceDocs: SourceDoc[],
  target: SourceDoc,
  mappingOverrides: Record<string, string[]> | undefined,
): boolean {
  const targetGroupKey = groupKeyForDoc(target.doc, mappingOverrides);
  const targetPath = path.resolve(target.doc.meta.sourcePath);

  return sourceDocs.some(
    (sourceDoc) =>
      path.resolve(sourceDoc.doc.meta.sourcePath) === targetPath ||
      (sourceDoc.adapter.id === target.adapter.id &&
        sourceDoc.tier === target.tier &&
        groupKeyForDoc(sourceDoc.doc, mappingOverrides) === targetGroupKey),
  );
}

function buildMissingTargetDocs(
  adapterTiers: Iterable<AdapterTier>,
  sourceDocs: SourceDoc[],
  groupKeys: Set<string>,
  cwd: string,
  mappingOverrides: Record<string, string[]> | undefined,
  excludePaths: string[] | undefined,
): SourceDoc[] {
  const targets: SourceDoc[] = [];

  for (const { adapter, tier } of adapterTiers) {
    if (tier !== "global") {
      continue;
    }

    for (const sourcePath of adapter.paths(cwd)[tier]) {
      let identity;

      try {
        identity = deriveIdentityKey(sourcePath, adapter.id);
      } catch {
        continue;
      }

      const doc: MemoryDoc = {
        body: "",
        meta: {
          tier: identity.tier,
          identityKey: identity.identityKey,
          subtype: identity.subtype,
          source: adapter.id,
          sourcePath,
          mtime: 0,
          bodyHash: sha256Hex(""),
          rawHash: sha256Hex(""),
        },
      };
      const target: SourceDoc = { adapter, tier, doc, synthetic: true };
      const groupKey = groupKeyForDoc(doc, mappingOverrides);

      if (
        identity.tier !== tier ||
        !groupKeys.has(groupKey) ||
        excludePaths?.some((pattern) => matchGlob(sourcePath, pattern)) ||
        hasSourceDocForTarget(sourceDocs, target, mappingOverrides)
      ) {
        continue;
      }

      targets.push(target);
    }
  }

  return targets;
}

function adjustWriteStatuses(
  report: SyncReport,
  statuses: Map<string, GroupStatus>,
  writePlan: Map<string, PlannedWrite[]>,
): void {
  const groupsWithWrites = new Set<string>();

  for (const writes of writePlan.values()) {
    for (const write of writes) {
      groupsWithWrites.add(write.groupKey);
    }
  }

  for (const groupKey of groupsWithWrites) {
    const status = statuses.get(groupKey)?.status;

    if (status !== "identical") {
      continue;
    }

    report.groupsIdentical -= 1;
    report.groupsPropagated += 1;
  }
}

function backupTargetsFor(plan: Map<string, PlannedWrite[]>): BackupTarget[] {
  const targets = new Map<string, BackupTarget>();

  for (const writes of plan.values()) {
    for (const write of writes) {
      if (write.synthetic) {
        continue;
      }

      targets.set(write.original.meta.sourcePath, {
        absPath: write.original.meta.sourcePath,
        previousContent: write.original.body,
        groupKey: write.groupKey,
      });
    }
  }

  return [...targets.values()];
}

function updateCacheEntries(
  cache: Cache,
  groups: Map<string, MemoryDoc[]>,
  resolved: Map<string, MemoryDoc | null>,
  failedGroups: Set<string>,
): void {
  const now = new Date().toISOString();

  for (const [groupKey, docs] of groups) {
    if (failedGroups.has(groupKey)) {
      continue;
    }

    const resolvedDoc = resolved.get(groupKey);

    if (!resolvedDoc) {
      continue;
    }

    cache.entries[groupKey] = {
      bodyHash: sha256Hex(resolvedDoc.body),
      rawHashesByPath: Object.fromEntries(
        docs.map((doc) => [
          doc.meta.sourcePath,
          needsWrite(doc, resolvedDoc)
            ? sha256Hex(resolvedDoc.body)
            : doc.meta.rawHash,
        ]),
      ),
      lastResolvedFrom: resolvedDoc.meta.source,
      updatedAt: now,
    };
  }

  cache.lastSyncAt = now;
}

function applyResourceExclusions(
  docs: ResourceDoc[],
  excludePaths?: string[],
): ResourceDoc[] {
  if (!excludePaths || excludePaths.length === 0) {
    return docs;
  }

  return docs.filter(
    (doc) =>
      !excludePaths.some((pattern) => matchGlob(doc.meta.sourcePath, pattern)),
  );
}

function resolveResourceGroup(
  docs: ResourceDoc[],
  strategy: ResolveStrategy,
): { status: "identical" | "propagated" | "lww-resolved" | "skipped"; doc: ResourceDoc | null } {
  const hashes = new Set(docs.map((doc) => doc.meta.bodyHash));

  if (hashes.size === 1) {
    return { status: "identical", doc: docs[0] ?? null };
  }

  if (strategy === "fail") {
    return { status: "skipped", doc: null };
  }

  return {
    status: "lww-resolved",
    doc: [...docs].sort((a, b) => b.meta.mtime - a.meta.mtime)[0] ?? null,
  };
}

function makeTargetResourceDoc(
  adapter: ProviderAdapter,
  resolved: ResourceDoc,
  existing?: ResourceDoc,
): ResourceDoc {
  return {
    ...(existing ?? resolved),
    body: resolved.body,
    meta: {
      ...(existing?.meta ?? resolved.meta),
      provider: adapter.id,
      scope: resolved.meta.scope,
      tier: existing?.meta.tier ?? resolved.meta.tier,
      identityKey: resolved.meta.identityKey,
      sourcePath: existing?.meta.sourcePath ?? "",
      bodyHash: resolved.meta.bodyHash,
      rawHash: resolved.meta.rawHash,
      title: resolved.meta.title,
      tags: resolved.meta.tags,
      sensitive: resolved.meta.sensitive,
      redactions: resolved.meta.redactions,
      writeable: existing?.meta.writeable ?? true,
    },
  };
}

function updateResourceCacheEntries(
  cache: Cache,
  kind: ResourceKind,
  groups: Map<string, ResourceDoc[]>,
  resolved: Map<string, ResourceDoc | null>,
  failedGroups: Set<string>,
): void {
  const now = new Date().toISOString();

  for (const [groupKey, docs] of groups) {
    if (failedGroups.has(groupKey)) {
      continue;
    }

    const resolvedDoc = resolved.get(groupKey);

    if (!resolvedDoc) {
      continue;
    }

    cache.entries[groupKey] = {
      bodyHash: resolvedDoc.meta.bodyHash,
      rawHashesByPath: Object.fromEntries(
        docs.map((doc) => [
          doc.meta.sourcePath,
          needsResourceWrite(doc, resolvedDoc)
            ? resolvedDoc.meta.rawHash
            : doc.meta.rawHash,
        ]),
      ),
      lastResolvedFrom: resolvedDoc.meta.provider,
      updatedAt: now,
    };
  }

  cache.lastSyncAt = now;
}

async function syncResourceKind(
  kind: ResourceKind,
  scope: ResourceScope,
  adapters: ProviderAdapter[],
  opts: SyncOpts,
  report: SyncReport,
  logger: Logger,
): Promise<void> {
  if (kind !== "skill" && kind !== "mcp") {
    logger.debug(`Resource kind ${kind} is not implemented for sync yet.`);
    return;
  }

  const sourceDocs: ResourceDoc[] = [];
  const writeAdapters = adapters.filter(
    (adapter) => typeof adapter.writeResources === "function",
  );

  for (const adapter of adapters) {
    if (!adapter.readResources) {
      continue;
    }

    try {
      sourceDocs.push(...(await adapter.readResources(kind, scope)));
    } catch (error) {
      logger.warn(`Failed to read ${adapter.id} ${kind} resources.`, error);
    }
  }

  const allDocs = applyResourceExclusions(sourceDocs, opts.excludePaths);
  const groups = groupBy(allDocs, resourceGroupKeyForDoc);
  const resolved = new Map<string, ResourceDoc | null>();
  const planned: PlannedResourceWrite[] = [];

  report.groupsTotal += groups.size;

  for (const [groupKey, docs] of groups) {
    const result = resolveResourceGroup(docs, opts.strategy);
    const resolvedDoc = result.doc;

    if (!resolvedDoc) {
      report.groupsSkipped += 1;
      resolved.set(groupKey, null);
      continue;
    }

    resolved.set(groupKey, resolvedDoc);

    for (const adapter of writeAdapters) {
      const existing = docs.find((doc) => doc.meta.provider === adapter.id);
      const target = makeTargetResourceDoc(adapter, resolvedDoc, existing);

      if (existing && !needsResourceWrite(existing, resolvedDoc)) {
        continue;
      }

      planned.push({ groupKey, adapter, doc: target });
    }

    if (planned.some((write) => write.groupKey === groupKey)) {
      if (result.status === "lww-resolved") {
        report.groupsConflictResolved += 1;
      } else {
        report.groupsPropagated += 1;
      }
    } else {
      report.groupsIdentical += 1;
    }
  }

  if (opts.dryRun) {
    return;
  }

  const failedGroups = new Set<string>();
  const byAdapterTier = groupBy(planned, (write) =>
    `${write.adapter.id}/${write.doc.meta.tier}`,
  );

  for (const writes of byAdapterTier.values()) {
    const first = writes[0];

    if (!first) {
      continue;
    }

    try {
      const writeReport = await first.adapter.writeResources?.(
        kind,
        scope,
        writes.map((write) => write.doc),
      );

      report.writes.push({
        provider: first.adapter.id,
        tier: first.doc.meta.tier,
        written: writeReport?.written ?? [],
        skipped: writeReport?.skipped ?? [],
      });
    } catch (error) {
      logger.error(`Failed to write ${first.adapter.id} ${kind} resources.`, error);

      for (const write of writes) {
        failedGroups.add(write.groupKey);
      }
    }
  }

  report.groupsFailed += failedGroups.size;
  updateResourceCacheEntries(opts.cache, kind, groups, resolved, failedGroups);
}

export async function sync(opts: SyncOpts): Promise<SyncReport> {
  const start = Date.now();
  const dryRun = opts.dryRun ?? false;
  const logger = opts.logger ?? createLogger();
  const report = emptyReport(dryRun, start);
  const resourceKinds = opts.resourceKinds ?? ["memory"];
  const includeMemory = resourceKinds.includes("memory");
  const tierFilter = resolveTierFilter(opts);
  const adapters = await activeAdapters(
    opts.registry,
    opts.cwd,
    opts.provider,
    logger,
  );
  const sourceDocs: SourceDoc[] = [];
  const adapterTiers = new Map<string, AdapterTier>();

  if (includeMemory) {
    for (const adapter of adapters) {
      let detect;

      try {
        detect = await adapter.detect(opts.cwd);
      } catch (error) {
        logger.warn(`Failed to detect ${adapter.id}; skipping provider.`, error);
        continue;
      }

      const activeTierSet = new Set<Tier>(detect.activeTiers);
      for (const tier of tierFilter) {
        const adapterTier = { adapter, tier };
        adapterTiers.set(adapterTierKey(adapter.id, tier), adapterTier);

        if (!activeTierSet.has(tier)) {
          continue;
        }

        try {
          const docs = await adapter.read(tier);

          for (const doc of docs) {
            sourceDocs.push({ adapter, tier, doc });
          }
        } catch (error) {
          logger.warn(
            `Failed to read ${adapter.id} ${tier}; skipping tier.`,
            error,
          );
        }
      }
    }

    const allDocs = applyExclusions(
      opts.registry.dedupeSharedGlobal(sourceDocs.map(({ doc }) => doc)),
      opts.excludePaths,
    );
    const includedDocs = new Set(allDocs);
    const includedSourceDocs = sourceDocs.filter(({ doc }) =>
      includedDocs.has(doc),
    );
    const groups = groupBy(allDocs, (doc) =>
      groupKeyForDoc(doc, opts.mappingOverrides),
    );
    const resolved = new Map<string, MemoryDoc | null>();
    const resolveOpts = {
      strategy: opts.strategy,
      isTTY: opts.isTTY,
      promptUser: opts.promptUser,
      logger,
    } satisfies ResolveOptions & { logger: Logger };
    const statuses = new Map<string, GroupStatus>();

    report.groupsTotal += groups.size;

    for (const [groupKey, docs] of groups) {
      const result = await resolveGroup(
        docs,
        cachePrevForGroup(opts.cache, groupKey),
        resolveOpts,
      );

      tallyResolveStatus(report, result.status);
      statuses.set(groupKey, { status: result.status });
      resolved.set(groupKey, result.doc);
    }

    const missingTargetDocs = buildMissingTargetDocs(
      adapterTiers.values(),
      includedSourceDocs,
      new Set(groups.keys()),
      opts.cwd,
      opts.mappingOverrides,
      opts.excludePaths,
    );

    const writePlan = buildWritePlan(
      [...includedSourceDocs, ...missingTargetDocs],
      resolved,
      opts.mappingOverrides,
    );
    adjustWriteStatuses(report, statuses, writePlan);

    if (!dryRun) {
      const backupTargets = backupTargetsFor(writePlan);

      if (backupTargets.length > 0) {
        await createBackup(opts.mementoDir, backupTargets);
      }

      const failedGroups = new Set<string>();

      for (const [key, writes] of writePlan) {
        const adapterTier = adapterTiers.get(key);

        if (!adapterTier || writes.length === 0) {
          continue;
        }

        try {
          const writeReport = await adapterTier.adapter.write(
            adapterTier.tier,
            writes.map((write) => write.doc),
          );

          report.writes.push({
            provider: adapterTier.adapter.id,
            tier: adapterTier.tier,
            written: writeReport.written,
            skipped: writeReport.skipped,
          });
        } catch (error) {
          if (!(error instanceof AdapterError)) {
            throw error;
          }

          logger.error(
            `Failed to write ${adapterTier.adapter.id} ${adapterTier.tier}.`,
            error,
          );

          for (const write of writes) {
            failedGroups.add(write.groupKey);
          }
        }
      }

      report.groupsFailed += failedGroups.size;
      updateCacheEntries(opts.cache, groups, resolved, failedGroups);
    }
  }

  for (const kind of resourceKinds.filter((kind) => kind !== "memory")) {
    await syncResourceKind(
      kind,
      opts.resourceScope ?? "local",
      adapters,
      opts,
      report,
      logger,
    );
  }

  if (!dryRun) {
    try {
      await saveCache(path.join(opts.mementoDir, "cache.json"), opts.cache);
      report.cacheUpdated = true;
    } catch (error) {
      logger.error("Failed to save sync cache.", error);
      report.cacheUpdated = false;
    }
  }

  report.durationMs = Date.now() - start;
  return report;
}
