#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { MementoError } from "../core/errors.js";
import { runDiff, type DiffCmdOpts } from "./commands/diff.js";
import {
  runGlobalDiff,
  runGlobalInit,
  runGlobalRestore,
  runGlobalStatus,
  runGlobalSync,
  runGlobalWatch,
} from "./commands/global.js";
import { parseProviderList, runInit } from "./commands/init.js";
import { runInstallSkill } from "./commands/install-skill.js";
import { runRestore, type RestoreCmdOpts } from "./commands/restore.js";
import { parseStatusTier, runStatus } from "./commands/status.js";
import { runSync, type SyncCmdOpts } from "./commands/sync.js";
import { runUninstallSkill } from "./commands/uninstall-skill.js";
import { runUpdate } from "./commands/update.js";
import { runWatch, type WatchCmdOpts } from "./commands/watch.js";
import { commandHeader, mementoBanner } from "./art.js";
import { handleCliError } from "./helpers/errors.js";
import { loggerFromOpts } from "./helpers/logger.js";
import { createCliRegistry } from "./helpers/registry.js";

interface GlobalOptions {
  debug?: boolean;
  json?: boolean;
  quiet?: boolean;
}

const notImplementedHint = "This command is implemented in Wave 5b";

function packageVersion(): string {
  const packageJsonPath = fileURLToPath(
    new URL("../../package.json", import.meta.url),
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };

  return packageJson.version ?? "0.0.0";
}

export function stubCommand(): never {
  throw new MementoError("NOT_IMPLEMENTED", "NOT_IMPLEMENTED", {
    exitCode: 1,
    hint: notImplementedHint,
  });
}

function addInitCommand(parent: Command, implemented = false): void {
  const command = parent
    .command("init")
    .description("Initialize memento in the current context")
    .option("--force", "Overwrite existing memento files")
    .option("--providers <list>", "Comma-separated providers to enable");

  if (!implemented) {
    command.action(stubCommand);
    return;
  }

  command.action(async (opts: { force?: boolean; providers?: string }) => {
    const parentOpts = rootOptions(parent);
    const exitCode = await runInit({
      force: opts.force,
      providers: opts.providers ? parseProviderList(opts.providers) : undefined,
      json: parentOpts.json,
      debug: parentOpts.debug,
      quiet: parentOpts.quiet,
    });

    process.exitCode = exitCode;
  });
}

function addStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Show memento sync status")
    .option("--tier <tier>", "Filter by memory tier")
    .option("--include-global", "Include global memory status")
    .option("--json", "Emit JSON")
    .action(
      async (opts: {
        tier?: string;
        includeGlobal?: boolean;
        json?: boolean;
      }) => {
        const parentOpts = rootOptions(parent);
        const exitCode = await runStatus({
          tier: parseStatusTier(opts.tier),
          includeGlobal: opts.includeGlobal,
          json: opts.json ?? parentOpts.json,
          debug: parentOpts.debug,
        });

        process.exitCode = exitCode;
      },
    );
}

function rootOptions(command: Command): GlobalOptions {
  let current: Command | null = command;

  while (current.parent) {
    current = current.parent;
  }

  return current.opts<GlobalOptions>();
}

function addSyncCommand(parent: Command): void {
  parent
    .command("sync")
    .description("Synchronize memory across providers")
    .option("--dry-run", "Preview changes without writing")
    .option("--strategy <strategy>", "Conflict strategy: lww, prompt, or fail")
    .option("--tier <tier>", "Filter by memory tier")
    .option("--provider <id>", "Filter by provider id")
    .option("--yes", "Accept non-interactive defaults")
    .option("--include-global", "Include global memory")
    .action(async (opts: SyncCmdOpts) => {
      const parentOpts = rootOptions(parent);
      const exitCode = await runSync({
        ...opts,
        json: parentOpts.json,
        debug: parentOpts.debug,
        mode: parent.name() === "global" ? "global" : "project",
      });

      process.exitCode = exitCode;
    });
}

function addWatchCommand(parent: Command): void {
  parent
    .command("watch")
    .description("Watch memory files and synchronize on changes")
    .option("--debounce <ms>", "Debounce interval in milliseconds")
    .option("--tier <tier>", "Filter by memory tier")
    .option("--provider <id>", "Filter by provider id")
    .option("--include-global", "Include global memory")
    .action(
      async (opts: Omit<WatchCmdOpts, "debounce"> & { debounce?: string }) => {
        const parentOpts = rootOptions(parent);
        const exitCode = await runWatch({
          ...opts,
          debounce:
            opts.debounce === undefined ? undefined : Number(opts.debounce),
          debug: parentOpts.debug,
          quiet: parentOpts.quiet,
        });

        process.exitCode = exitCode;
      },
    );
}

