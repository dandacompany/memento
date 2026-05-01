import { AdapterRegistry } from "../../adapters/registry.js";
import type { ProviderAdapter } from "../../adapters/types.js";
import { loadCache, type Cache } from "../../core/cache.js";
import { loadConfig } from "../../core/config.js";
import { MementoError } from "../../core/errors.js";
import { applyOverrides } from "../../core/identity.js";
import { createLogger, type Logger } from "../../core/logger.js";
import {
  parseResourceKinds,
  parseResourceScope,
} from "../../core/resource-options.js";
import { resourceGroupKeyForDoc } from "../../core/resource-identity.js";
import type {
  ResourceDoc,
  ResourceKind,
  ResourceScope,
} from "../../core/resource-types.js";
import { groupBy, resolveTierFilter } from "../../core/sync.js";
import type { MemoryDoc, ProviderId, Tier } from "../../core/types.js";
import { resolveCliContext } from "../helpers/context.js";
import { createCliRegistry } from "../helpers/registry.js";

export interface DiffCmdOpts {
  group?: string;
  all?: boolean;
  unified?: boolean;
  provider?: ProviderId;
  tier?: Tier;
  resources?: string;
  scope?: string;
  mcp?: boolean;
  skills?: boolean;
  showSecrets?: boolean;
  includeGlobal?: boolean;
  json?: boolean;
  debug?: boolean;
  quiet?: boolean;
  mode?: "project" | "global";
}

type DiffStatus = "identical" | "modified" | "conflict";

interface DiffSource {
  provider: ProviderId;
  path: string;
  body: string;
  bodyHash: string;
}

interface DiffGroup {
  key: string;
  kind: ResourceKind;
  tier: Tier;
  identityKey: string;
  status: DiffStatus;
  sources: DiffSource[];
}

function commandLogger(opts: DiffCmdOpts): Logger {
  return createLogger({
    mode: opts.json ? "json" : process.stdout.isTTY ? "tty" : "non-tty",
    debug: opts.debug ?? false,
    quiet: opts.quiet ?? false,
  });
}

function enabledRegistry(
  source: AdapterRegistry,
  enabledProviders: Set<ProviderId>,
  provider: ProviderId | undefined,
): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const adapter of source.all()) {
    if (!enabledProviders.has(adapter.id)) {
      continue;
    }

    if (provider && adapter.id !== provider) {
      continue;
    }

    registry.register(adapter);
  }

  return registry;
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

function parseResourceGroupKey(key: string): {
  kind: ResourceKind;
  tier: Tier;
  identityKey: string;
} {
  const [first, second, ...rest] = key.split("/");

  if (first === "skill" || first === "mcp") {
    return {
      kind: first,
      tier: "project",
      identityKey: rest.join("/") || second,
    };
  }

  return {
    kind: "memory",
    tier: first as Tier,
    identityKey: [second, ...rest].filter(Boolean).join("/"),
  };
}

async function readDocs(
  adapters: ProviderAdapter[],
  cwd: string,
  tierFilter: Tier[],
): Promise<MemoryDoc[]> {
  const docs: MemoryDoc[] = [];

  for (const adapter of adapters) {
    const detect = await adapter.detect(cwd);

    for (const tier of intersectTiers(detect.activeTiers, tierFilter)) {
      docs.push(...(await adapter.read(tier)));
    }
  }

  return docs;
}

async function readResourceDocs(
  adapters: ProviderAdapter[],
  kinds: ResourceKind[],
  scope: ResourceScope,
): Promise<ResourceDoc[]> {
  const docs: ResourceDoc[] = [];

  for (const adapter of adapters) {
    if (!adapter.readResources) {
      continue;
    }

    for (const kind of kinds.filter((item) => item !== "memory")) {
      docs.push(...(await adapter.readResources(kind, scope)));
    }
  }

  return docs;
}

function statusForSources(
  sources: DiffSource[],
  cache: Cache,
  key: string,
): DiffStatus {
  const hashes = [...new Set(sources.map((source) => source.bodyHash))];
  const cacheHash = cache.entries[key]?.bodyHash;

  if (hashes.length === 1) {
    return hashes[0] === cacheHash ? "identical" : "modified";
  }

  if (cacheHash && hashes.length === 2 && hashes.includes(cacheHash)) {
    return "modified";
  }

  return "conflict";
}

