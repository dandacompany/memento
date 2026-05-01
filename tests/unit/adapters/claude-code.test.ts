import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ClaudeCodeAdapter } from "../../../src/adapters/claude-code.js";
import type { MemoryDoc, Tier } from "../../../src/core/types.js";
import { fixtureDir } from "../tmp-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stubPath(value: string): void {
  vi.stubEnv("PATH", value);
  vi.stubEnv("Path", value);
}

describe("ClaudeCodeAdapter", () => {
  test("probe reports installed when claude is on PATH", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const binDir = await makeFakeClaude(root, "claude 1.2.3");
    stubHome(home);
    stubPath(binDir);

    const probe = await new ClaudeCodeAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.binaryPath).toBe(path.join(binDir, executableName("claude")));
    expect(probe.configDirPath).toBeUndefined();
    expect(probe.version).toBe("claude 1.2.3");
  });

  test("probe reports not-installed without binary or config directory", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    stubPath("");

    const probe = await new ClaudeCodeAdapter(root).probe();

    expect(probe.installStatus).toBe("not-installed");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBeUndefined();
  });

  test("probe reports unknown when only ~/.claude exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    stubHome(home);
    stubPath("");

    const probe = await new ClaudeCodeAdapter(root).probe();

    expect(probe.installStatus).toBe("unknown");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBe(path.join(home, ".claude"));
  });

  test("paths returns Claude Code memory files by tier", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);

    expect(new ClaudeCodeAdapter(root).paths(cwd)).toEqual({
      project: [path.join(cwd, "CLAUDE.md"), path.join(cwd, "AGENTS.md")],
      "project-local": [path.join(cwd, "CLAUDE.local.md")],
      global: [path.join(home, ".claude", "CLAUDE.md")],
    });
  });

  test("readResources reads Claude project and user skills", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    const projectSkill = path.join(cwd, ".claude", "skills", "review");
    const userSkill = path.join(home, ".claude", "skills", "plan");
    await fs.mkdir(projectSkill, { recursive: true });
    await fs.mkdir(userSkill, { recursive: true });
    await fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "---\nname: review\n---\n# Review\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(userSkill, "SKILL.md"),
      "---\nname: plan\n---\n# Plan\n",
      "utf8",
    );
    stubHome(home);

    const docs = await new ClaudeCodeAdapter(cwd).readResources?.(
      "skill",
      "local",
    );

    expect(docs?.map((doc) => doc.meta.identityKey)).toEqual([
      "skill:review",
      "skill:plan",
    ]);
    expect(docs?.map((doc) => doc.meta.provider)).toEqual([
      "claude-code",
      "claude-code",
    ]);
  });

  test.each([
    { installed: false, hasMemory: false },
    { installed: true, hasMemory: false },
    { installed: false, hasMemory: true },
    { installed: true, hasMemory: true },
  ])(
    "detect combines installed=$installed with hasMemory=$hasMemory",
    async ({ installed, hasMemory }) => {
      const root = fixtureDir();
      const home = await makeHome(root);
      const cwd = path.join(root, "repo");
      await fs.mkdir(cwd, { recursive: true });
      stubHome(home);
      stubPath(installed ? await makeFakeClaude(root) : "");

      if (hasMemory) {
        await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# Memory\n", "utf8");
      }

      const detect = await new ClaudeCodeAdapter(root).detect(cwd);

      expect(detect.installed).toBe(installed);
      expect(detect.hasMemory).toBe(hasMemory);
      expect(detect.active).toBe(installed || hasMemory);
      expect(detect.activeTiers).toEqual(hasMemory ? ["project"] : []);
    },
  );

  test("read returns an empty array when no files exist", async () => {
    const root = fixtureDir();
    await fs.mkdir(path.join(root, "repo"), { recursive: true });

    await expect(
      new ClaudeCodeAdapter(path.join(root, "repo")).read("project"),
    ).resolves.toEqual([]);
  });

  test("read maps CLAUDE.md to agents-md:main", async () => {
    const cwd = await makeProject({ "CLAUDE.md": "# Claude\n\nUse tests.\n" });

    const docs = await new ClaudeCodeAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe("# Claude\n\nUse tests.\n");
    expect(docs[0]?.meta).toMatchObject({
      tier: "project",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "claude-code",
      sourcePath: path.join(cwd, "CLAUDE.md"),
      bodyHash: sha256("# Claude\n\nUse tests.\n"),
      rawHash: sha256("# Claude\n\nUse tests.\n"),
    });
    expect(docs[0]?.meta.mtime).toBeGreaterThan(0);
  });

  test("read returns CLAUDE.md and AGENTS.md with the same identity key", async () => {
    const cwd = await makeProject({
      "CLAUDE.md": "# Claude\n",
      "AGENTS.md": "# Agents\n",
    });

    const docs = await new ClaudeCodeAdapter(cwd).read("project");

    expect(docs).toHaveLength(2);
    expect(docs.map((doc) => doc.meta.sourcePath)).toEqual([
      path.join(cwd, "CLAUDE.md"),
      path.join(cwd, "AGENTS.md"),
    ]);
    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "agents-md:main",
      "agents-md:main",
    ]);
  });

  test("read preserves parsed frontmatter in metadata", async () => {
    const cwd = await makeProject({
      "CLAUDE.md": "---\ntitle: Claude\ntags:\n  - sync\n---\n# Body\n",
    });

    const docs = await new ClaudeCodeAdapter(cwd).read("project");

    expect(docs[0]?.body).toBe("# Body\n");
    expect(docs[0]?.meta.frontmatter).toEqual({
      title: "Claude",
      tags: ["sync"],
    });
  });

  test("write creates a memory file in a new directory", async () => {
    const root = fixtureDir();
    const sourcePath = path.join(root, "new", "CLAUDE.md");
    const adapter = new ClaudeCodeAdapter(root);

    const report = await adapter.write("project", [
      memoryDoc(sourcePath, "project", "# New\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# New\n");
    expect(report).toEqual({ written: [sourcePath], skipped: [] });
  });

  test("write updates an existing file", async () => {
    const cwd = await makeProject({ "CLAUDE.md": "# Old\n" });
    const sourcePath = path.join(cwd, "CLAUDE.md");

    const report = await new ClaudeCodeAdapter(cwd).write("project", [
      memoryDoc(sourcePath, "project", "# Updated\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Updated\n");
    expect(report.written).toEqual([sourcePath]);
    expect(report.skipped).toEqual([]);
  });

  test("write reports skipped docs for a different tier", async () => {
    const root = fixtureDir();
    const projectPath = path.join(root, "CLAUDE.md");
    const localPath = path.join(root, "CLAUDE.local.md");

    const report = await new ClaudeCodeAdapter(root).write("project", [
      memoryDoc(projectPath, "project", "# Project\n"),
      memoryDoc(localPath, "project-local", "# Local\n"),
    ]);

    await expect(fs.readFile(projectPath, "utf8")).resolves.toBe("# Project\n");
    await expect(fs.readFile(localPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(report).toEqual({ written: [projectPath], skipped: [localPath] });
  });

  test.each([
    ["plain markdown", "# Plain\n\nBody\n"],
    ["YAML frontmatter", "---\ntitle: Claude\n---\n# Body\n"],
    ["CRLF line endings", "# Plain\r\n\r\nBody\r\n"],
    ["BOM", "\uFEFF# Plain\n\nBody\n"],
    ["trailing whitespace", "# Plain  \n\nBody\t\n"],
    ["multi-blank-line sections", "# Plain\n\n\nBody\n\n\n\nEnd\n"],
  ])("round-trips %s without changing rawHash", async (_name, content) => {
    const cwd = await makeProject({ "CLAUDE.md": content });
    const adapter = new ClaudeCodeAdapter(cwd);
    const before = await adapter.read("project");

    const report = await adapter.write("project", before);
    const after = await adapter.read("project");

    expect(report).toEqual({
      written: [path.join(cwd, "CLAUDE.md")],
      skipped: [],
    });
    expect(after.map((doc) => doc.meta.rawHash)).toEqual(
      before.map((doc) => doc.meta.rawHash),
    );
    await expect(
      fs.readFile(path.join(cwd, "CLAUDE.md"), "utf8"),
    ).resolves.toBe(content);
  });
});

async function makeHome(root: string): Promise<string> {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });

  return home;
}

function stubHome(home: string): void {
  vi.spyOn(os, "homedir").mockReturnValue(home);
}

async function makeFakeClaude(
  root: string,
  version = "claude 0.0.0",
): Promise<string> {
  const binDir = path.join(root, "bin");
  const binPath = path.join(binDir, executableName("claude"));
  const script =
    process.platform === "win32"
      ? `@echo ${version}\r\n`
      : `#!/bin/sh\necho ${version}\n`;

  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(binPath, script, "utf8");

  if (process.platform !== "win32") {
    await fs.chmod(binPath, 0o755);
  }

  return binDir;
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.CMD` : name;
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const cwd = path.join(fixtureDir(), "repo");
  await fs.mkdir(cwd, { recursive: true });

  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      fs.writeFile(path.join(cwd, name), content, "utf8"),
    ),
  );

  return cwd;
}

function memoryDoc(sourcePath: string, tier: Tier, body: string): MemoryDoc {
  return {
    body,
    meta: {
      tier,
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "claude-code",
      sourcePath,
      mtime: 0,
      bodyHash: sha256(body),
      rawHash: sha256(body),
    },
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
