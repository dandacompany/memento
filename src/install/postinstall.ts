import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandHeader } from "../cli/art.js";
import { installSkill } from "./skill-installer.js";

interface PostinstallDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  installSkillImpl?: typeof installSkill;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export async function runPostinstall(
  deps: PostinstallDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const homedir = deps.homedir ?? os.homedir;
  const installSkillImpl = deps.installSkillImpl ?? installSkill;

  try {
    stdout.write(commandHeader("Installing memento"));

    if (env.MEMENTO_SKIP_SKILL_INSTALL === "1") {
      stdout.write("Skipped (MEMENTO_SKIP_SKILL_INSTALL=1)\n");
      return 0;
    }

    const skillsRoot = path.join(homedir(), ".claude", "skills");

    if (!(await isDirectory(skillsRoot))) {
      stdout.write(
        "Claude Code skills directory not found, skipping skill install. Run `memento install-skill` if you install Claude Code later.\n",
      );
      return 0;
    }

    const packageRoot = path.resolve(currentDir(), "..", "..");
    const source = path.join(packageRoot, "skill");
    const dest = path.join(skillsRoot, "memento");
    const result = await installSkillImpl({ source, dest });
    const copiedCount = result.copied.length;
    const backupMessage = result.backupDir
      ? `, backup: ${result.backupDir}`
      : "";

    stdout.write(
      `memento Claude Code skill install ${result.mode} (${copiedCount} files copied${backupMessage}).\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`memento Claude Code skill install skipped: ${message}\n`);
    return 0;
  }
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

function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (entryFile === currentFile) {
  process.exitCode = await runPostinstall();
}
