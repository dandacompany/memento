import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { AdapterRegistry } from "../adapters/registry.js";
import type { ProviderAdapter } from "../adapters/types.js";
import { readFileText, sha256Hex } from "../adapters/shared/io.js";
import { createBackup, type BackupTarget } from "./backup.js";
import { AdapterError, MementoError } from "./errors.js";
import { applyOverrides } from "./identity.js";
import { createLogger, type Logger } from "./logger.js";
import { resourceGroupKeyForDoc } from "./resource-identity.js";
import type { ResourceDoc, ResourceKind, ResourceScope } from "./resource-types.js";
import type { MemoryDoc, ProviderId, Tier } from "./types.js";

export type ImportStrategy = "prompt" | "skip" | "replace" | "append";

export interface ImportProjectOpts {
  sourceRoot: string;
  targetRoot: string;
  mementoDir: string;
  sourceRegistry: AdapterRegistry;
  targetRegistry: AdapterRegistry;
  targetProviders: ProviderId[];
  sourceProviders?: ProviderId[];
  resourceKinds: ResourceKind[];
  resourceScope: ResourceScope;
  tiers?: Tier[];
  strategy: ImportStrategy;
  dryRun?: boolean;
  isTTY: boolean;
  logger?: Logger;
}

export interface ImportProjectReport {
  sourceRoot: string;
  targetRoot: string;
  dryRun: boolean;
  groupsTotal: number;
  groupsImported: number;
  groupsSkipped: number;
  groupsFailed: number;
  writes: {
    provider: ProviderId;
    tier: Tier;
    kind: ResourceKind;
    written: string[];
    skipped: string[];
  }[];
  backupSaved: boolean;
  durationMs: number;
}

interface MemorySourceDoc {
  adapter: ProviderAdapter;
  tier: Tier;
  doc: MemoryDoc;
}

interface MemoryWritePlan {
  groupKey: string;
  adapter: ProviderAdapter;
  tier: Tier;
  existing?: MemoryDoc;
  doc: MemoryDoc;
  skipped?: boolean;
}

interface ResourceWritePlan {
  groupKey: string;
  kind: ResourceKind;
  adapter: ProviderAdapter;
  existing?: ResourceDoc;
  doc: ResourceDoc;
  skipped?: boolean;
}

const defaultTiers: Tier[] = ["project", "project-local"];

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

function selectNewest<T extends { meta: { mtime: number } }>(docs: T[]): T {
  const first = docs[0];

  if (!first) {
    throw new MementoError("IMPORT_EMPTY_GROUP", "Cannot import an empty group.", {
      exitCode: 1,
    });
  }

  return docs.reduce((winner, doc) =>
    doc.meta.mtime > winner.meta.mtime ? doc : winner,
  );
}

function memoryGroupKey(
  doc: MemoryDoc,
  mappingOverrides?: Record<string, string[]>,
): string {
  return `${doc.meta.tier}/${applyOverrides(doc.meta.identityKey, mappingOverrides)}`;
}

function providersFromRegistry(
  registry: AdapterRegistry,
  providers?: ProviderId[],
): ProviderAdapter[] {
  if (!providers || providers.length === 0) {
    return registry.all();
  }

  return providers.flatMap((provider) => {
    const adapter = registry.get(provider);
    return adapter ? [adapter] : [];
  });
}

function targetPathForNewMemory(
  adapter: ProviderAdapter,
  targetRoot: string,
  tier: Tier,
  source: MemoryDoc,
): string | null {
  if (source.meta.identityKey !== "agents-md:main") {
    return null;
  }

  const paths = adapter.paths(targetRoot)[tier] ?? [];

  return paths[0] ?? null;
}

