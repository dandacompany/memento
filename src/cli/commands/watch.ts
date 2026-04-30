import path from "node:path";

import chokidar from "chokidar";

import { AdapterRegistry } from "../../adapters/registry.js";
import type { ProviderAdapter } from "../../adapters/types.js";
import { loadCache, type Cache } from "../../core/cache.js";
import { loadConfig } from "../../core/config.js";
import { MementoError } from "../../core/errors.js";
import { createLogger, type Logger } from "../../core/logger.js";
import { resolveTierFilter, sync, type SyncReport } from "../../core/sync.js";
import type { ProviderId, Tier } from "../../core/types.js";
import { resolveCliContext } from "../helpers/context.js";
import { createCliRegistry } from "../helpers/registry.js";

export interface WatchCmdOpts {
  debounce?: number;
  tier?: Tier;
  provider?: ProviderId;
  includeGlobal?: boolean;
  json?: boolean;
  debug?: boolean;
  quiet?: boolean;
  mode?: "project" | "global";
}

interface WatchContext {
  cwd: string;
  mementoDir: string;
  registry: AdapterRegistry;
  adapters: ProviderAdapter[];
  paths: string[];
  fileCount: number;
  cache: Cache;
  mappingOverrides?: Record<string, string[]>;
  excludePaths?: string[];
  globalOnly: boolean;
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

function commandLogger(opts: WatchCmdOpts): Logger {
  return createLogger({
    mode: opts.json ? "json" : process.stdout.isTTY ? "tty" : "non-tty",
    debug: opts.debug ?? false,
    quiet: opts.quiet ?? false,
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

function parseDebounce(value: number | undefined): number {
  if (value === undefined) {
    return 500;
  }

  const parsed = value;

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MementoError(
      "INVALID_DEBOUNCE",
      `Invalid debounce interval: ${String(value)}`,
      { exitCode: 1 },
    );
  }

  return parsed;
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((filePath) => path.resolve(filePath)))].sort();
}

function watchedPathsFor(
  adapters: ProviderAdapter[],
  cwd: string,
  tiersToWatch: Tier[],
): { paths: string[]; fileCount: number } {
  const filePaths: string[] = [];

  for (const adapter of adapters) {
    const adapterPaths = adapter.paths(cwd);

    for (const tier of tiersToWatch) {
      filePaths.push(...adapterPaths[tier]);
    }
  }

  const watchedFiles = uniquePaths(filePaths);
  const watchedDirs = uniquePaths(
    watchedFiles.map((filePath) => path.dirname(filePath)),
  );

  return {
    paths: uniquePaths([...watchedFiles, ...watchedDirs]),
    fileCount: watchedFiles.length,
  };
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(directory);

  return (
    resolvedPath === resolvedDir ||
    resolvedPath.startsWith(`${resolvedDir}${path.sep}`)
  );
}

function writtenCount(report: SyncReport): number {
  return report.writes.reduce(
    (total, write) => total + write.written.length,
    0,
  );
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function printLine(message: string, quiet: boolean | undefined): void {
  if (quiet) {
    return;
  }

  process.stdout.write(`${message}\n`);
}

async function prepareWatch(opts: WatchCmdOpts): Promise<WatchContext> {
  assertProvider(opts.provider);
  assertTier(opts.tier);

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
  const adapters = await registry.activeAdapters(context.root);

  if (adapters.length === 0) {
    throw new MementoError("NO_ACTIVE_PROVIDERS", "No active providers.", {
      exitCode: 4,
      hint: "Enable a provider in .memento/config.toml or run memento init.",
    });
  }

  const globalOnly = context.mode === "global";
  const tiersToWatch = resolveTierFilter({
    tier: globalOnly ? undefined : opts.tier,
    includeGlobal: globalOnly ? undefined : opts.includeGlobal,
    globalOnly,
  });
  const watched = watchedPathsFor(adapters, context.root, tiersToWatch);

  return {
    cwd: context.root,
    mementoDir: context.mementoDir,
    registry,
    adapters,
    paths: watched.paths,
    fileCount: watched.fileCount,
    cache: await loadCache(path.join(context.mementoDir, "cache.json")),
    mappingOverrides: config.mapping,
    excludePaths: config.exclude?.paths,
    globalOnly,
  };
}

async function runSyncQuietly(
  watchContext: WatchContext,
  opts: WatchCmdOpts,
  logger: Logger,
): Promise<SyncReport> {
  return sync({
    cwd: watchContext.cwd,
    mementoDir: watchContext.mementoDir,
    registry: watchContext.registry,
    cache: watchContext.cache,
    strategy: "lww",
    isTTY: false,
    dryRun: false,
    tier: watchContext.globalOnly ? undefined : opts.tier,
    includeGlobal: watchContext.globalOnly ? undefined : opts.includeGlobal,
    globalOnly: watchContext.globalOnly,
    provider: opts.provider,
    mappingOverrides: watchContext.mappingOverrides,
    excludePaths: watchContext.excludePaths,
    logger,
  });
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

export async function runWatch(opts: WatchCmdOpts): Promise<number> {
  const logger = commandLogger(opts);

  try {
    const debounceMs = parseDebounce(opts.debounce);
    const watchContext = await prepareWatch(opts);
    let changedFiles = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    let running: Promise<void> | null = null;
    let closed = false;

    const watcherOptions = {
      persistent: true,
      ignoreInitial: true,
      ignored: (filePath: string) =>
        isInsideDirectory(filePath, watchContext.mementoDir),
      awaitWriteFinish: { stabilityThreshold: 200 },
      usePolling: process.platform === "win32",
    };
    const watcher = chokidar.watch(watchContext.paths, watcherOptions);

    const scheduleFlush = (): void => {
      if (closed) {
        return;
      }

      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    };

    const flush = async (): Promise<void> => {
      if (closed || running || changedFiles.size === 0) {
        return;
      }

      const fileCount = changedFiles.size;
      changedFiles = new Set<string>();
      running = (async () => {
        try {
          const report = await runSyncQuietly(watchContext, opts, logger);
          printLine(
            `[${timestamp()}] ${fileCount} files changed → synced (${writtenCount(report)} writes, ${report.groupsConflictResolved} conflicts auto-resolved)`,
            opts.quiet,
          );
        } catch (error) {
          logger.error(error instanceof Error ? error.message : String(error));
        } finally {
          running = null;

          if (changedFiles.size > 0) {
            scheduleFlush();
          }
        }
      })();

      await running;
    };

    watcher.on("all", (_event, filePath) => {
      if (
        typeof filePath === "string" &&
        isInsideDirectory(filePath, watchContext.mementoDir)
      ) {
        return;
      }

      changedFiles.add(
        typeof filePath === "string" ? path.resolve(filePath) : "<unknown>",
      );
      scheduleFlush();
    });
    watcher.on("error", (error) => {
      logger.error(error instanceof Error ? error.message : String(error));
    });

    printLine(
      `Watching ${watchContext.fileCount} files across ${watchContext.adapters.length} providers... (Ctrl+C to stop)`,
      opts.quiet,
    );

    return await new Promise<number>((resolve) => {
      const shutdown = (): void => {
        void (async () => {
          closed = true;

          if (timer) {
            clearTimeout(timer);
            timer = null;
          }

          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          await watcher.close();
          await running;
          resolve(0);
        })();
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (error) {
    return exitCodeForError(error, logger);
  }
}
