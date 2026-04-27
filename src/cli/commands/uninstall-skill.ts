import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { uninstallSkill } from "../../install/skill-installer.js";
import { loggerFromOpts } from "../helpers/logger.js";

export interface UninstallSkillOpts {
  dryRun?: boolean;
  debug?: boolean;
  quiet?: boolean;
}

export async function runUninstallSkill(
  opts: UninstallSkillOpts,
): Promise<number> {
  const logger = loggerFromOpts({
    debug: opts.debug,
    quiet: opts.quiet,
  });
  const dest = path.join(os.homedir(), ".claude", "skills", "memento");
  const existed = await pathExists(dest);
  const result = await uninstallSkill({ dest, dryRun: opts.dryRun });
  const prefix = opts.dryRun ? "[dry-run] " : "";

  if (result.removed.length > 0) {
    logger.success(
      `${prefix}Uninstalled memento Claude Code skill (${result.removed.length} files removed).`,
    );
    return 0;
  }

  if (!existed) {
    logger.info(`${prefix}memento skill not installed.`);
    return 0;
  }

  if (result.skipped.includes(dest)) {
    logger.warn(
      `${prefix}Refused to uninstall ${dest} because it is not the memento skill.`,
    );
    return 0;
  }

  logger.info(`${prefix}memento skill not installed.`);
  return 0;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