function makeTargetMemoryDoc(
  adapter: ProviderAdapter,
  targetRoot: string,
  source: MemoryDoc,
  body: string,
  existing?: MemoryDoc,
): MemoryDoc | null {
  const sourcePath =
    existing?.meta.sourcePath ??
    targetPathForNewMemory(adapter, targetRoot, source.meta.tier, source);

  if (!sourcePath) {
    return null;
  }

  return {
    body,
    meta: {
      ...source.meta,
      source: adapter.id,
      sourcePath,
      mtime: existing?.meta.mtime ?? Date.now(),
      bodyHash: sha256Hex(body),
      rawHash: sha256Hex(body),
      frontmatter: existing?.meta.frontmatter ?? source.meta.frontmatter,
      title: existing?.meta.title ?? source.meta.title,
      tags: existing?.meta.tags ?? source.meta.tags,
      ...(existing?.meta.subtype
        ? { subtype: existing.meta.subtype }
        : { subtype: source.meta.subtype }),
    },
  };
}

function appendImportBlock(existing: string, imported: MemoryDoc): string {
  const trimmedExisting = existing.trimEnd();
  const trimmedImport = imported.body.trim();
  const sourceLabel = path.basename(path.dirname(imported.meta.sourcePath)) ||
    imported.meta.source;

  if (trimmedImport.length === 0) {
    return `${trimmedExisting}\n`;
  }

  return [
    trimmedExisting,
    "",
    `## Imported from ${sourceLabel}`,
    "",
    trimmedImport,
    "",
  ].join("\n");
}

async function promptImportAction(
  groupKey: string,
  provider: ProviderId,
  allowAppend: boolean,
): Promise<"replace" | "append" | "skip"> {
  const rl = createInterface({ input, output });

  try {
    const suffix = allowAppend ? "[r]eplace, [a]ppend, [s]kip" : "[r]eplace, [s]kip";

    for (;;) {
      const answer = (
        await rl.question(`Import ${groupKey} into ${provider}? ${suffix}: `)
      )
        .trim()
        .toLowerCase();

      if (answer === "r" || answer === "replace") {
        return "replace";
      }

      if (allowAppend && (answer === "a" || answer === "append")) {
        return "append";
      }

      if (answer === "" || answer === "s" || answer === "skip") {
        return "skip";
      }
    }
  } finally {
    rl.close();
  }
}

async function resolveAction(
  strategy: ImportStrategy,
  opts: { isTTY: boolean; groupKey: string; provider: ProviderId; allowAppend: boolean },
): Promise<"replace" | "append" | "skip"> {
  if (strategy === "replace" || strategy === "skip") {
    return strategy;
  }

  if (strategy === "append") {
    return opts.allowAppend ? "append" : "replace";
  }

  if (!opts.isTTY) {
    return "skip";
  }

  return promptImportAction(opts.groupKey, opts.provider, opts.allowAppend);
}

async function readSourceMemory(
  adapters: ProviderAdapter[],
  sourceRoot: string,
  tiers: Tier[],
  logger: Logger,
): Promise<MemorySourceDoc[]> {
  const sourceDocs: MemorySourceDoc[] = [];
  const tierSet = new Set(tiers);

  for (const adapter of adapters) {
    let activeTiers: Tier[];

    try {
      const detect = await adapter.detect(sourceRoot);
      activeTiers = detect.activeTiers.filter((tier) => tierSet.has(tier));
    } catch (error) {
      logger.warn(`Failed to detect ${adapter.id} in source project.`, error);
      continue;
    }

    for (const tier of activeTiers) {
      try {
        const docs = await adapter.read(tier);
        sourceDocs.push(...docs.map((doc) => ({ adapter, tier, doc })));
      } catch (error) {
        logger.warn(`Failed to read ${adapter.id} ${tier} from source.`, error);
      }
    }
  }

  return sourceDocs;
}

