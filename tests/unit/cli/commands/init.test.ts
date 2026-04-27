import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ProviderAdapter } from "../../../../src/adapters/types.js";
import { loadConfig } from "../../../../src/core/config.js";
import type { ProviderId, Tier } from "../../../../src/core/types.js";
import { fixtureDir } from "../../tmp-fixture.js";

const registryState = vi.hoisted(() => ({
  adapters: [] as ProviderAdapter[],
}));

vi.mock("../../../../src/cli/helpers/registry.js", () => ({
  createCliRegistry: () => ({
    all: () => registryState.adapters,
  }),
}));

const { parseProviderList, runInit } =
  await import("../../../../src/cli/commands/init.js");

const originalCwd = process.cwd();
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

const providerIds: ProviderId[] = [
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "windsurf",
];

const displayNames: Record<ProviderId, string> = {
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  codex: "OpenAI Codex CLI",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  windsurf: "Windsurf",
};

beforeEach(() => {
  registryState.adapters = makeAdapters({});
  setStdoutIsTTY(false);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();

  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }
});

describe("init command", () => {
  test("fresh init creates config.toml and .gitignore", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    const config = await loadConfig(path.join(root, ".memento"));
    expect(config.providers.codex.enabled).toBe(true);
    expect(config.providers.cursor.enabled).toBe(false);
    await expect(
      fs.readFile(path.join(root, ".memento", "config.toml"), "utf8"),
    ).resolves.toContain("[providers.codex]");
    await expect(
      fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ).resolves.toBe(".memento/cache.json\n.memento/backup/\n");
  });

  test("already initialized without --force returns 0 with warning and no overwrite", async () => {
    const root = await useFixtureCwd();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(
      path.join(mementoDir, "config.toml"),
      "sentinel",
      "utf8",
    );
    const output = captureOutput();

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    await expect(
      fs.readFile(path.join(mementoDir, "config.toml"), "utf8"),
    ).resolves.toBe("sentinel");
    expect(output.stderr()).toContain(
      `warn already initialized at ${path.join(mementoDir, "config.toml")}`,
    );
    expect(registryState.adapters[0]?.detect).not.toHaveBeenCalled();
  });

  test("already initialized with --force overwrites config", async () => {
    const root = await useFixtureCwd();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(
      path.join(mementoDir, "config.toml"),
      "sentinel",
      "utf8",
    );
    registryState.adapters = makeAdapters({
      cursor: { installed: true, hasMemory: false, activeTiers: [] },
    });

    const exitCode = await runInit({ force: true });

    expect(exitCode).toBe(0);
    const raw = await fs.readFile(path.join(mementoDir, "config.toml"), "utf8");
    expect(raw).not.toBe("sentinel");
    const config = await loadConfig(mementoDir);
    expect(config.providers.cursor.enabled).toBe(true);
  });

  test("no active providers returns exit 4 and does not write config", async () => {
    const root = await useFixtureCwd();
    const output = captureOutput();

    const exitCode = await runInit({});

    expect(exitCode).toBe(4);
    await expect(
      fs.stat(path.join(root, ".memento", "config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.stderr()).toContain(
      "warn no providers detected, run with --providers <list> to force",
    );
  });

  test("--providers narrows enabled provider list", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
      cursor: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({ providers: ["codex"] });

    expect(exitCode).toBe(0);
    const config = await loadConfig(path.join(root, ".memento"));
    expect(config.providers.codex.enabled).toBe(true);
    expect(config.providers.cursor.enabled).toBe(false);
  });

  test(".gitignore exists and appends only missing lines", async () => {
    const root = await useFixtureCwd();
    await fs.writeFile(
      path.join(root, ".gitignore"),
      "node_modules\n.memento/cache.json\n",
      "utf8",
    );
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    await expect(
      fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ).resolves.toBe("node_modules\n.memento/cache.json\n.memento/backup/\n");
  });

  test(".gitignore missing creates required ignore entries", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    await expect(
      fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ).resolves.toBe(".memento/cache.json\n.memento/backup/\n");
  });

  test("orphan provider is marked but not enabled by default", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
      windsurf: { installed: false, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    const config = await loadConfig(path.join(root, ".memento"));
    expect(config.providers.windsurf).toEqual({
      enabled: false,
      auto: true,
      include_orphan: true,
    });
  });

  test("orphan-only project initializes with no enabled providers", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      windsurf: { installed: false, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    const config = await loadConfig(path.join(root, ".memento"));
    expect(config.providers.windsurf.enabled).toBe(false);
    expect(config.providers.windsurf.include_orphan).toBe(true);
  });

  test("forced orphan provider is enabled and includes orphan memory", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      windsurf: { installed: false, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({ providers: ["windsurf"] });

    expect(exitCode).toBe(0);
    const config = await loadConfig(path.join(root, ".memento"));
    expect(config.providers.windsurf).toEqual({
      enabled: true,
      auto: true,
      include_orphan: true,
    });
  });

  test("installed provider without memory is enabled by auto detection", async () => {
    const root = await useFixtureCwd();
    registryState.adapters = makeAdapters({
      "gemini-cli": { installed: true, hasMemory: false, activeTiers: [] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    const config = await loadConfig(path.join(root, ".memento"));
    expect(config.providers["gemini-cli"].enabled).toBe(true);
  });

  test("TTY probe report uses table output", async () => {
    await useFixtureCwd();
    setStdoutIsTTY(true);
    const output = captureOutput();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Provider probe report");
    expect(output.stdout()).toContain("OpenAI Codex CLI");
    expect(output.stdout()).toContain("Status");
  });

  test("non-TTY probe report uses tab-separated output", async () => {
    await useFixtureCwd();
    const output = captureOutput();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({});

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain(
      "provider\tinstalled\thasMemory\ttiers\tstatus",
    );
    expect(output.stdout()).toContain("codex\ttrue\ttrue\tproject\tactive");
  });

  test("--json emits structured probe report", async () => {
    await useFixtureCwd();
    const output = captureOutput();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({ json: true });

    expect(exitCode).toBe(0);
    const [reportLine, successLine] = output
      .stdout()
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; providers?: unknown[] },
      );
    expect(reportLine).toMatchObject({
      type: "init.probeReport",
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "codex", status: "active" }),
      ]),
    });
    expect(successLine).toMatchObject({ type: "init.success" });
  });

  test("quiet suppresses probe and success output", async () => {
    const root = await useFixtureCwd();
    const output = captureOutput();
    registryState.adapters = makeAdapters({
      codex: { installed: true, hasMemory: true, activeTiers: ["project"] },
    });

    const exitCode = await runInit({ quiet: true });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
    await expect(
      fs.stat(path.join(root, ".memento", "config.toml")),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  test("parseProviderList rejects unknown providers", () => {
    expect(() => parseProviderList("codex,nope")).toThrow("Unknown provider");
  });
});

async function useFixtureCwd(): Promise<string> {
  const root = fixtureDir();
  process.chdir(root);
  return root;
}

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
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

interface DetectionFixture {
  installed: boolean;
  hasMemory: boolean;
  activeTiers: Tier[];
}

function makeAdapters(
  fixtures: Partial<Record<ProviderId, DetectionFixture>>,
): ProviderAdapter[] {
  return providerIds.map((id) => {
    const fixture = fixtures[id] ?? {
      installed: false,
      hasMemory: false,
      activeTiers: [],
    };

    return {
      id,
      displayName: displayNames[id],
      probe: vi.fn(async () => ({
        installStatus: fixture.installed ? "installed" : "not-installed",
      })),
      paths: vi.fn(() => ({
        project: [],
        "project-local": [],
        global: [],
      })),
      detect: vi.fn(async () => ({
        installed: fixture.installed,
        hasMemory: fixture.hasMemory,
        active: fixture.installed || fixture.hasMemory,
        activeTiers: fixture.activeTiers,
        probe: {
          installStatus: fixture.installed ? "installed" : "not-installed",
        },
      })),
      read: vi.fn(async () => []),
      write: vi.fn(async () => ({ written: [], skipped: [] })),
    };
  });
}
