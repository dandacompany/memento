import path from "node:path";

import type { AdapterRegistry } from "../adapters/registry.js";
import type { ProviderAdapter } from "../adapters/types.js";
import { AdapterError } from "./errors.js";
import { applyOverrides } from "./identity.js";
import { createBackup, type BackupTarget } from "./backup.js";
import { createLogger, type Logger } from "./logger.js";
import { resolveGroup, type ResolveOptions } from "./resolver.js";
import { saveCache, type Cache } from "./cache.js";
import { sha256Hex } from "../adapters/shared/io.js";
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
}

interface PlannedWrite {
  groupKey: string;
  original: MemoryDoc;
  doc: MemoryDoc;
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
    });
    plan.set(key, writes);
  }

  return plan;
}

function backupTargetsFor(plan: Map<string, PlannedWrite[]>): BackupTarget[] {
  const targets = new Map<string, BackupTarget>();

  for (const writes of plan.values()) {
    for (const write of writes) {
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

export async function sync(opts: SyncOpts): Promise<SyncReport> {
  const start = Date.now();
  const dryRun = opts.dryRun ?? false;
  const logger = opts.logger ?? createLogger();
  const report = emptyReport(dryRun, start);
  const tierFilter = resolveTierFilter(opts);
  const adapters = await activeAdapters(
    opts.registry,
    opts.cwd,
    opts.provider,
    logger,
  );
  const sourceDocs: SourceDoc[] = [];
  const adapterTiers = new Map<string, AdapterTier>();

  for (const adapter of adapters) {
    let detect;

    try {
      detect = await adapter.detect(opts.cwd);
    } catch (error) {
      logger.warn(`Failed to detect ${adapter.id}; skipping provider.`, error);
      continue;
    }

    for (const tier of intersectTiers(detect.activeTiers, tierFilter)) {
      const adapterTier = { adapter, tier };
      adapterTiers.set(adapterTierKey(adapter.id, tier), adapterTier);

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

  report.groupsTotal = groups.size;

  for (const [groupKey, docs] of groups) {
    const result = await resolveGroup(
      docs,
      cachePrevForGroup(opts.cache, groupKey),
      resolveOpts,
    );

    tallyResolveStatus(report, result.status);
    resolved.set(groupKey, result.doc);
  }

  const writePlan = buildWritePlan(
    includedSourceDocs,
    resolved,
    opts.mappingOverrides,
  );

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
