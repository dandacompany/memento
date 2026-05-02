import path from "node:path";

import { loadConfig } from "../../core/config.js";
import { MementoError } from "../../core/errors.js";
import {
  assertImportSource,
  importProject,
  type ImportProjectReport,
  type ImportStrategy,
} from "../../core/import-project.js";
import { createLogger, type Logger } from "../../core/logger.js";
import {
  parseResourceKinds,
  parseResourceScope,
} from "../../core/resource-options.js";
import type { ProviderId, Tier } from "../../core/types.js";
import { resolveCliContext } from "../helpers/context.js";
import { createCliRegistry } from "../helpers/registry.js";

export interface ImportCmdOpts {
  from?: string;
  to?: string;
  resources?: string;
  scope?: string;
  strategy?: ImportStrategy;
  dryRun?: boolean;
  tier?: Tier;
  mcp?: boolean;
  skills?: boolean;
  yes?: boolean;
  json?: boolean;
  debug?: boolean;
}

const providerIds = new Set<ProviderId>([
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "windsurf",
]);

const strategies = new Set<ImportStrategy>([
  "prompt",
  "skip",
  "replace",
  "append",
]);

function commandLogger(debug: boolean | undefined): Logger {
  return createLogger({
    mode: process.stdout.isTTY ? "tty" : "non-tty",
    debug: debug ?? false,
  });
}

function parseProviderSelection(value: string | undefined): ProviderId[] | undefined {
  if (!value) {
    return undefined;
  }

  const providers = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const provider of providers) {
    if (!providerIds.has(provider as ProviderId)) {
      throw new MementoError("INVALID_PROVIDER", `Unknown provider: ${provider}`, {
        exitCode: 1,
      });
    }
  }

  return providers as ProviderId[];
}

function assertStrategy(value: ImportStrategy | undefined): void {
  if (value && !strategies.has(value)) {
    throw new MementoError("INVALID_STRATEGY", `Unknown import strategy: ${value}`, {
      exitCode: 1,
      hint: "Use one of: prompt, skip, replace, append.",
    });
  }
}

function resolveStrategy(opts: ImportCmdOpts): ImportStrategy {
  if (opts.yes) {
    return "replace";
  }

  return opts.strategy ?? "prompt";
}

function selectedTargetProviders(
  enabled: ProviderId[],
  requested: ProviderId[] | undefined,
): ProviderId[] {
  if (!requested) {
    return enabled;
  }

  const enabledSet = new Set(enabled);
  const disabled = requested.filter((provider) => !enabledSet.has(provider));

  if (disabled.length > 0) {
    throw new MementoError(
      "TARGET_PROVIDER_DISABLED",
      `Target provider is not enabled: ${disabled.join(", ")}`,
      {
        exitCode: 1,
        hint: "Enable it in .memento/config.toml or run memento init --providers.",
      },
    );
  }

  return requested;
}

function writtenCount(report: ImportProjectReport): number {
  return report.writes.reduce(
    (total, write) => total + write.written.length,
    0,
  );
}

function printReport(report: ImportProjectReport, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  if (process.stdout.isTTY) {
    const backup = report.backupSaved ? " / 💾 backup saved" : "";
    process.stdout.write(
      `✓ ${report.groupsImported} imported / ⚠ ${report.groupsSkipped} skipped / ✗ ${report.groupsFailed} failed${backup}\n`,
    );
    return;
  }

  process.stdout.write(
    [
      "imported",
      String(report.groupsImported),
      "skipped",
      String(report.groupsSkipped),
      "failed",
      String(report.groupsFailed),
      "written",
      String(writtenCount(report)),
    ].join("\t") + "\n",
  );
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

export async function runImport(
  source: string,
  opts: ImportCmdOpts,
): Promise<number> {
  const logger = commandLogger(opts.debug);

  try {
    assertStrategy(opts.strategy);
    const sourceRoot = path.resolve(source);

    await assertImportSource(sourceRoot);

    const context = await resolveCliContext({
      cwd: process.cwd(),
      mode: "project",
    });
    const config = await loadConfig(context.mementoDir);
    const enabledProviders = Object.entries(config.providers).flatMap(
      ([provider, providerConfig]) =>
        providerConfig.enabled ? [provider as ProviderId] : [],
    );
    const targetProviders = selectedTargetProviders(
      enabledProviders,
      parseProviderSelection(opts.to),
    );
    const resourceKinds = opts.resources
      ? parseResourceKinds({
          resources: opts.resources,
          noMcp: opts.mcp === false,
          noSkills: opts.skills === false,
        })
      : ["memory" as const];
    const report = await importProject({
      sourceRoot,
      targetRoot: context.root,
      mementoDir: context.mementoDir,
      sourceRegistry: createCliRegistry(sourceRoot),
      targetRegistry: createCliRegistry(context.root),
      sourceProviders: parseProviderSelection(opts.from),
      targetProviders,
      resourceKinds,
      resourceScope: parseResourceScope(opts.scope),
      tiers: opts.tier ? [opts.tier] : undefined,
      strategy: resolveStrategy(opts),
      dryRun: opts.dryRun,
      isTTY: process.stdout.isTTY,
      logger,
    });

    printReport(report, opts.json);
    return 0;
  } catch (error) {
    return exitCodeForError(error, logger);
  }
}
