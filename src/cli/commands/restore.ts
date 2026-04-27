import { confirm } from "@inquirer/prompts";

import {
  listBackups,
  pruneOldBackups,
  restoreBackup,
  type BackupHandle,
} from "../../core/backup.js";
import { MementoError } from "../../core/errors.js";
import { createLogger, type Logger } from "../../core/logger.js";
import { resolveCliContext } from "../helpers/context.js";

export interface RestoreCmdOpts {
  list?: boolean;
  at?: string;
  group?: string;
  prune?: number;
  json?: boolean;
  debug?: boolean;
  quiet?: boolean;
  mode?: "project" | "global";
  root?: string;
  mementoDir?: string;
}

interface BackupSummary {
  timestamp: string;
  dir: string;
  entries: number;
  firstGroupKey: string | null;
  groupKeys: string[];
}

function commandLogger(opts: RestoreCmdOpts): Logger {
  return createLogger({
    mode: opts.json ? "json" : process.stdout.isTTY ? "tty" : "non-tty",
    debug: opts.debug ?? false,
    quiet: opts.quiet ?? false,
  });
}

function uniqueGroupKeys(handle: BackupHandle): string[] {
  return [...new Set(handle.entries.map((entry) => entry.groupKey))];
}

function backupSummary(handle: BackupHandle): BackupSummary {
  const groupKeys = uniqueGroupKeys(handle);

  return {
    timestamp: handle.timestamp,
    dir: handle.dir,
    entries: handle.entries.length,
    firstGroupKey: groupKeys[0] ?? null,
    groupKeys,
  };
}

function formatBackupLine(handle: BackupHandle): string {
  const [firstGroupKey] = uniqueGroupKeys(handle);
  const groupHint = firstGroupKey
    ? `${firstGroupKey}${handle.entries.length > 1 ? "..." : ""}`
    : "-";

  return `${handle.timestamp}  ${handle.entries.length} entries  ${groupHint}`;
}

function writeList(backups: BackupHandle[], opts: RestoreCmdOpts): void {
  if (opts.quiet) {
    return;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ backups: backups.map(backupSummary) })}\n`,
    );
    return;
  }

  for (const backup of backups) {
    process.stdout.write(`${formatBackupLine(backup)}\n`);
  }
}

function findBackup(backups: BackupHandle[], timestamp: string): BackupHandle {
  const handle =
    backups.find((backup) => backup.timestamp === timestamp) ??
    backups.find((backup) => backup.timestamp.startsWith(timestamp));

  if (!handle) {
    throw new MementoError(
      "BACKUP_NOT_FOUND",
      `No backup found for timestamp: ${timestamp}`,
      {
        exitCode: 1,
        hint: "Run `memento restore --list` first.",
      },
    );
  }

  return handle;
}

async function confirmRestore(
  handle: BackupHandle,
  opts: RestoreCmdOpts,
): Promise<boolean> {
  if (opts.quiet || !process.stdout.isTTY) {
    return true;
  }

  return confirm({
    message: `Restore ${handle.entries.length} entries from ${handle.timestamp}?`,
    default: false,
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

export async function runRestore(opts: RestoreCmdOpts): Promise<number> {
  const logger = commandLogger(opts);

  try {
    const context =
      opts.root && opts.mementoDir
        ? {
            mode: opts.mode ?? "project",
            root: opts.root,
            mementoDir: opts.mementoDir,
          }
        : await resolveCliContext({
            cwd: process.cwd(),
            mode: opts.mode,
          });

    if (opts.list || (!opts.at && opts.prune === undefined)) {
      writeList(await listBackups(context.mementoDir), opts);
      return 0;
    }

    if (opts.prune !== undefined) {
      const result = await pruneOldBackups(context.mementoDir, opts.prune);

      if (!opts.quiet) {
        process.stdout.write(
          `Removed ${result.removed.length} backups, kept ${opts.prune}\n`,
        );
      }

      return 0;
    }

    const timestamp = opts.at;

    if (!timestamp) {
      writeList(await listBackups(context.mementoDir), opts);
      return 0;
    }

    const backups = await listBackups(context.mementoDir);
    const handle = findBackup(backups, timestamp);
    const proceed = await confirmRestore(handle, opts);

    if (!proceed) {
      if (!opts.quiet) {
        process.stdout.write("Restore cancelled\n");
      }

      return 0;
    }

    const result = await restoreBackup(handle, { groupKey: opts.group });

    if (!opts.quiet) {
      process.stdout.write(
        `Restored ${result.restored.length} entries, skipped ${result.skipped.length}\n`,
      );
    }

    return 0;
  } catch (error) {
    return exitCodeForError(error, logger);
  }
}
