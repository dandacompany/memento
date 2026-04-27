import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function pathEnv(): string {
  if (!isWindows()) {
    return process.env.PATH ?? "";
  }

  const pathKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === "path",
  );

  return pathKey ? (process.env[pathKey] ?? "") : "";
}

function windowsExtensions(bin: string): string[] {
  if (path.win32.extname(bin)) {
    return [""];
  }

  const pathext = process.env.PATHEXT ?? ".EXE;.CMD;.BAT";
  const extensions = pathext
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);

  return extensions.length > 0 ? extensions : [".EXE", ".CMD", ".BAT"];
}

async function isRunnableFile(filePath: string): Promise<boolean> {
  try {
    const mode = isWindows() ? fsConstants.F_OK : fsConstants.X_OK;
    await fs.access(filePath, mode);
    const stat = await fs.stat(filePath);

    return stat.isFile();
  } catch {
    return false;
  }
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export function osHomeDir(): string {
  return os.homedir();
}

export function appPath(name: string): string[] {
  if (isMac()) {
    return [
      `/Applications/${name}.app`,
      path.join(osHomeDir(), "Applications", `${name}.app`),
    ];
  }

  if (isWindows()) {
    const localAppData =
      process.env.LOCALAPPDATA ?? `${osHomeDir()}\\AppData\\Local`;

    return [`${localAppData}\\Programs\\${name.toLowerCase()}`];
  }

  return [];
}

export function expandHome(p: string): string {
  if (p === "~") {
    return osHomeDir();
  }

  if (p.startsWith("~/")) {
    return path.resolve(osHomeDir(), p.slice(2));
  }

  return path.resolve(p);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);

    return stat.isFile();
  } catch {
    return false;
  }
}

export async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);

    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function which(bin: string): Promise<string | null> {
  const pathDirs = pathEnv().split(path.delimiter).filter(Boolean);
  const hasPathSeparator =
    bin.includes(path.sep) || (isWindows() && bin.includes(path.win32.sep));

  if (hasPathSeparator || path.isAbsolute(bin)) {
    const directPath = path.resolve(bin);

    return (await isRunnableFile(directPath)) ? directPath : null;
  }

  for (const dir of pathDirs) {
    if (isWindows()) {
      for (const extension of windowsExtensions(bin)) {
        const candidate = path.resolve(dir, `${bin}${extension}`);

        if (await isRunnableFile(candidate)) {
          return candidate;
        }
      }
    } else {
      const candidate = path.resolve(dir, bin);

      if (await isRunnableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export async function runCmdVersion(
  bin: string,
  arg = "--version",
  timeoutMs = 1500,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [arg],
      {
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }

        const output = `${stdout}\n${stderr}`;
        const firstLine =
          output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? null;

        resolve(firstLine);
      },
    );
  });
}
