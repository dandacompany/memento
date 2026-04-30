import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WindsurfAdapter } from "../../../src/adapters/windsurf.js";
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

describe("WindsurfAdapter", () => {
  test("probe reports installed when windsurf is on PATH", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const binDir = await makeFakeWindsurf(root, "windsurf 1.2.3");
    stubHome(home);
    stubPath(binDir);

    const probe = await new WindsurfAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.binaryPath).toBe(
      path.join(binDir, executableName("windsurf")),
    );
    expect(probe.configDirPath).toBeUndefined();
    expect(probe.version).toBe("windsurf 1.2.3");
  });

  test.skipIf(process.platform !== "darwin")(
    "probe reports installed when the macOS app exists",
    async () => {
      const root = fixtureDir();
      const home = await makeHome(root);
      const appDir = path.join(home, "Applications", "Windsurf.app");
      await fs.mkdir(appDir, { recursive: true });
      stubHome(home);
      stubPath("");

      const probe = await new WindsurfAdapter(root).probe();

      expect(probe.installStatus).toBe("installed");
      expect(probe.binaryPath).toBeUndefined();
      expect(probe.appPath).toBe(appDir);
    },
  );

  test("probe reports unknown when only ~/.windsurf exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    await fs.mkdir(path.join(home, ".windsurf"), { recursive: true });
    stubHome(home);
    stubPath("");

    const probe = await new WindsurfAdapter(root).probe();

    expect(probe.installStatus).toBe("unknown");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBe(path.join(home, ".windsurf"));
  });

  test("paths expands Windsurf rule files by tier", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await makeProjectFiles(cwd, {
      ".windsurf/rules/typescript.md": "# TypeScript\n",
      ".windsurf/rules/python.md": "# Python\n",
      ".windsurf/rules/typescript.local.md": "# Local TS\n",
      ".windsurf/rules/readme.txt": "ignored\n",
      ".windsurfrules": "# Legacy\n",
    });
    await makeProjectFiles(home, {
      ".windsurf/rules/global.md": "# Global\n",
      ".windsurf/rules/team/frontend.md": "# Frontend\n",
    });

    const paths = new WindsurfAdapter(cwd).paths(cwd);

    expect(paths.project).toEqual([
      path.join(cwd, ".windsurf", "rules", "python.md"),
      path.join(cwd, ".windsurf", "rules", "typescript.md"),
      path.join(cwd, ".windsurfrules"),
    ]);
    expect(paths["project-local"]).toEqual([
      path.join(cwd, ".windsurf", "rules", "typescript.local.md"),
    ]);
    expect(paths.global).toEqual([
      path.join(home, ".windsurf", "rules", "global.md"),
      path.join(home, ".windsurf", "rules", "team", "frontend.md"),
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
      stubPath(installed ? await makeFakeWindsurf(root) : "");

      if (hasMemory) {
        await makeProjectFiles(cwd, {
          ".windsurf/rules/typescript.md": "# TypeScript\n",
        });
      }

      const detect = await new WindsurfAdapter(cwd).detect(cwd);

      expect(detect.installed).toBe(installed);
      expect(detect.hasMemory).toBe(hasMemory);
      expect(detect.active).toBe(installed || hasMemory);
      expect(detect.activeTiers).toEqual(hasMemory ? ["project"] : []);
    },
  );

  test("read returns an empty array when no files exist", async () => {
    const root = fixtureDir();
    const cwd = path.join(root, "repo");
    await fs.mkdir(cwd, { recursive: true });

    await expect(new WindsurfAdapter(cwd).read("project")).resolves.toEqual([]);
  });

  test("read maps one .md rule to rule identity", async () => {
    const cwd = await makeProject({
      ".windsurf/rules/typescript.md": "# TypeScript\n\nUse strict types.\n",
    });

    const docs = await new WindsurfAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe("# TypeScript\n\nUse strict types.\n");
    expect(docs[0]?.meta).toMatchObject({
      tier: "project",
      identityKey: "rule:typescript",
      subtype: "rule",
      source: "windsurf",
      sourcePath: path.join(cwd, ".windsurf", "rules", "typescript.md"),
      bodyHash: sha256("# TypeScript\n\nUse strict types.\n"),
      rawHash: sha256("# TypeScript\n\nUse strict types.\n"),
    });
    expect(docs[0]?.meta.mtime).toBeGreaterThan(0);
  });

  test("read returns three .md rules in sorted path order", async () => {
    const cwd = await makeProject({
      ".windsurf/rules/zeta.md": "# Zeta\n",
      ".windsurf/rules/alpha.md": "# Alpha\n",
      ".windsurf/rules/typescript.md": "# TypeScript\n",
    });

    const docs = await new WindsurfAdapter(cwd).read("project");

    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "rule:alpha",
      "rule:typescript",
      "rule:zeta",
    ]);
  });

  test("read includes legacy .windsurfrules with .md rules", async () => {
    const cwd = await makeProject({
      ".windsurf/rules/typescript.md": "# TypeScript\n",
      ".windsurfrules": "# Legacy\n",
    });

    const docs = await new WindsurfAdapter(cwd).read("project");

    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "rule:typescript",
      "rule:legacy",
    ]);
    expect(docs.map((doc) => doc.meta.sourcePath)).toEqual([
      path.join(cwd, ".windsurf", "rules", "typescript.md"),
      path.join(cwd, ".windsurfrules"),
    ]);
  });

  test("read treats legacy .windsurfrules as plain markdown", async () => {
    const content = "---\ndescription: legacy-looking\n---\n# Legacy\n";
    const cwd = await makeProject({ ".windsurfrules": content });

    const docs = await new WindsurfAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe(content);
    expect(docs[0]?.meta.frontmatter).toBeUndefined();
  });

  test("read maps *.local.md rules to project-local", async () => {
    const cwd = await makeProject({
      ".windsurf/rules/typescript.local.md": "# Local TS\n",
      ".windsurf/rules/project.md": "# Project\n",
    });

    const docs = await new WindsurfAdapter(cwd).read("project-local");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.meta).toMatchObject({
      tier: "project-local",
      identityKey: "rule:typescript",
      subtype: "rule",
      sourcePath: path.join(cwd, ".windsurf", "rules", "typescript.local.md"),
    });
  });

  test("read preserves parsed frontmatter in .md metadata", async () => {
    const cwd = await makeProject({
      ".windsurf/rules/typescript.md":
        "---\ntitle: TypeScript\ntags:\n  - strict\n---\n# Body\n",
    });

    const docs = await new WindsurfAdapter(cwd).read("project");

    expect(docs[0]?.body).toBe("# Body\n");
    expect(docs[0]?.meta.frontmatter).toEqual({
      title: "TypeScript",
      tags: ["strict"],
    });
  });

  test("write creates a new .md rule file in a new directory", async () => {
    const root = fixtureDir();
    const sourcePath = path.join(root, "repo", ".windsurf", "rules", "go.md");
    const adapter = new WindsurfAdapter(root);

    const report = await adapter.write("project", [
      memoryDoc(sourcePath, "project", "rule:go", "# Go\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Go\n");
    expect(report).toEqual({ written: [sourcePath], skipped: [] });
  });

  test("write reports skipped docs for a different tier", async () => {
    const root = fixtureDir();
    const projectPath = path.join(root, ".windsurf", "rules", "go.md");
    const localPath = path.join(root, ".windsurf", "rules", "go.local.md");

    const report = await new WindsurfAdapter(root).write("project", [
      memoryDoc(projectPath, "project", "rule:go", "# Project\n"),
      memoryDoc(localPath, "project-local", "rule:go", "# Local\n"),
    ]);

    await expect(fs.readFile(projectPath, "utf8")).resolves.toBe("# Project\n");
    await expect(fs.readFile(localPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(report).toEqual({ written: [projectPath], skipped: [localPath] });
  });

  test("legacy .windsurfrules remains writable by default", async () => {
    const cwd = await makeProject({ ".windsurfrules": "# Old\n" });
    const sourcePath = path.join(cwd, ".windsurfrules");

    const report = await new WindsurfAdapter(cwd).write("project", [
      memoryDoc(sourcePath, "project", "rule:legacy", "# Updated\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Updated\n");
    expect(report).toEqual({ written: [sourcePath], skipped: [] });
  });

  test("legacy migration mode makes .windsurfrules read-only", async () => {
    const cwd = await makeProject({ ".windsurfrules": "# Old\n" });
    const sourcePath = path.join(cwd, ".windsurfrules");

    const report = await new WindsurfAdapter(cwd, {
      migrateLegacy: true,
    }).write("project", [
      memoryDoc(sourcePath, "project", "rule:legacy", "# Updated\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Old\n");
    expect(report).toEqual({ written: [], skipped: [sourcePath] });
  });

  test.each([
    ["plain markdown", "# Plain\n\nBody\n"],
    ["YAML frontmatter", "---\ntitle: Windsurf\n---\n# Body\n"],
    ["empty YAML frontmatter", "---\n---\n# Body\n"],
    ["CRLF line endings", "# Plain\r\n\r\nBody\r\n"],
    ["BOM", "\uFEFF# Plain\n\nBody\n"],
    ["trailing whitespace", "# Plain  \n\nBody\t\n"],
  ])("round-trips %s without changing rawHash", async (_name, content) => {
    const cwd = await makeProject({ ".windsurf/rules/typescript.md": content });
    const adapter = new WindsurfAdapter(cwd);
    const before = await adapter.read("project");

    const report = await adapter.write("project", before);
    const after = await adapter.read("project");

    expect(report).toEqual({
      written: [path.join(cwd, ".windsurf", "rules", "typescript.md")],
      skipped: [],
    });
    expect(after.map((doc) => doc.meta.rawHash)).toEqual(
      before.map((doc) => doc.meta.rawHash),
    );
    await expect(
      fs.readFile(
        path.join(cwd, ".windsurf", "rules", "typescript.md"),
        "utf8",
      ),
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
  vi.stubEnv("HOME", home);
}

async function makeFakeWindsurf(
  root: string,
  version = "windsurf 0.0.0",
): Promise<string> {
  const binDir = path.join(root, "bin");
  const binPath = path.join(binDir, executableName("windsurf"));
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
  await makeProjectFiles(cwd, files);

  return cwd;
}

async function makeProjectFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const filePath = path.join(root, ...name.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }),
  );
}

function memoryDoc(
  sourcePath: string,
  tier: Tier,
  identityKey: string,
  body: string,
): MemoryDoc {
  return {
    body,
    meta: {
      tier,
      identityKey,
      subtype: identityKey.startsWith("rule:") ? "rule" : "agents-md",
      source: "windsurf",
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