async function readTargetMemory(
  adapters: ProviderAdapter[],
  tiers: Tier[],
  logger: Logger,
): Promise<MemorySourceDoc[]> {
  const targetDocs: MemorySourceDoc[] = [];

  for (const adapter of adapters) {
    for (const tier of tiers) {
      try {
        const docs = await adapter.read(tier);
        targetDocs.push(...docs.map((doc) => ({ adapter, tier, doc })));
      } catch (error) {
        if (error instanceof AdapterError) {
          logger.warn(`Failed to read ${adapter.id} ${tier} from target.`, error);
          continue;
        }

        throw error;
      }
    }
  }

  return targetDocs;
}

async function planMemoryWrites(
  sourceDocs: MemorySourceDoc[],
  targetDocs: MemorySourceDoc[],
  targetAdapters: ProviderAdapter[],
  opts: ImportProjectOpts,
): Promise<MemoryWritePlan[]> {
  const sourceGroups = groupBy(sourceDocs, ({ doc }) => memoryGroupKey(doc));
  const targetGroups = groupBy(targetDocs, ({ doc }) => memoryGroupKey(doc));
  const plan: MemoryWritePlan[] = [];

  for (const [groupKey, group] of sourceGroups) {
    const sourceDoc = selectNewest(group.map(({ doc }) => doc));
    const targetGroup = targetGroups.get(groupKey) ?? [];

    for (const adapter of targetAdapters) {
      const existingDocs = targetGroup
        .filter(({ adapter: targetAdapter }) => targetAdapter.id === adapter.id)
        .map(({ doc }) => doc);
      const targets = existingDocs.length > 0 ? existingDocs : [undefined];

      for (const existing of targets) {
        if (existing && existing.meta.bodyHash === sourceDoc.meta.bodyHash) {
          plan.push({
            groupKey,
            adapter,
            tier: sourceDoc.meta.tier,
            existing,
            doc: existing,
            skipped: true,
          });
          continue;
        }

        const action = existing
          ? await resolveAction(opts.strategy, {
              isTTY: opts.isTTY,
              groupKey,
              provider: adapter.id,
              allowAppend: true,
            })
          : "replace";

        if (action === "skip") {
          const placeholder =
            existing ??
            makeTargetMemoryDoc(
              adapter,
              opts.targetRoot,
              sourceDoc,
              sourceDoc.body,
              undefined,
            );

          if (placeholder) {
            plan.push({
              groupKey,
              adapter,
              tier: sourceDoc.meta.tier,
              doc: placeholder,
              existing,
              skipped: true,
            });
          }

          continue;
        }

        const nextBody =
          action === "append" && existing
            ? appendImportBlock(existing.body, sourceDoc)
            : sourceDoc.body;
        const targetDoc = makeTargetMemoryDoc(
          adapter,
          opts.targetRoot,
          sourceDoc,
          nextBody,
          existing,
        );

        if (!targetDoc) {
          continue;
        }

        plan.push({
          groupKey,
          adapter,
          tier: targetDoc.meta.tier,
          existing,
          doc: targetDoc,
        });
      }
    }
  }

  return plan;
}

async function previousContent(doc: MemoryDoc | undefined): Promise<string | null> {
  if (!doc) {
    return null;
  }

  return readFileText(doc.meta.sourcePath);
}

async function backupTargetsForMemory(
  plan: MemoryWritePlan[],
): Promise<BackupTarget[]> {
  const targets = new Map<string, BackupTarget>();

  for (const write of plan) {
    if (write.skipped) {
      continue;
    }

    const content = await previousContent(write.existing);

    if (content === null) {
      continue;
    }

    targets.set(write.doc.meta.sourcePath, {
      absPath: write.doc.meta.sourcePath,
      previousContent: content,
      groupKey: write.groupKey,
    });
  }

  return [...targets.values()];
}

