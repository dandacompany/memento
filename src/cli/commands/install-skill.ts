import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MementoError } from "../../core/errors.js";
import { installSkill } from "../../install/skill-installer.js";
import { commandHeader } from "../art.js";
import { loggerFromOpts } from "../helpers/logger.js";

export interface InstallSkillOpts {
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  quiet?: boolean;
}

export async function runInstallSkill(opts: InstallSkillOpts): Promise<number> {
  const logger = loggerFromOpts({
    debug: opts.debug,
    quiet: opts.quiet,
  });
  const skillsRoot = path.join(os.homedir(), ".claude", "skills");

  if (!opts.quiet) {
    process.stdout.write(commandHeader("Installing Claude Code skill"));
  }

  if (!(await isDirectory(skillsRoot))) {
    throw new MementoError(
      "CLAUDE_SKILLS_DIR_MISSING",
      "Claude Code skills directory not found.",
      {
        exitCode: 1,
        hint: "Install Claude Code first, then run `memento install-skill`.",
      },
    );
  }

  const result = await installSkill({
    source: skillSourceDir(),
    dest: path.join(skillsRoot, "memento"),
    force: opts.force,
    dryRun: opts.dryRun,
  });

  const prefix = opts.dryRun ? "[dry-run] " : "";

  if (result.mode === "unchanged") {
    logger.info(`${prefix}memento Claude Code skill is already up to date.`);
    return 0;
  }

  if (result.mode === "created") {
    logger.success(
      `${prefix}Installed memento Claude Code skill (${result.copied.length} files copied).`,
    );
    return 0;
  }

  if (result.mode === "updated") {
    logger.success(
      `${prefix}Updated memento Claude Code skill (${result.copied.length} files copied).`,
    );

    if (result.backupDir) {
      logger.info(`${prefix}Backup: ${result.backupDir}`);
    }

    return 0;
  }

  logger.warn(`${prefix}Skipped memento Claude Code skill install.`);

  if (result.reason) {
    logger.warn(result.reason);
  }

  return 0;
}

function skillSourceDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "skill",
  );
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
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