function addDiffCommand(parent: Command): void {
  parent
    .command("diff")
    .description("Show unresolved memory differences")
    .option("--group <key>", "Show a specific conflict group")
    .option("--all", "Show all diff groups")
    .option("--unified", "Use unified diff output")
    .option("--tier <tier>", "Filter by memory tier")
    .option("--provider <id>", "Filter by provider id")
    .option("--include-global", "Include global memory")
    .option("--json", "Emit JSON")
    .action(async (opts: Omit<DiffCmdOpts, "tier"> & { tier?: string }) => {
      const parentOpts = rootOptions(parent);
      const exitCode = await runDiff({
        ...opts,
        tier: parseStatusTier(opts.tier),
        json: opts.json ?? parentOpts.json,
        debug: parentOpts.debug,
        quiet: parentOpts.quiet,
      });

      process.exitCode = exitCode;
    });
}

function addRestoreCommand(parent: Command): void {
  parent
    .command("restore")
    .description("Restore memory from backups")
    .option("--list", "List available restore points")
    .option("--at <timestamp>", "Restore from a timestamp")
    .option("--group <key>", "Restore a specific group")
    .option("--prune <count>", "Keep the newest N backups", parsePruneCount)
    .action(async (opts: RestoreCmdOpts) => {
      const parentOpts = rootOptions(parent);
      const exitCode = await runRestore({
        ...opts,
        json: parentOpts.json,
        debug: parentOpts.debug,
        quiet: parentOpts.quiet,
      });

      process.exitCode = exitCode;
    });
}

function parsePruneCount(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MementoError("INVALID_PRUNE", `Invalid prune count: ${value}`, {
      exitCode: 1,
      hint: "Use a non-negative integer.",
    });
  }

  return parsed;
}

function addSkillCommands(parent: Command): void {
  parent
    .command("install-skill")
    .description("Install the Claude Code memento skill")
    .option("--force", "Overwrite an existing skill install")
    .option("--dry-run", "Preview install actions without writing")
    .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
      const parentOpts = rootOptions(parent);
      const exitCode = await runInstallSkill({
        force: opts.force,
        dryRun: opts.dryRun,
        debug: parentOpts.debug,
        quiet: parentOpts.quiet,
      });

      process.exitCode = exitCode;
    });

  parent
    .command("uninstall-skill")
    .description("Uninstall the Claude Code memento skill")
    .option("--dry-run", "Preview uninstall actions without writing")
    .action(async (opts: { dryRun?: boolean }) => {
      const parentOpts = rootOptions(parent);
      const exitCode = await runUninstallSkill({
        dryRun: opts.dryRun,
        debug: parentOpts.debug,
        quiet: parentOpts.quiet,
      });

      process.exitCode = exitCode;
    });
}

function addUpdateCommand(parent: Command): void {
  parent
    .command("update")
    .description("Update the global memento CLI install")
    .option("--dry-run", "Print the update command without running it")
    .action(async (opts: { dryRun?: boolean }) => {
      const parentOpts = rootOptions(parent);
      const exitCode = await runUpdate({
        dryRun: opts.dryRun,
        quiet: parentOpts.quiet,
      });

      process.exitCode = exitCode;
    });
}

function addProjectCommands(parent: Command, implementInit = false): void {
  addInitCommand(parent, implementInit);
  addStatusCommand(parent);
  addSyncCommand(parent);
  addWatchCommand(parent);
  addDiffCommand(parent);
  addRestoreCommand(parent);
}

