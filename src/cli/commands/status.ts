import path from "node:path";

import pc from "picocolors";

import type { DetectResult, ProviderAdapter } from "../../adapters/types.js";
import { createCliRegistry } from "../helpers/registry.js";
import { resolveCliContext } from "../helpers/context.js";
import { loadCache, type Cache } from "../../core/cache.js";
import { loadConfig, type MementoConfigFile } from "../../core/config.js";
import { MementoError } from "../../core/errors.js";
import { applyOverrides } from "../../core/identity.js";
import {
  applyExclusions,
  groupBy,
  resolveTierFilter,
} from "../../core/sync.js";
import { createLogger, type Logger } from "../../core/logger.js";
import type { MemoryDoc, ProviderId, Tier } from "../../core/types.js";

export interface StatusOpts {
  tier?: Tier;
  includeGlobal?: boolean;
  json?: boolean;
  debug?: boolean;
  contextMode?: "project" | "global";
}

type GroupStatus = "in-sync" | "modified" | "new" | "orphan";

interface ProviderStatus {
  id: ProviderId;
  displayName: string;
  enabled: boolean;
  auto: boolean;
  includeOrphan: boolean;
  installed: boolean;
  hasMemory: boolean;
  active: boolean;
  orphan: boolean;
  tiers: Tier[];
}

interface StatusGroup {
  key: string;
  tier: Tier;
  identityKey: string;
  status: GroupStatus;
  providers: ProviderId[];
  paths: string[];
  bodyHashes: string[];
  cacheBodyHash: string | null;
}

interface TierStatus {
  total: number;
  inSync: number;
  modified: number;
  new: number;
  orphan: number;
}

interface StatusReport {
  providers: ProviderStatus[];
  tiers: Record<Tier, TierStatus>;
  groups: StatusGroup[];
}

interface AdapterDetection {
  adapter: ProviderAdapter;
  detect: DetectResult;
  provider: ProviderStatus;
}

const tiers: Tier[] = ["project", "project-local", "global"];

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  success: () => undefined,
  startSpinner: () => undefined,
  stopSpinner: () => undefined,
};

function isTier(value: string): value is Tier {
  return tiers.includes(value as Tier);
}

export function parseStatusTier(value: string | undefined): Tier | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isTier(value)) {
    return value;
  }

  throw new MementoError("INVALID_TIER", `Invalid tier: ${value}`, {
    exitCode: 1,
    hint: "Use project, project-local, or global.",
  });
}

function emptyTierStatus(): TierStatus {
  return {
    total: 0,
    inSync: 0,
    modified: 0,
    new: 0,
    orphan: 0,
  };
}

function tierStatuses(): Record<Tier, TierStatus> {
  return {
    project: emptyTierStatus(),
    "project-local": emptyTierStatus(),
    global: emptyTierStatus(),
  };
}

function providerStatusFor(
  adapter: ProviderAdapter,
  detect: DetectResult,
  config: MementoConfigFile,
): ProviderStatus {
  const providerConfig = config.providers[adapter.id];
  const orphan = !detect.installed && detect.hasMemory;

  return {
    id: adapter.id,
    displayName: adapter.displayName,
    enabled: providerConfig.enabled,
    auto: providerConfig.auto,
    includeOrphan: providerConfig.include_orphan ?? false,
    installed: detect.installed,
    hasMemory: detect.hasMemory,
    active: detect.active,
    orphan,
    tiers: detect.activeTiers,
  };
}

