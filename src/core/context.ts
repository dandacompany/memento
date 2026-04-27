import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MementoContext {
  root: string;
  mementoDir: string;
}

function isDirectory(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function findProjectContext(
  startDir = process.cwd(),
): MementoContext | null {
  let current = path.resolve(startDir);

  while (true) {
    const mementoDir = path.join(current, ".memento");

    if (isDirectory(mementoDir)) {
      return {
        root: current,
        mementoDir,
      };
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function findGlobalContext(): MementoContext {
  const root = os.homedir();

  return {
    root,
    mementoDir: path.join(root, ".memento"),
  };
}

export async function ensureMementoDir(root: string): Promise<string> {
  const mementoDir = path.join(root, ".memento");
  await fsPromises.mkdir(mementoDir, { recursive: true });
  return mementoDir;
}