async function writeMemoryPlan(
  plan: MemoryWritePlan[],
  report: ImportProjectReport,
): Promise<void> {
  const byAdapterTier = groupBy(
    plan.filter((write) => !write.skipped),
    (write) => `${write.adapter.id}/${write.tier}`,
  );

  for (const writes of byAdapterTier.values()) {
    const first = writes[0];

    if (!first) {
      continue;
    }

    const writeReport = await first.adapter.write(
      first.tier,
      writes.map((write) => write.doc),
    );

    report.writes.push({
      provider: first.adapter.id,
      tier: first.tier,
      kind: "memory",
      written: writeReport.written,
      skipped: writeReport.skipped,
    });
  }
}

function targetResourceDoc(
  adapter: ProviderAdapter,
  source: ResourceDoc,
  existing?: ResourceDoc,
): ResourceDoc {
  return {
    ...(existing ?? source),
    body: source.body,
    meta: {
      ...(existing?.meta ?? source.meta),
      provider: adapter.id,
      scope: source.meta.scope,
      tier: existing?.meta.tier ?? source.meta.tier,
      identityKey: source.meta.identityKey,
      sourcePath: existing?.meta.sourcePath ?? "",
      sourceFormat: existing?.meta.sourceFormat ?? source.meta.sourceFormat,
      sensitive: source.meta.sensitive,
      redactions: source.meta.redactions,
      mtime: existing?.meta.mtime ?? Date.now(),
      bodyHash: source.meta.bodyHash,
      rawHash: source.meta.rawHash,
      title: source.meta.title,
      tags: source.meta.tags,
      writeable: existing?.meta.writeable ?? true,
    },
  };
}

async function readResources(
  adapters: ProviderAdapter[],
  kind: ResourceKind,
  scope: ResourceScope,
  logger: Logger,
): Promise<ResourceDoc[]> {
  const docs: ResourceDoc[] = [];

  for (const adapter of adapters) {
    if (!adapter.readResources) {
      continue;
    }

    try {
      docs.push(...(await adapter.readResources(kind, scope)));
    } catch (error) {
      logger.warn(`Failed to read ${adapter.id} ${kind} resources.`, error);
    }
  }

  return docs;
}

async function planResourceWrites(
  kind: ResourceKind,
  sourceDocs: ResourceDoc[],
  targetDocs: ResourceDoc[],
  targetAdapters: ProviderAdapter[],
  opts: ImportProjectOpts,
): Promise<ResourceWritePlan[]> {
  const sourceGroups = groupBy(sourceDocs, resourceGroupKeyForDoc);
  const targetGroups = groupBy(targetDocs, resourceGroupKeyForDoc);
  const plan: ResourceWritePlan[] = [];

  for (const [groupKey, group] of sourceGroups) {
    const sourceDoc = selectNewest(group);
    const targetGroup = targetGroups.get(groupKey) ?? [];

    for (const adapter of targetAdapters.filter(
      (target) => typeof target.writeResources === "function",
    )) {
      const existing = targetGroup.find((doc) => doc.meta.provider === adapter.id);

      if (existing && existing.meta.bodyHash === sourceDoc.meta.bodyHash) {
        plan.push({
          groupKey,
          kind,
          adapter,
          existing,
          doc: existing,
          skipped: true,
        });
        continue;
      }

      const action = existing
        ? await resolveAction(opts.strategy, {
            isTTY: opts.isTTY,
            groupKey,
            provider: adapter.id,
            allowAppend: false,
          })
        : "replace";

      if (action === "skip") {
        plan.push({
          groupKey,
          kind,
          adapter,
          existing,
          doc: targetResourceDoc(adapter, sourceDoc, existing),
          skipped: true,
        });
        continue;
      }

      plan.push({
        groupKey,
        kind,
        adapter,
        existing,
        doc: targetResourceDoc(adapter, sourceDoc, existing),
      });
    }
  }

  return plan;
}