function includeAdapter(provider: ProviderStatus): boolean {
  if (!provider.active) {
    return false;
  }

  if (provider.enabled || provider.auto) {
    return true;
  }

  return provider.orphan && provider.includeOrphan;
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

function statusForGroup(
  docs: MemoryDoc[],
  cache: Cache,
  groupKey: string,
  providerById: Map<ProviderId, ProviderStatus>,
): GroupStatus {
  if (docs.some((doc) => providerById.get(doc.meta.source)?.orphan)) {
    return "orphan";
  }

  const cacheEntry = cache.entries[groupKey];

  if (!cacheEntry) {
    return "new";
  }

  return docs.every((doc) => doc.meta.bodyHash === cacheEntry.bodyHash)
    ? "in-sync"
    : "modified";
}

function buildStatusGroup(
  key: string,
  docs: MemoryDoc[],
  cache: Cache,
  providerById: Map<ProviderId, ProviderStatus>,
): StatusGroup {
  const [tier, ...identityParts] = key.split("/");
  const status = statusForGroup(docs, cache, key, providerById);
  const providers = [...new Set(docs.map((doc) => doc.meta.source))].sort();
  const paths = [...new Set(docs.map((doc) => doc.meta.sourcePath))].sort();
  const bodyHashes = [...new Set(docs.map((doc) => doc.meta.bodyHash))].sort();

  return {
    key,
    tier: tier as Tier,
    identityKey: identityParts.join("/"),
    status,
    providers,
    paths,
    bodyHashes,
    cacheBodyHash: cache.entries[key]?.bodyHash ?? null,
  };
}

async function detectAdapters(
  adapters: ProviderAdapter[],
  cwd: string,
  config: MementoConfigFile,
): Promise<AdapterDetection[]> {
  const detections = await Promise.all(
    adapters.map(async (adapter) => {
      const detect = await adapter.detect(cwd);
      const provider = providerStatusFor(adapter, detect, config);

      return {
        adapter,
        detect,
        provider,
      };
    }),
  );

  return detections.filter(({ provider }) => includeAdapter(provider));
}

async function collectDocs(
  detections: AdapterDetection[],
  cwd: string,
  tierFilter: Tier[],
): Promise<MemoryDoc[]> {
  const docs: MemoryDoc[] = [];

  for (const { adapter, detect } of detections) {
    for (const tier of intersectTiers(detect.activeTiers, tierFilter)) {
      docs.push(...(await adapter.read(tier)));
    }
  }

  return docs.filter((doc) => {
    const adapter = detections.find(
      ({ provider }) => provider.id === doc.meta.source,
    );
    return adapter
      ? intersectTiers(adapter.detect.activeTiers, tierFilter).includes(
          doc.meta.tier,
        )
      : doc.meta.sourcePath.startsWith(cwd) || doc.meta.tier === "global";
  });
}

function buildReport(
  providers: ProviderStatus[],
  docs: MemoryDoc[],
  cache: Cache,
  mappingOverrides?: Record<string, string[]>,
): StatusReport {
  const providerById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const grouped = groupBy(docs, (doc) => groupKeyForDoc(doc, mappingOverrides));
  const groups = [...grouped.entries()]
    .map(([key, groupDocs]) =>
      buildStatusGroup(key, groupDocs, cache, providerById),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  const tierCounts = tierStatuses();

  for (const group of groups) {
    const counts = tierCounts[group.tier];
    counts.total += 1;

    switch (group.status) {
      case "in-sync":
        counts.inSync += 1;
        break;
      case "modified":
        counts.modified += 1;
        break;
      case "new":
        counts.new += 1;
        break;
      case "orphan":
        counts.orphan += 1;
        break;
    }
  }

  return {
    providers,
    tiers: tierCounts,
    groups,
  };
}

function statusBadge(status: GroupStatus, isTTY: boolean): string {
  if (!isTTY) {
    return status;
  }

  switch (status) {
    case "in-sync":
      return pc.green("✓ in-sync");
    case "modified":
      return pc.yellow("⚠ modified");
    case "new":
      return pc.cyan("⚠ new");
    case "orphan":
      return pc.red("✗ orphan");
  }
}

function providerLabel(provider: ProviderStatus, isTTY: boolean): string {
  const status = provider.orphan
    ? "orphan"
    : provider.installed
      ? "installed"
      : "not-installed";

  if (!isTTY) {
    return `${provider.id}\t${status}\t${provider.tiers.join(",")}`;
  }

  const badge = provider.orphan
    ? pc.red("✗")
    : provider.installed
      ? pc.green("✓")
      : pc.yellow("⚠");

  return `${badge} ${provider.id} ${pc.dim(`(${status})`)}`;
}

function writeJson(report: StatusReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function writeNonTty(report: StatusReport): void {
  process.stdout.write("tier\tkey\tstatus\tproviders\tpaths\n");

  for (const group of report.groups) {
    process.stdout.write(
      `${group.tier}\t${group.identityKey}\t${group.status}\t${group.providers.join(
        ",",
      )}\t${group.paths.join(",")}\n`,
    );
  }

  if (report.groups.length === 0) {
    process.stdout.write("clean\tno memory groups found\n");
    return;
  }

  if (report.groups.every((group) => group.status === "in-sync")) {
    process.stdout.write("summary\tclean\tall memory groups in sync\n");
  }
}

function writeTty(report: StatusReport): void {
  process.stdout.write(`${pc.bold("memento status")}\n\n`);
  process.stdout.write(`${pc.bold("Providers")}\n`);

  if (report.providers.length === 0) {
    process.stdout.write(`${pc.dim("No active providers found.")}\n`);
  } else {
    for (const provider of report.providers) {
      process.stdout.write(`${providerLabel(provider, true)}\n`);
    }
  }

  process.stdout.write("\n");

  for (const tier of tiers) {
    const groups = report.groups.filter((group) => group.tier === tier);
    if (groups.length === 0) {
      continue;
    }

    process.stdout.write(`${pc.bold(tier)}\n`);

    for (const group of groups) {
      process.stdout.write(
        `${statusBadge(group.status, true)}  ${group.identityKey}  ${pc.dim(
          group.providers.join(", "),
        )}\n`,
      );
    }

    process.stdout.write("\n");
  }

  if (report.groups.length === 0) {
    process.stdout.write(`${pc.green("✓ clean")} no memory groups found\n`);
    return;
  }

  const dirty = report.groups.filter((group) => group.status !== "in-sync");
  if (dirty.length === 0) {
    process.stdout.write(`${pc.green("✓ clean")} all memory groups in sync\n`);
  }
}

function writeReport(report: StatusReport, opts: StatusOpts): void {
  if (opts.json) {
    writeJson(report);
    return;
  }

  if (process.stdout.isTTY) {
    writeTty(report);
    return;
  }

  writeNonTty(report);
}

export async function runStatus(opts: StatusOpts): Promise<number> {
  const logger = createLogger({
    mode: opts.json ? "json" : process.stdout.isTTY ? "tty" : "non-tty",
    debug: opts.debug ?? false,
  });

  try {
    const context = await resolveCliContext({
      cwd: process.cwd(),
      mode: opts.contextMode,
    });
    const config = await loadConfig(context.mementoDir);
    const cache = await loadCache(
      path.join(context.mementoDir, "cache.json"),
      silentLogger,
    );
    const registry = createCliRegistry();
    const tierFilter = resolveTierFilter({
      tier: context.mode === "global" ? undefined : opts.tier,
      includeGlobal: context.mode === "global" ? undefined : opts.includeGlobal,
      globalOnly: context.mode === "global",
    });
    const detections = await detectAdapters(
      registry.all(),
      context.root,
      config,
    );
    const docs = await collectDocs(detections, context.root, tierFilter);
    const includedDocs = applyExclusions(
      registry.dedupeSharedGlobal(docs),
      config.exclude?.paths,
    );
    const report = buildReport(
      detections.map(({ provider }) => provider),
      includedDocs,
      cache,
      config.mapping,
    );

    writeReport(report, opts);

    return 0;
  } catch (error) {
    if (error instanceof MementoError) {
      logger.error(error.message);

      if (error.hint) {
        logger.error(`Hint: ${error.hint}`);
      }

      return error.exitCode;
    }

    if (error instanceof Error) {
      logger.error(opts.debug ? (error.stack ?? error.message) : error.message);
      return 1;
    }

    logger.error(String(error));
    return 1;
  }
}
