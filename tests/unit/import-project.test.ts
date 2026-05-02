import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { ProviderAdapter } from "../../src/adapters/types.js";
import { importProject } from "../../src/core/import-project.js";
import type { ProviderId } from "../../src/core/types.js";
import { fixtureDir } from "./tmp-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const quietLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
};

function registryWith(...adapters: ProviderAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return registry;
}

async function mkdirp(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function stubEnv(home: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", "");
}

async function runProjectImport(opts: {
  sourceRoot: string;
  targetRoot: string;
  sourceAdapters: ProviderAdapter[];
  targetAdapters: ProviderAdapter[];
  targetProviders: ProviderId[];
  resources?: "memory" | "skill";
  strategy?: "prompt" | "skip" | "replace" | "append";
  dryRun?: boolean;
}) {
  return importProject({
    sourceRoot: opts.sourceRoot,
    targetRoot: opts.targetRoot,
    mementoDir: path.join(opts.targetRoot, ".memento"),
    sourceRegistry: registryWith(...opts.sourceAdapters),
    targetRegistry: registryWith(...opts.targetAdapters),
    targetProviders: opts.targetProviders,
    resourceKinds: [opts.resources ?? "memory"],
    resourceScope: "project",
    strategy: opts.strategy ?? "replace",
    dryRun: opts.dryRun,
    isTTY: false,
    logger: quietLogger,
  });
}

describe("importProject", () => {
  test("imports Claude project memory into Codex memory", async () => {
    const root = fixtureDir();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");

    stubEnv(path.join(root, "home"));
    await mkdirp(targetRoot);
    await writeText(path.join(sourceRoot, "CLAUDE.md"), "# Source Memory\n");

    const report = await runProjectImport({
      sourceRoot,
      targetRoot,
      sourceAdapters: [new ClaudeCodeAdapter(sourceRoot)],
      targetAdapters: [new CodexAdapter(targetRoot)],
      targetProviders: ["codex"],
    });

    await expect(fs.readFile(path.join(targetRoot, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Source Memory\n",
    );
    expect(report.groupsImported).toBe(1);
    expect(report.writes[0]?.written).toEqual([path.join(targetRoot, "AGENTS.md")]);
  });

  test("dry-run reports a pending import without writing", async () => {
    const root = fixtureDir();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");

    stubEnv(path.join(root, "home"));
    await mkdirp(targetRoot);
    await writeText(path.join(sourceRoot, "CLAUDE.md"), "# Source Memory\n");

    const report = await runProjectImport({
      sourceRoot,
      targetRoot,
      sourceAdapters: [new ClaudeCodeAdapter(sourceRoot)],
      targetAdapters: [new CodexAdapter(targetRoot)],
      targetProviders: ["codex"],
      dryRun: true,
    });

    await expect(fs.stat(path.join(targetRoot, "AGENTS.md"))).rejects.toThrow();
    expect(report.groupsImported).toBe(1);
    expect(report.writes).toEqual([]);
  });

  test("prompt strategy skips existing target memory outside a TTY", async () => {
    const root = fixtureDir();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");

    stubEnv(path.join(root, "home"));
    await writeText(path.join(sourceRoot, "CLAUDE.md"), "# Source Memory\n");
    await writeText(path.join(targetRoot, "AGENTS.md"), "# Existing Memory\n");

    const report = await runProjectImport({
      sourceRoot,
      targetRoot,
      sourceAdapters: [new ClaudeCodeAdapter(sourceRoot)],
      targetAdapters: [new CodexAdapter(targetRoot)],
      targetProviders: ["codex"],
      strategy: "prompt",
    });

    await expect(fs.readFile(path.join(targetRoot, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Existing Memory\n",
    );
    expect(report.groupsImported).toBe(0);
    expect(report.groupsSkipped).toBe(1);
  });

  test("imports Claude project skills into Codex project skills", async () => {
    const root = fixtureDir();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");

    stubEnv(path.join(root, "home"));
    await mkdirp(targetRoot);
    await writeText(
      path.join(sourceRoot, ".claude", "skills", "review", "SKILL.md"),
      "---\nname: review\n---\n# Review Skill\n",
    );

    const report = await runProjectImport({
      sourceRoot,
      targetRoot,
      sourceAdapters: [new ClaudeCodeAdapter(sourceRoot)],
      targetAdapters: [new CodexAdapter(targetRoot)],
      targetProviders: ["codex"],
      resources: "skill",
    });

    await expect(
      fs.readFile(
        path.join(targetRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("# Review Skill");
    expect(report.groupsImported).toBe(1);
  });
});
