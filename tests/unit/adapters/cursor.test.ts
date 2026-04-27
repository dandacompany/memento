import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CursorAdapter } from "../../../src/adapters/cursor.js";
import type { MemoryDoc, Tier } from "../../../src/core/types.js";
import { fixtureDir } from "../tmp-fixture.js";

afterEach(() => {
  vi.doUnmock("../../../src/adapters/shared/probe.js");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("CursorAdapter", () => {
  test("probe reports installed when cursor is on PATH", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const binDir = await makeFakeCursor(root, "cursor 1.2.3");
    stubHome(home);
    vi.stubEnv("PATH", binDir);

    const probe = await new CursorAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.binaryPath).toBe(path.join(binDir, executableName("cursor")));
    expect(probe.version).toBe("cursor 1.2.3");
  });

  test("probe reports installed when a Cursor app directory exists", async () => {
    const root = fixtureDir();
    const appDir = path.join(root, "Cursor.app");
    await fs.mkdir(appDir, { recursive: true });
    const MockedCursorAdapter = await importCursorAdapterWithProbeMock(appDir);

    const probe = await new MockedCursorAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.appPath).toBe(appDir);
  });

  test("probe reports unknown when only ~/.cursor exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
    stubHome(home);
    vi.stubEnv("PATH", "");

    const probe = await new CursorAdapter(root).probe();

    expect(probe.installStatus).toBe("unknown");
    expect(probe.configDirPath).toBe(path.join(home, ".cursor"));
  });

  test("probe reports not-installed without binary, app, or config directory", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    vi.stubEnv("PATH", "");

    const probe = await new CursorAdapter(root).probe();

    expect(probe.installStatus).toBe("not-installed");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.appPath).toBeUndefined();
    expect(probe.configDirPath).toBeUndefined();
  });

  test("paths expands Cursor rule files by tier", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await makeProjectFiles(cwd, {
      ".cursor/rules/a.mdc": "A",
      ".cursor/rules/b.local.mdc": "B",
      ".cursor/rules/nested/ignored.mdc": "ignored",
      ".cursorrules": "legacy",
    });
    await makeProjectFiles(home, {
      ".cursor/rules/global.mdc": "global",
      ".cursor/rules/nested/deep.mdc": "deep",
    });

    expect(new CursorAdapter(root).paths(cwd)).toEqual({
      project: [
        path.join(cwd, ".cursor", "rules", "a.mdc"),
        path.join(cwd, ".cursorrules"),
      ],
      "project-local": [path.join(cwd, ".cursor", "rules", "b.local.mdc")],
      global: [
        path.join(home, ".cursor", "rules", "global.mdc"),
        path.join(home, ".cursor", "rules", "nested", "deep.mdc"),
      ],
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
      vi.stubEnv("PATH", installed ? await makeFakeCursor(root) : "");

      if (hasMemory) {
        await makeProjectFiles(cwd, {
          ".cursor/rules/typescript.mdc": "# TypeScript\n",
        });
      }

      const detect = await new CursorAdapter(root).detect(cwd);

      expect(detect.installed).toBe(installed);
      expect(detect.hasMemory).toBe(hasMemory);
      expect(detect.active).toBe(installed || hasMemory);
      expect(detect.activeTiers).toEqual(hasMemory ? ["project"] : []);
    },
  );

  test("read returns an empty array when no Cursor files exist", async () => {
    const cwd = path.join(fixtureDir(), "repo");
    await fs.mkdir(cwd, { recursive: true });

    await expect(new CursorAdapter(cwd).read("project")).resolves.toEqual([]);
  });

  test("read maps one .mdc file to a rule identity", async () => {
    const cwd = await makeProject({
      ".cursor/rules/typescript.mdc": "---\ndescription: TS\n---\n# TS\n",
    });

    const docs = await new CursorAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe("# TS\n");
    expect(docs[0]?.meta).toMatchObject({
      tier: "project",
      identityKey: "rule:typescript",
      subtype: "rule",
      source: "cursor",
      sourcePath: path.join(cwd, ".cursor", "rules", "typescript.mdc"),
      frontmatter: { description: "TS" },
      bodyHash: sha256("# TS\n"),
      rawHash: sha256("---\ndescription: TS\n---\n# TS\n"),
    });
    expect(docs[0]?.meta.mtime).toBeGreaterThan(0);
  });

  test("read returns three project .mdc files in sorted order", async () => {
    const cwd = await makeProject({
      ".cursor/rules/zeta.mdc": "# Z\n",
      ".cursor/rules/alpha.mdc": "# A\n",
      ".cursor/rules/middle.mdc": "# M\n",
    });

    const docs = await new CursorAdapter(cwd).read("project");

    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "rule:alpha",
      "rule:middle",
      "rule:zeta",
    ]);
  });

  test("read surfaces new .mdc rules and legacy .cursorrules together", async () => {
    const cwd = await makeProject({
      ".cursor/rules/typescript.mdc": "# TS\n",
      ".cursorrules": "# Legacy\n",
    });

    const docs = await new CursorAdapter(cwd).read("project");

    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "rule:typescript",
      "rule:legacy",
    ]);
    expect(docs.map((doc) => doc.meta.sourcePath)).toEqual([
      path.join(cwd, ".cursor", "rules", "typescript.mdc"),
      path.join(cwd, ".cursorrules"),
    ]);
  });

  test("read treats legacy .cursorrules as plain markdown", async () => {
    const content = "---\ndescription: legacy-looking\n---\n# Legacy\n";
    const cwd = await makeProject({ ".cursorrules": content });

    const docs = await new CursorAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe(content);
    expect(docs[0]?.meta.frontmatter).toBeUndefined();
  });

  test("read returns project-local *.local.mdc rules", async () => {
    const cwd = await makeProject({
      ".cursor/rules/typescript.mdc": "# Shared\n",
      ".cursor/rules/private.local.mdc": "# Private\n",
    });

    const docs = await new CursorAdapter(cwd).read("project-local");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.meta).toMatchObject({
      tier: "project-local",
      identityKey: "rule:private",
      sourcePath: path.join(cwd, ".cursor", "rules", "private.local.mdc"),
    });
  });

  test("read preserves frontmatter metadata and round-trip hints", async () => {
    const content =
      '---\ndescription: TypeScript rules\nglobs:\n  - "**/*.ts"\nalwaysApply: false\n---\n# TypeScript\n';
    const cwd = await makeProject({ ".cursor/rules/typescript.mdc": content });

    const docs = await new CursorAdapter(cwd).read("project");
    const report = await new CursorAdapter(cwd).write("project", docs);

    expect(docs[0]?.meta.frontmatter).toEqual({
      description: "TypeScript rules",
      globs: ["**/*.ts"],
      alwaysApply: false,
    });
    expect(report.written).toEqual([
      path.join(cwd, ".cursor", "rules", "typescript.mdc"),
    ]);
    await expect(
      fs.readFile(path.join(cwd, ".cursor", "rules", "typescript.mdc"), "utf8"),
    ).resolves.toBe(content);
  });

  test("write creates a new .mdc file with frontmatter", async () => {
    const root = fixtureDir();
    const sourcePath = path.join(root, "repo", ".cursor", "rules", "new.mdc");
    const adapter = new CursorAdapter(root);

    const report = await adapter.write("project", [
      memoryDoc(sourcePath, "project", "# New\n", {
        description: "New rule",
        alwaysApply: true,
      }),
    ]);
    const docs = await new CursorAdapter(path.join(root, "repo")).read(
      "project",
    );

    expect(report).toEqual({ written: [sourcePath], skipped: [] });
    expect(docs[0]?.body).toBe("# New\n");
    expect(docs[0]?.meta.frontmatter).toEqual({
      description: "New rule",
      alwaysApply: true,
    });
  });

  test("write reports skipped docs for a different tier", async () => {
    const root = fixtureDir();
    const projectPath = path.join(root, ".cursor", "rules", "project.mdc");
    const localPath = path.join(root, ".cursor", "rules", "local.local.mdc");

    const report = await new CursorAdapter(root).write("project", [
      memoryDoc(projectPath, "project", "# Project\n"),
      memoryDoc(localPath, "project-local", "# Local\n"),
    ]);

    await expect(fs.readFile(projectPath, "utf8")).resolves.toBe("# Project\n");
    await expect(fs.readFile(localPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(report).toEqual({ written: [projectPath], skipped: [localPath] });
  });

  test("legacy migration leaves .cursorrules untouched and writes legacy.mdc", async () => {
    const cwd = await makeProject({
      ".cursorrules": "# Legacy\n",
    });
    const adapter = new CursorAdapter(cwd, { migrateLegacy: true });
    const docs = await adapter.read("project");

    const report = await adapter.write("project", docs);
    const newPath = path.join(cwd, ".cursor", "rules", "legacy.mdc");

    await expect(
      fs.readFile(path.join(cwd, ".cursorrules"), "utf8"),
    ).resolves.toBe("# Legacy\n");
    await expect(fs.readFile(newPath, "utf8")).resolves.toBe("# Legacy\n");
    expect(report).toEqual({
      written: [newPath],
      skipped: [path.join(cwd, ".cursorrules")],
    });
  });

  test("write prefers new format for legacy when .mdc rules already exist", async () => {
    const cwd = await makeProject({
      ".cursor/rules/typescript.mdc": "# TS\n",
      ".cursorrules": "# Legacy\n",
    });
    const adapter = new CursorAdapter(cwd);
    const docs = await adapter.read("project");

    const report = await adapter.write("project", docs);

    expect(report.written).toContain(
      path.join(cwd, ".cursor", "rules", "legacy.mdc"),
    );
    await expect(
      fs.readFile(path.join(cwd, ".cursorrules"), "utf8"),
    ).resolves.toBe("# Legacy\n");
  });

  test.each([
    ["plain markdown", "# Plain\n\nBody\n"],
    ["YAML frontmatter", "---\ndescription: Cursor\n---\n# Body\n"],
    ["empty frontmatter", "---\n---\n# Body\n"],
    ["CRLF frontmatter", "---\r\ndescription: Cursor\r\n---\r\n# Body\r\n"],
    [
      "list frontmatter",
      '---\nglobs:\n  - "**/*.ts"\n  - "**/*.tsx"\n---\n# Body\n',
    ],
    ["no trailing newline", "---\ndescription: Cursor\n---\n# Body"],
  ])("round-trips %s without changing rawHash", async (_name, content) => {
    const cwd = await makeProject({ ".cursor/rules/typescript.mdc": content });
    const adapter = new CursorAdapter(cwd);
    const before = await adapter.read("project");

    const report = await adapter.write("project", before);
    const after = await adapter.read("project");

    expect(report).toEqual({
      written: [path.join(cwd, ".cursor", "rules", "typescript.mdc")],
      skipped: [],
    });
    expect(after.map((doc) => doc.meta.rawHash)).toEqual(
      before.map((doc) => doc.meta.rawHash),
    );
    await expect(
      fs.readFile(path.join(cwd, ".cursor", "rules", "typescript.mdc"), "utf8"),
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

async function makeFakeCursor(
  root: string,
  version = "cursor 0.0.0",
): Promise<string> {
  const binDir = path.join(root, "bin");
  const binPath = path.join(binDir, executableName("cursor"));
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
  body: string,
  frontmatter?: Record<string, unknown>,
): MemoryDoc {
  return {
    body,
    meta: {
      tier,
      identityKey: "rule:new",
      subtype: "rule",
      source: "cursor",
      sourcePath,
      mtime: 0,
      bodyHash: sha256(body),
      rawHash: sha256(body),
      ...(frontmatter === undefined ? {} : { frontmatter }),
    },
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function importCursorAdapterWithProbeMock(
  appDir: string,
): Promise<typeof CursorAdapter> {
  vi.resetModules();
  vi.doMock("../../../src/adapters/shared/probe.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../../src/adapters/shared/probe.js")
    >("../../../src/adapters/shared/probe.js");

    return {
      ...actual,
      appPath: () => [appDir],
      dirExists: (candidate: string) => Promise.resolve(candidate === appDir),
      which: () => Promise.resolve(null),
    };
  });

  const module = await import("../../../src/adapters/cursor.js");

  return module.CursorAdapter;
}