function buildGroups(
  docs: MemoryDoc[],
  cache: Cache,
  mappingOverrides?: Record<string, string[]>,
): DiffGroup[] {
  return [...groupBy(docs, (doc) => groupKeyForDoc(doc, mappingOverrides))]
    .map(([key, groupDocs]) => {
      const [tier, ...identityParts] = key.split("/");
      const sources = groupDocs
        .map((doc) => ({
          provider: doc.meta.source,
          path: doc.meta.sourcePath,
          body: doc.body,
          bodyHash: doc.meta.bodyHash,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));

      return {
        key,
        tier: tier as Tier,
        identityKey: identityParts.join("/"),
        status: statusForSources(sources, cache, key),
        kind: "memory" as const,
        sources,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function resourceBodyText(doc: ResourceDoc, showSecrets: boolean | undefined): string {
  if (doc.meta.sensitive && !showSecrets) {
    return `[${doc.kind} resource redacted; use --show-secrets to inspect raw values]`;
  }

  return `${JSON.stringify(doc.body, null, 2)}\n`;
}

function buildResourceGroups(
  docs: ResourceDoc[],
  cache: Cache,
  opts: Pick<DiffCmdOpts, "showSecrets">,
): DiffGroup[] {
  return [...groupBy(docs, resourceGroupKeyForDoc)]
    .map(([key, groupDocs]) => {
      const parsed = parseResourceGroupKey(key);
      const sources = groupDocs
        .map((doc) => ({
          provider: doc.meta.provider,
          path: doc.meta.sourcePath,
          body: resourceBodyText(doc, opts.showSecrets),
          bodyHash: doc.meta.bodyHash,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));

      return {
        key,
        kind: parsed.kind,
        tier: groupDocs[0]?.meta.tier ?? parsed.tier,
        identityKey: parsed.identityKey,
        status: statusForSources(sources, cache, key),
        sources,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function filteredGroups(groups: DiffGroup[], opts: DiffCmdOpts): DiffGroup[] {
  return groups.filter((group) => {
    if (
      opts.group &&
      group.key !== opts.group &&
      group.identityKey !== opts.group
    ) {
      return false;
    }

    return Boolean(opts.group) || opts.all || group.status !== "identical";
  });
}

function jsonGroup(group: DiffGroup): unknown {
  return {
    key: group.key,
    kind: group.kind,
    tier: group.tier,
    identityKey: group.identityKey,
    status: group.status,
    sources: group.sources.map((source) => ({
      provider: source.provider,
      path: source.path,
      bodyHash: source.bodyHash,
    })),
  };
}

function sourcePairForUnified(
  group: DiffGroup,
): [DiffSource, DiffSource] | null {
  for (let i = 0; i < group.sources.length; i += 1) {
    for (let j = i + 1; j < group.sources.length; j += 1) {
      const left = group.sources[i];
      const right = group.sources[j];

      if (left && right && left.body !== right.body) {
        return [left, right];
      }
    }
  }

  return null;
}

function writeUnified(group: DiffGroup): void {
  const pair = sourcePairForUnified(group);

  if (!pair) {
    return;
  }

  const [left, right] = pair;
  process.stdout.write(`--- ${left.provider} @ ${left.path}\n`);
  process.stdout.write(`+++ ${right.provider} @ ${right.path}\n`);
  process.stdout.write(`-${left.body}\n`);
  process.stdout.write(`+${right.body}\n`);
}

function writeGroups(groups: DiffGroup[], opts: DiffCmdOpts): void {
  if (opts.quiet) {
    return;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ groups: groups.map(jsonGroup) })}\n`,
    );
    return;
  }

  if (groups.length === 0) {
    process.stdout.write("No differences\n");
    return;
  }

  for (const group of groups) {
    process.stdout.write(`[${group.status}] ${group.key}\n`);

    for (const source of group.sources) {
      process.stdout.write(`✓ ${source.provider} @ ${source.path}\n`);
    }

    if (opts.unified) {
      writeUnified(group);
    }
  }
}

function exitCodeForError(error: unknown, logger: Logger): number {
  if (error instanceof MementoError) {
    logger.error(error.message);

    if (error.hint) {
      logger.error(`Hint: ${error.hint}`);
    }

    return error.exitCode;
  }

  if (error instanceof Error) {
    logger.error(error.message);
    return 1;
  }

  logger.error(String(error));
  return 1;
}

export async function runDiff(opts: DiffCmdOpts): Promise<number> {
  const logger = commandLogger(opts);

  try {
    const context = await resolveCliContext({
      cwd: process.cwd(),
      mode: opts.mode,
    });
    const config = await loadConfig(context.mementoDir);
    const cache = await loadCache(`${context.mementoDir}/cache.json`, logger);
    const enabledProviders = new Set(
      Object.entries(config.providers).flatMap(([id, provider]) =>
        provider.enabled ? [id as ProviderId] : [],
      ),
    );
    const registry = enabledRegistry(
      createCliRegistry(),
      enabledProviders,
      opts.provider,
    );
    const adapters = await registry.activeAdapters(context.root);
    const resourceKinds = parseResourceKinds({
      resources: opts.resources,
      noMcp: opts.mcp === false,
      noSkills: opts.skills === false,
    });
    const resourceScope = parseResourceScope(opts.scope);
    const tierFilter = resolveTierFilter({
      tier: context.mode === "global" ? undefined : opts.tier,
      includeGlobal: context.mode === "global" ? undefined : opts.includeGlobal,
      globalOnly: context.mode === "global",
    });
    const docs = resourceKinds.includes("memory")
      ? registry.dedupeSharedGlobal(
          await readDocs(adapters, context.root, tierFilter),
        )
      : [];
    const resourceDocs = await readResourceDocs(
      adapters,
      resourceKinds,
      resourceScope,
    );
    const groups = filteredGroups(
      [
        ...buildGroups(docs, cache, config.mapping),
        ...buildResourceGroups(resourceDocs, cache, opts),
      ].sort((a, b) => a.key.localeCompare(b.key)),
      opts,
    );

    writeGroups(groups, opts);
    return 0;
  } catch (error) {
    return exitCodeForError(error, logger);
  }
}
