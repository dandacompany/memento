import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runPostinstall } from "../../../src/install/postinstall.js";
import type { InstallResult } from "../../../src/install/skill-installer.js";
import { fixtureDir } from "../tmp-fixture.js";

describe("postinstall", () => {
  test("MEMENTO_SKIP_SKILL_INSTALL=1 skips and returns zero", async () => {
    const output = captureOutput();
    const installSkillImpl = vi.fn();

    const exitCode = await runPostinstall({
      env: { MEMENTO_SKIP_SKILL_INSTALL: "1" },
      homedir: () => fixtureDir(),
      installSkillImpl,
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Skipped");
    expect(installSkillImpl).not.toHaveBeenCalled();
  });

  test("missing Claude skills directory prints friendly message and returns zero", async () => {
    const home = fixtureDir();
    const output = captureOutput();

    const exitCode = await runPostinstall({
      env: {},
      homedir: () => home,
      installSkillImpl: vi.fn(),
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Claude Code skills directory not found");
  });

  test("non-directory Claude skills path is treated as missing", async () => {
    const home = fixtureDir();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "skills"), "file");
    const output = captureOutput();

    const exitCode = await runPostinstall({
      env: {},
      homedir: () => home,
      installSkillImpl: vi.fn(),
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("skipping skill install");
  });

  test("happy path installs skill and returns zero", async () => {
    const home = await makeHomeWithSkillsRoot();
    const output = captureOutput();
    const installSkillImpl = vi.fn(() =>
      Promise.resolve(result({ mode: "created" })),
    );

    const exitCode = await runPostinstall({
      env: {},
      homedir: () => home,
      installSkillImpl,
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    const installCall = installSkillImpl.mock.calls[0]?.[0] as {
      source: string;
      dest: string;
    };
    expect(installCall.source).toContain(`${path.sep}skill`);
    expect(installCall.dest).toBe(
      path.join(home, ".claude", "skills", "memento"),
    );
    expect(output.stdout()).toContain("created (1 files copied");
  });

  test("unchanged install reports zero copied files", async () => {
    const home = await makeHomeWithSkillsRoot();
    const output = captureOutput();

    const exitCode = await runPostinstall({
      env: {},
      homedir: () => home,
      installSkillImpl: vi.fn(() =>
        Promise.resolve(result({ mode: "unchanged", copied: [] })),
      ),
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("unchanged (0 files copied");
  });

  test("backup path is printed for update installs", async () => {
    const home = await makeHomeWithSkillsRoot();
    const output = captureOutput();
    const backupDir = path.join(home, ".claude", "skills", "memento-backup-x");

    const exitCode = await runPostinstall({
      env: {},
      homedir: () => home,
      installSkillImpl: vi.fn(() =>
        Promise.resolve(
          result({ mode: "updated", copied: ["SKILL.md"], backupDir }),
        ),
      ),
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain(`backup: ${backupDir}`);
  });

  test("install failure is reported but still returns zero", async () => {
    const home = await makeHomeWithSkillsRoot();
    const output = captureOutput();

    const exitCode = await runPostinstall({
      env: {},
      homedir: () => home,
      installSkillImpl: vi.fn(() => Promise.reject(new Error("boom"))),
      ...output.streams,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toContain("boom");
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

function captureOutput(): {
  stdout: () => string;
  stderr: () => string;
  streams: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  };
} {
  let stdout = "";
  let stderr = "";

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    streams: {
      stdout: {
        write: (chunk: string | Uint8Array) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        },
      },
    },
  };
}
