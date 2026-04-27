import path from "node:path";

import { AdapterRegistry } from "../../adapters/registry.js";
import type { ProviderAdapter } from "../../adapters/types.js";
import { loadCache } from "../../core/cache.js";
import { loadConfig } from "../../core/config.js";
import { ConflictError, MementoError } from "../../core/errors.js";
import { createLogger, type Logger } from "../../core/logger.js";
import { sync, type SyncOpts, type SyncReport } from "../../core/sync.js";
import type { ProviderId, ResolveStrategy, Tier } from "../../core/types.js";
import { conflictPromptUser } from "../../prompts/conflict.js";
import { resolveCliContext } from "../helpers/context.js";
import { createCliRegistry } from "../helpers/registry.js";

export interface SyncCmdOpts {
  dryRun?: boolean;
  strategy?: ResolveStrategy;
  tier?: Tier;
  provider?: ProviderId;
  yes?: boolean;
  includeGlobal?: boolean;
  json?: boolean;
  debug?: boolean;
  mode?: "project" | "global";
}

interface StrategyResolution {
  strategy: ResolveStrategy;
  promptUser?: typeof conflictPromptUser;
}

const providerIds = new Set<ProviderId>([
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "windsurf",
]);

const tiers = new Set<Tier>(["project", "project-local", "global"]);
const strategies = new Set<ResolveStrategy>(["lww", "prompt", "fail"]);

function commandLogger(debug: boolean | undefined): Logger {
  return createLogger({
    mode: process.stdout.isTTY ? "tty" : "non-tty",
    debug: debug ?? false,
  });
}

function assertProvider(value: ProviderId | undefined): void {
  if (value && !providerIds.has(value)) {
    throw new MementoError("INVALID_PROVIDER", `Unknown provider: ${value}`, {
      exitCode: 1,
    });
  }
}

function assertTier(value: Tier | undefined): void {
  if (value && !tiers.has(value)) {
    throw new MementoError("INVALID_TIER", `Unknown tier: ${value}`, {
      exitCode: 1,
    });
  }
}

function assertStrategy(value: ResolveStrategy | undefined): void {
  if (value && !strategies.has(value)) {
    throw new MementoError("INVALID_STRATEGY", `Unknown strategy: ${value}`, {
      exitCode: 1,
      hint: "Use one of: lww, prompt, fail.",
    });
  }
}

function filteredRegistry(
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

async function activeAdaptersOrThrow(
  registry: AdapterRegistry,
  cwd: string,
): Promise<ProviderAdapter[]> {
  const active = await registry.activeAdapters(cwd);

  if (active.length === 0) {
    throw new MementoError("NO_ACTIVE_PROVIDERS", "No active providers.", {
      exitCode: 4,
      hint: "Enable a provider in .memento/config.toml or run memento init.",
    });
  }

  return active;
}

function resolveStrategy(
  opts: SyncCmdOpts,
  isTTY: boolean,
  logger: Logger,
): StrategyResolution {
  if (opts.yes) {
    return { strategy: "lww" };
  }

  const requested = opts.strategy ?? "lww";

  if (requested !== "prompt") {
    return { strategy: requested };
  }

  if (!isTTY) {
    logger.warn(
      "--strategy prompt requires a TTY; falling back to --strategy lww.",
    );
    return { strategy: "lww" };
  }

  return { strategy: "prompt", promptUser: conflictPromptUser };
}

function writtenCount(report: SyncReport): number {
  return report.writes.reduce(
    (total, write) => total + write.written.length,
    0,
  );
}

function syncedCount(report: SyncReport): number {
  return report.groupsPropagated + report.groupsConflictResolved;
}

function printJson(report: SyncReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function printTty(report: SyncReport): void {
  const backupSaved = !report.dryRun && writtenCount(report) > 0;
  const backup = backupSaved ? " / 💾 backup saved" : "";

  process.stdout.write(
    `✓ ${syncedCount(report)} synced / ⚠ ${report.groupsSkipped} skipped / ✗ ${report.groupsFailed} failed${backup}\n`,
  );
}

function printNonTty(report: SyncReport): void {
  const backupSaved = !report.dryRun && writtenCount(report) > 0;

  process.stdout.write(
    [
      "synced",
      String(syncedCount(report)),
      "skipped",
      String(report.groupsSkipped),
      "failed",
      String(report.groupsFailed),
      "backup",
      String(backupSaved),
    ].join("\t") + "\n",
  );
}

function printReport(report: SyncReport, json: boolean | undefined): void {
  if (json) {
    printJson(report);
    return;
  }

  if (process.stdout.isTTY) {
    printTty(report);
    return;
  }

  printNonTty(report);
}

function exitCodeForError(error: unknown, logger: Logger): number {
  if (error instanceof ConflictError) {
    logger.error(error.message);
    return 2;
  }

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

export async function runSync(opts: SyncCmdOpts): Promise<number> {
  const logger = commandLogger(opts.debug);

  try {
    assertProvider(opts.provider);
    assertTier(opts.tier);
    assertStrategy(opts.strategy);

    const context = await resolveCliContext({
      cwd: process.cwd(),
      mode: opts.mode,
    });
    const config = await loadConfig(context.mementoDir);
    const enabledProviders = new Set(
      Object.entries(config.providers).flatMap(([id, provider]) =>
        provider.enabled ? [id as ProviderId] : [],
      ),
    );
    const registry = filteredRegistry(
      createCliRegistry(),
      enabledProviders,
      opts.provider,
    );

    await activeAdaptersOrThrow(registry, context.root);

    const cache = await loadCache(
      path.join(context.mementoDir, "cache.json"),
      logger,
    );
    const strategy = resolveStrategy(opts, process.stdout.isTTY, logger);
    const syncOpts: SyncOpts = {
      cwd: context.root,
      mementoDir: context.mementoDir,
      registry,
      cache,
      strategy: strategy.strategy,
      isTTY: process.stdout.isTTY,
      dryRun: opts.dryRun,
      tier: context.mode === "global" ? undefined : opts.tier,
      includeGlobal: context.mode === "global" ? undefined : opts.includeGlobal,
      globalOnly: context.mode === "global",
      provider: opts.provider,
      promptUser: strategy.promptUser,
      mappingOverrides: config.mapping,
      excludePaths: config.exclude?.paths,
      logger,
    };
    const report = await sync(syncOpts);

    printReport(report, opts.json);
    return 0;
  } catch (error) {
    return exitCodeForError(error, logger);
  }
}
