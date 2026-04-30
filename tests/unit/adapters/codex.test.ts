import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CodexAdapter } from "../../../src/adapters/codex.js";
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

describe("CodexAdapter", () => {
  test("probe reports installed when codex is on PATH", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const binDir = await makeFakeCodex(root, "codex 1.2.3");
    stubHome(home);
    stubPath(binDir);

    const probe = await new CodexAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.binaryPath).toBe(path.join(binDir, executableName("codex")));
    expect(probe.configDirPath).toBeUndefined();
    expect(probe.version).toBe("codex 1.2.3");
  });

  test("probe reports not-installed without binary or config directory", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    stubPath("");

    const probe = await new CodexAdapter(root).probe();

    expect(probe.installStatus).toBe("not-installed");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBeUndefined();
  });

  test("probe reports unknown when only ~/.codex exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    stubHome(home);
    stubPath("");

    const probe = await new CodexAdapter(root).probe();

    expect(probe.installStatus).toBe("unknown");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBe(path.join(home, ".codex"));
  });

  test("paths returns Codex memory files by tier", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);

    expect(new CodexAdapter(root).paths(cwd)).toEqual({
      project: [path.join(cwd, "AGENTS.md")],
      "project-local": [path.join(cwd, "AGENTS.local.md")],
      global: [path.join(home, ".codex", "AGENTS.md")],
    });
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
      stubPath(installed ? await makeFakeCodex(root) : "");

      if (hasMemory) {
        await fs.writeFile(path.join(cwd, "AGENTS.md"), "# Memory\n", "utf8");
      }

      const detect = await new CodexAdapter(root).detect(cwd);

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
      new CodexAdapter(path.join(root, "repo")).read("project"),
    ).resolves.toEqual([]);
  });

  test("read maps AGENTS.md to agents-md:main", async () => {
    const cwd = await makeProject({ "AGENTS.md": "# Codex\n\nUse tests.\n" });

    const docs = await new CodexAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe("# Codex\n\nUse tests.\n");
    expect(docs[0]?.meta).toMatchObject({
      tier: "project",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "codex",
      sourcePath: path.join(cwd, "AGENTS.md"),
      bodyHash: sha256("# Codex\n\nUse tests.\n"),
      rawHash: sha256("# Codex\n\nUse tests.\n"),
    });
    expect(docs[0]?.meta.mtime).toBeGreaterThan(0);
  });

  test("read preserves parsed frontmatter in metadata", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "---\ntitle: Codex\ntags:\n  - sync\n---\n# Body\n",
    });

    const docs = await new CodexAdapter(cwd).read("project");

    expect(docs[0]?.body).toBe("# Body\n");
    expect(docs[0]?.meta.frontmatter).toEqual({
      title: "Codex",
      tags: ["sync"],
    });
  });

  test("read maps AGENTS.local.md to project-local tier", async () => {
    const cwd = await makeProject({
      "AGENTS.local.md": "# Local\n",
    });

    const docs = await new CodexAdapter(cwd).read("project-local");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.meta).toMatchObject({
      tier: "project-local",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "codex",
      sourcePath: path.join(cwd, "AGENTS.local.md"),
    });
  });

  test("write creates a memory file in a new directory", async () => {
    const root = fixtureDir();
    const sourcePath = path.join(root, "new", "AGENTS.md");
    const adapter = new CodexAdapter(root);

    const report = await adapter.write("project", [
      memoryDoc(sourcePath, "project", "# New\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# New\n");
    expect(report).toEqual({ written: [sourcePath], skipped: [] });
  });

  test("write updates an existing file", async () => {
    const cwd = await makeProject({ "AGENTS.md": "# Old\n" });
    const sourcePath = path.join(cwd, "AGENTS.md");

    const report = await new CodexAdapter(cwd).write("project", [
      memoryDoc(sourcePath, "project", "# Updated\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Updated\n");
    expect(report.written).toEqual([sourcePath]);
    expect(report.skipped).toEqual([]);
  });

  test("write completes through atomic rename without leaving a temp file", async () => {
    const cwd = await makeProject({ "AGENTS.md": "# Old\n" });
    const sourcePath = path.join(cwd, "AGENTS.md");

    await new CodexAdapter(cwd).write("project", [
      memoryDoc(sourcePath, "project", "# Atomic\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Atomic\n");
    await expect(fs.stat(`${sourcePath}.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("write reports skipped docs for a different tier", async () => {
    const root = fixtureDir();
    const projectPath = path.join(root, "AGENTS.md");
    const localPath = path.join(root, "AGENTS.local.md");

    const report = await new CodexAdapter(root).write("project", [
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
    ["YAML frontmatter", "---\ntitle: Codex\n---\n# Body\n"],
    ["CRLF line endings", "# Plain\r\n\r\nBody\r\n"],
    ["BOM", "\uFEFF# Plain\n\nBody\n"],
    ["trailing whitespace", "# Plain  \n\nBody\t\n"],
    ["multi-blank-line sections", "# Plain\n\n\nBody\n\n\n\nEnd\n"],
  ])("round-trips %s without changing rawHash", async (_name, content) => {
    const cwd = await makeProject({ "AGENTS.md": content });
    const adapter = new CodexAdapter(cwd);
    const before = await adapter.read("project");

    const report = await adapter.write("project", before);
    const after = await adapter.read("project");

    expect(report).toEqual({
      written: [path.join(cwd, "AGENTS.md")],
      skipped: [],
    });
    expect(after.map((doc) => doc.meta.rawHash)).toEqual(
      before.map((doc) => doc.meta.rawHash),
    );
    await expect(
      fs.readFile(path.join(cwd, "AGENTS.md"), "utf8"),
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

async function makeFakeCodex(
  root: string,
  version = "codex 0.0.0",
): Promise<string> {
  const binDir = path.join(root, "bin");
  const binPath = path.join(binDir, executableName("codex"));
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
      source: "codex",
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
