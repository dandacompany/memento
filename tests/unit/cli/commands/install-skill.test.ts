import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MementoError } from "../../../../src/core/errors.js";
import type { InstallResult } from "../../../../src/install/skill-installer.js";
import { fixtureDir } from "../../tmp-fixture.js";

const installerState = vi.hoisted(() => ({
  installSkill: vi.fn(),
}));

vi.mock("../../../../src/install/skill-installer.js", () => ({
  installSkill: installerState.installSkill,
}));

const { runInstallSkill } =
  await import("../../../../src/cli/commands/install-skill.js");

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

beforeEach(() => {
  installerState.installSkill.mockReset();
  installerState.installSkill.mockResolvedValue(result());
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

describe("install-skill command", () => {
  test("successful install returns zero and logs result", async () => {
    const home = await makeHomeWithSkillsRoot();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const output = captureOutput();

    const exitCode = await runInstallSkill({});

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Installed memento Claude Code skill");
    const installCall = installerState.installSkill.mock.calls[0]?.[0] as {
      source: string;
      dest: string;
      force?: boolean;
      dryRun?: boolean;
    };
    expect(installCall.source).toContain(`${path.sep}skill`);
    expect(installCall.dest).toBe(
      path.join(home, ".claude", "skills", "memento"),
    );
    expect(installCall.force).toBeUndefined();
    expect(installCall.dryRun).toBeUndefined();
  });

  test("force flag is passed through", async () => {
    const home = await makeHomeWithSkillsRoot();
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await runInstallSkill({ force: true, quiet: true });

    expect(installerState.installSkill).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  test("dryRun flag is passed through and shown in output", async () => {
    const home = await makeHomeWithSkillsRoot();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const output = captureOutput();

    await runInstallSkill({ dryRun: true });

    expect(installerState.installSkill).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(output.stdout()).toContain("[dry-run]");
  });

  test("unchanged install reports up to date", async () => {
    const home = await makeHomeWithSkillsRoot();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    installerState.installSkill.mockResolvedValue(
      result({ mode: "unchanged" }),
    );
    const output = captureOutput();

    await runInstallSkill({});

    expect(output.stdout()).toContain("already up to date");
  });

  test("updated install reports backup path", async () => {
    const home = await makeHomeWithSkillsRoot();
    const backupDir = path.join(home, ".claude", "skills", "memento-backup-x");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    installerState.installSkill.mockResolvedValue(
      result({ mode: "updated", backupDir }),
    );
    const output = captureOutput();

    await runInstallSkill({});

    expect(output.stdout()).toContain("Updated memento Claude Code skill");
    expect(output.stdout()).toContain(`Backup: ${backupDir}`);
  });

  test("quiet mode suppresses successful output", async () => {
    const home = await makeHomeWithSkillsRoot();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const output = captureOutput();

    await runInstallSkill({ quiet: true });

    expect(output.stdout()).toBe("");
  });

  test("missing Claude skills directory throws with hint", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(fixtureDir());

    try {
      await runInstallSkill({});
      throw new Error("Expected runInstallSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MementoError);
      expect(error).toMatchObject({
        code: "CLAUDE_SKILLS_DIR_MISSING",
        exitCode: 1,
      });
      expect((error as MementoError).hint).toContain(
        "Install Claude Code first",
      );
    }
  });
});

async function makeHomeWithSkillsRoot(): Promise<string> {
  const home = fixtureDir();
  await fs.mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  return home;
}

function result(overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    mode: "created",
    copied: ["SKILL.md"],
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