async function writeResourcePlan(
  kind: ResourceKind,
  scope: ResourceScope,
  plan: ResourceWritePlan[],
  report: ImportProjectReport,
): Promise<void> {
  const byAdapterTier = groupBy(
    plan.filter((write) => !write.skipped),
    (write) => `${write.adapter.id}/${write.doc.meta.tier}`,
  );

  for (const writes of byAdapterTier.values()) {
    const first = writes[0];

    if (!first) {
      continue;
    }

    const writeReport = await first.adapter.writeResources?.(
      kind,
      scope,
      writes.map((write) => write.doc),
    );

    report.writes.push({
      provider: first.adapter.id,
      tier: first.doc.meta.tier,
      kind,
      written: writeReport?.written ?? [],
      skipped: writeReport?.skipped ?? [],
    });
  }
}

function incrementReportFromPlan(
  report: ImportProjectReport,
  plan: Array<{ skipped?: boolean }>,
): void {
  report.groupsImported += plan.filter((write) => !write.skipped).length;
  report.groupsSkipped += plan.filter((write) => write.skipped).length;
}

export async function importProject(
  opts: ImportProjectOpts,
): Promise<ImportProjectReport> {
  const start = Date.now();
  const logger = opts.logger ?? createLogger();
  const dryRun = opts.dryRun ?? false;
  const tiers = opts.tiers ?? defaultTiers;
  const sourceAdapters = providersFromRegistry(
    opts.sourceRegistry,
    opts.sourceProviders,
  );
  const targetAdapters = providersFromRegistry(
    opts.targetRegistry,
    opts.targetProviders,
  );
  const report: ImportProjectReport = {
    sourceRoot: opts.sourceRoot,
    targetRoot: opts.targetRoot,
    dryRun,
    groupsTotal: 0,
    groupsImported: 0,
    groupsSkipped: 0,
    groupsFailed: 0,
    writes: [],
    backupSaved: false,
    durationMs: 0,
  };

  if (targetAdapters.length === 0) {
    throw new MementoError("NO_TARGET_PROVIDERS", "No target providers selected.", {
      exitCode: 4,
      hint: "Run memento init or pass --to with an enabled provider.",
    });
  }

  if (opts.resourceKinds.includes("memory")) {
    const sourceMemory = await readSourceMemory(
      sourceAdapters,
      opts.sourceRoot,
      tiers,
      logger,
    );
    const targetMemory = await readTargetMemory(targetAdapters, tiers, logger);
    const plan = await planMemoryWrites(
      sourceMemory,
      targetMemory,
      targetAdapters,
      opts,
    );

    report.groupsTotal += groupBy(sourceMemory, ({ doc }) => memoryGroupKey(doc)).size;
    incrementReportFromPlan(report, plan);

    if (!dryRun) {
      const backupTargets = await backupTargetsForMemory(plan);

      if (backupTargets.length > 0) {
        await createBackup(opts.mementoDir, backupTargets);
        report.backupSaved = true;
      }

      await writeMemoryPlan(plan, report);
    }
  }

  for (const kind of opts.resourceKinds.filter((resource) => resource !== "memory")) {
    const sourceResources = await readResources(
      sourceAdapters,
      kind,
      opts.resourceScope,
      logger,
    );
    const targetResources = await readResources(
      targetAdapters,
      kind,
      opts.resourceScope,
      logger,
    );
    const plan = await planResourceWrites(
      kind,
      sourceResources,
      targetResources,
      targetAdapters,
      opts,
    );

    report.groupsTotal += groupBy(sourceResources, resourceGroupKeyForDoc).size;
    incrementReportFromPlan(report, plan);

    if (!dryRun) {
      await writeResourcePlan(kind, opts.resourceScope, plan, report);
    }
  }

  report.durationMs = Date.now() - start;
  return report;
}

export async function assertImportSource(sourceRoot: string): Promise<void> {
  const stat = await fs.stat(sourceRoot).catch(() => null);

  if (!stat?.isDirectory()) {
    throw new MementoError("INVALID_IMPORT_SOURCE", `Import source not found: ${sourceRoot}`, {
      exitCode: 1,
      hint: "Pass a directory containing another project's assistant memory files.",
    });
  }
}
