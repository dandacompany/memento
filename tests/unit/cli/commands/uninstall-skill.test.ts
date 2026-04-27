import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { UninstallResult } from "../../../../src/install/skill-installer.js";
import { fixtureDir } from "../../tmp-fixture.js";

const installerState = vi.hoisted(() => ({
  uninstallSkill: vi.fn(),
}));

vi.mock("../../../../src/install/skill-installer.js", () => ({
  uninstallSkill: installerState.uninstallSkill,
}));

const { runUninstallSkill } =
  await import("../../../../src/cli/commands/uninstall-skill.js");

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

beforeEach(() => {
  installerState.uninstallSkill.mockReset();
  installerState.uninstallSkill.mockResolvedValue(result());
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();

  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }
});

describe("uninstall-skill command", () => {
  test("successful uninstall returns zero and logs result", async () => {
    const { home, dest } = await makeInstalledHome();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const output = captureOutput();

    const exitCode = await runUninstallSkill({});

    expect(exitCode).toBe(0);
    expect(installerState.uninstallSkill).toHaveBeenCalledWith({
      dest,
      dryRun: undefined,
    });
    expect(output.stdout()).toContain("Uninstalled memento Claude Code skill");
  });

  test("nothing to uninstall exits zero with friendly message", async () => {
    const home = fixtureDir();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    installerState.uninstallSkill.mockResolvedValue(
      result({
        removed: [],
        skipped: [path.join(home, ".claude", "skills", "memento")],
      }),
    );
    const output = captureOutput();

    const exitCode = await runUninstallSkill({});

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("memento skill not installed");
  });

  test("dryRun flag is passed through and shown in output", async () => {
    const { home } = await makeInstalledHome();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const output = captureOutput();

    await runUninstallSkill({ dryRun: true });

    expect(installerState.uninstallSkill).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(output.stdout()).toContain("[dry-run]");
  });

  test("wrong skill present is refused", async () => {
    const { home, dest } = await makeInstalledHome();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    installerState.uninstallSkill.mockResolvedValue(
      result({ removed: [], skipped: [dest] }),
    );
    const output = captureOutput();

    const exitCode = await runUninstallSkill({});

    expect(exitCode).toBe(0);
    expect(output.stderr()).toContain("Refused to uninstall");
  });

  test("quiet mode suppresses successful output", async () => {
    const { home } = await makeInstalledHome();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const output = captureOutput();

    await runUninstallSkill({ quiet: true });

    expect(output.stdout()).toBe("");
  });

  test("empty uninstall result falls back to not installed message", async () => {
    const { home } = await makeInstalledHome();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    installerState.uninstallSkill.mockResolvedValue(
      result({ removed: [], skipped: [] }),
    );
    const output = captureOutput();

    await runUninstallSkill({});

    expect(output.stdout()).toContain("memento skill not installed");
  });
});

async function makeInstalledHome(): Promise<{ home: string; dest: string }> {
  const home = fixtureDir();
  const dest = path.join(home, ".claude", "skills", "memento");
  await fs.mkdir(dest, { recursive: true });
  return { home, dest };
}

function result(overrides: Partial<UninstallResult> = {}): UninstallResult {
  return {
    removed: ["SKILL.md"],
    skipped: [],
    ...overrides,
  };
}

function captureOutput(): { stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";

  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });

  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