function addGlobalCommands(parent: Command): void {
  const global = parent
    .command("global")
    .description("Manage the global memento context");

  global
    .command("init")
    .description("Initialize memento in the global context")
    .option("--force", "Overwrite existing memento files")
    .option("--providers <list>", "Comma-separated providers to enable")
    .action(async (opts: { force?: boolean; providers?: string }) => {
      const parentOpts = rootOptions(global);
      const exitCode = await runGlobalInit({
        force: opts.force,
        providers: opts.providers
          ? parseProviderList(opts.providers)
          : undefined,
        json: parentOpts.json,
        debug: parentOpts.debug,
        quiet: parentOpts.quiet,
      });

      process.exitCode = exitCode;
    });

  global
    .command("status")
    .description("Show global memento sync status")
    .option("--tier <tier>", "Ignored for global status")
    .option("--include-global", "Ignored for global status")
    .option("--json", "Emit JSON")
    .action(async (opts: { json?: boolean }) => {
      const parentOpts = rootOptions(global);
      const exitCode = await runGlobalStatus({
        json: opts.json ?? parentOpts.json,
        debug: parentOpts.debug,
      });

      process.exitCode = exitCode;
    });

  global
    .command("sync")
    .description("Synchronize global memory across providers")
    .option("--dry-run", "Preview changes without writing")
    .option("--strategy <strategy>", "Conflict strategy: lww, prompt, or fail")
    .option("--tier <tier>", "Ignored for global sync")
    .option("--provider <id>", "Filter by provider id")
    .option("--yes", "Accept non-interactive defaults")
    .option("--include-global", "Ignored for global sync")
    .action(async (opts: SyncCmdOpts) => {
      const parentOpts = rootOptions(global);
      const exitCode = await runGlobalSync({
        ...opts,
        json: parentOpts.json,
        debug: parentOpts.debug,
      });

      process.exitCode = exitCode;
    });

  global
    .command("watch")
    .description("Watch memory files in the global context")
    .option("--debounce <ms>", "Debounce interval in milliseconds")
    .option("--tier <tier>", "Ignored for global watch")
    .option("--include-global", "Ignored for global watch")
    .action(async (opts: { debounce?: string }) => {
      const parentOpts = rootOptions(global);
      const exitCode = await runGlobalWatch({
        debounce:
          opts.debounce === undefined ? undefined : Number(opts.debounce),
        json: parentOpts.json,
        debug: parentOpts.debug,
      });

      process.exitCode = exitCode;
    });

  global
    .command("diff")
    .description("Show unresolved global memory differences")
    .option("--group <key>", "Show a specific conflict group")
    .option("--all", "Show all diff groups")
    .option("--unified", "Use unified diff output")
    .option("--tier <tier>", "Ignored for global diff")
    .option("--include-global", "Ignored for global diff")
    .option("--json", "Emit JSON")
    .action(
      async (opts: {
        group?: string;
        all?: boolean;
        unified?: boolean;
        json?: boolean;
      }) => {
        const parentOpts = rootOptions(global);
        const exitCode = await runGlobalDiff({
          group: opts.group,
          all: opts.all,
          unified: opts.unified,
          json: opts.json ?? parentOpts.json,
          debug: parentOpts.debug,
        });

        process.exitCode = exitCode;
      },
    );

  global
    .command("restore")
    .description("Restore memory from backups in the global context")
    .option("--list", "List available restore points")
    .option("--at <timestamp>", "Restore from a timestamp")
    .option("--group <key>", "Restore a specific group")
    .option("--prune <count>", "Keep the newest N backups", parsePruneCount)
    .action(async (opts: RestoreCmdOpts) => {
      const parentOpts = rootOptions(global);
      const exitCode = await runGlobalRestore({
        ...opts,
        json: parentOpts.json,
        debug: parentOpts.debug,
      });

      process.exitCode = exitCode;
    });
}

export function createProgram(): Command {
  createCliRegistry();

  const program = new Command();
  program
    .name("memento")
    .description("Bi-directional code-assistant memory sync")
    .option("--debug", "Print debug output and stack traces")
    .option("--json", "Emit JSON lines")
    .option("--quiet", "Suppress non-error output");

  addProjectCommands(program, true);
  addGlobalCommands(program);
  addUpdateCommand(program);
  addSkillCommands(program);

  program.addHelpText(
    "beforeAll",
    () => `${commandHeader("AI memory sync CLI", packageVersion())}\n`,
  );

  program.version(
    `${mementoBanner({
      caption: "Version",
      version: packageVersion(),
    })}\n${packageVersion()}`,
    "-v, --version",
    "Print the memento version",
  );

  return program;
}

export async function runCli(argv = process.argv): Promise<number> {
  const program = createProgram();

  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    const opts = program.opts<GlobalOptions>();
    const logger = loggerFromOpts(opts);
    const exitCode = handleCliError(error, logger, opts.debug ?? false);
    process.exitCode = exitCode;
    return exitCode;
  }
}

const currentFile = fileURLToPath(import.meta.url);

function isCliEntryPoint(): boolean {
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

  if (!entryFile) {
    return false;
  }

  try {
    return realpathSync(entryFile) === currentFile;
  } catch {
    return entryFile === currentFile;
  }
}

if (isCliEntryPoint()) {
  await runCli();
}
