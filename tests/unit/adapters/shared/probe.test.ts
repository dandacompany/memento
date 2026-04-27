import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  appPath,
  dirExists,
  expandHome,
  fileExists,
  isLinux,
  isMac,
  isWindows,
  osHomeDir,
  runCmdVersion,
  which,
} from "../../../../src/adapters/shared/probe.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }

  vi.unstubAllEnvs();
});

describe("shared probe utilities", () => {
  test("which finds node on PATH", async () => {
    const nodePath = await which("node");

    expect(nodePath).not.toBeNull();
    expect(path.isAbsolute(nodePath ?? "")).toBe(true);
    expect(path.basename(nodePath ?? "").toLowerCase()).toMatch(/^node/);
  });

  test("which returns null for a missing binary", async () => {
    await expect(which("definitely-not-a-real-cli-12345")).resolves.toBeNull();
  });

  test("fileExists returns true for files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memento-probe-"));
    const filePath = path.join(root, "probe.txt");
    await fs.writeFile(filePath, "ok", "utf8");

    await expect(fileExists(filePath)).resolves.toBe(true);
  });

  test("fileExists returns false for directories and missing paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memento-probe-"));

    await expect(fileExists(root)).resolves.toBe(false);
    await expect(fileExists(path.join(root, "missing.txt"))).resolves.toBe(
      false,
    );
  });

  test("dirExists returns true for directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memento-probe-"));

    await expect(dirExists(root)).resolves.toBe(true);
  });

  test("dirExists returns false for files and missing paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memento-probe-"));
    const filePath = path.join(root, "probe.txt");
    await fs.writeFile(filePath, "ok", "utf8");

    await expect(dirExists(filePath)).resolves.toBe(false);
    await expect(dirExists(path.join(root, "missing"))).resolves.toBe(false);
  });

  test("osHomeDir returns the Node home directory", () => {
    expect(osHomeDir()).toBe(os.homedir());
    expect(osHomeDir()).not.toBe("");
  });

  test("appPath returns macOS application candidates", () => {
    stubPlatform("darwin");

    expect(appPath("Cursor")).toEqual([
      "/Applications/Cursor.app",
      path.join(os.homedir(), "Applications", "Cursor.app"),
    ]);
  });

  test("appPath returns no Linux desktop app candidates", () => {
    stubPlatform("linux");

    expect(appPath("Cursor")).toEqual([]);
  });

  test("appPath returns Windows local app candidate", () => {
    stubPlatform("win32");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\dante\\AppData\\Local");

    expect(appPath("Cursor")).toEqual([
      "C:\\Users\\dante\\AppData\\Local\\Programs\\cursor",
    ]);
  });

  test("OS helpers read process.platform at runtime", () => {
    stubPlatform("win32");
    expect(isWindows()).toBe(true);
    expect(isMac()).toBe(false);
    expect(isLinux()).toBe(false);

    stubPlatform("darwin");
    expect(isWindows()).toBe(false);
    expect(isMac()).toBe(true);
    expect(isLinux()).toBe(false);

    stubPlatform("linux");
    expect(isWindows()).toBe(false);
    expect(isMac()).toBe(false);
    expect(isLinux()).toBe(true);
  });

  test("runCmdVersion returns the first non-empty version line", async () => {
    await expect(runCmdVersion("node")).resolves.toMatch(/^v\d+\.\d+\.\d+/);
  });

  test("runCmdVersion returns null for missing binaries", async () => {
    await expect(
      runCmdVersion("definitely-not-a-real-cli-12345"),
    ).resolves.toBeNull();
  });

  test("expandHome expands tilde-prefixed paths", () => {
    expect(expandHome("~/foo")).toBe(path.join(os.homedir(), "foo"));
  });

  test("expandHome leaves absolute paths unchanged", () => {
    const absolutePath = path.resolve(os.tmpdir(), "memento-probe");

    expect(expandHome(absolutePath)).toBe(absolutePath);
  });
});
