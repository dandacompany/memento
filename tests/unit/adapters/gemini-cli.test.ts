import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { GeminiCliAdapter } from "../../../src/adapters/gemini-cli.js";
import { AdapterRegistry } from "../../../src/adapters/registry.js";
import type {
  ProbeResult,
  ProviderAdapter,
  TierPaths,
  WriteReport,
} from "../../../src/adapters/types.js";
import type { MemoryDoc, ProviderId, Tier } from "../../../src/core/types.js";
import { fixtureDir } from "../tmp-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stubPath(value: string): void {
  vi.stubEnv("PATH", value);
  vi.stubEnv("Path", value);
}

describe("GeminiCliAdapter", () => {
  test("probe reports installed when gemini is on PATH", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const binDir = await makeFakeGemini(root, "gemini 1.2.3");
    stubHome(home);
    stubPath(binDir);

    const probe = await new GeminiCliAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.binaryPath).toBe(path.join(binDir, executableName("gemini")));
    expect(probe.configDirPath).toBeUndefined();
    expect(probe.version).toBe("gemini 1.2.3");
  });

  test("probe reports not-installed without binary or config directory", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    stubPath("");

    const probe = await new GeminiCliAdapter(root).probe();

    expect(probe.installStatus).toBe("not-installed");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBeUndefined();
  });

  test("probe reports unknown when only ~/.gemini exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
    stubHome(home);
    stubPath("");

    const probe = await new GeminiCliAdapter(root).probe();

    expect(probe.installStatus).toBe("unknown");
    expect(probe.binaryPath).toBeUndefined();
    expect(probe.configDirPath).toBe(path.join(home, ".gemini"));
  });

  test("paths returns Gemini CLI memory files by tier", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);

    expect(new GeminiCliAdapter(root).paths(cwd)).toEqual({
      project: [path.join(cwd, "GEMINI.md")],
      "project-local": [path.join(cwd, "GEMINI.local.md")],
      global: [path.join(home, ".gemini", "GEMINI.md")],
    });
  });

  test("global path is shared ~/.gemini/GEMINI.md and registry detects Antigravity overlap", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    const sharedPath = path.join(home, ".gemini", "GEMINI.md");
    stubHome(home);

    const registry = new AdapterRegistry();
    registry.register(new GeminiCliAdapter(cwd));
    registry.register(
      mockAdapter("antigravity", {
        paths: {
          project: [],
          "project-local": [],
          global: [
            path.join(home, ".gemini", "..", ".gemini", "GEMINI.md"),
            path.join(home, ".gemini", "antigravity", "skills"),
          ],
        },
      }),
    );

    const sharedPaths = registry.sharedGlobalPaths();

    expect(new GeminiCliAdapter(cwd).paths(cwd).global).toEqual([sharedPath]);
    expect(sharedPaths).toEqual(
      new Map([[path.resolve(sharedPath), ["antigravity", "gemini-cli"]]]),
    );
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
      stubPath(installed ? await makeFakeGemini(root) : "");

      if (hasMemory) {
        await fs.writeFile(path.join(cwd, "GEMINI.md"), "# Memory\n", "utf8");
      }

      const detect = await new GeminiCliAdapter(root).detect(cwd);

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
      new GeminiCliAdapter(path.join(root, "repo")).read("project"),
    ).resolves.toEqual([]);
  });

  test("read maps GEMINI.md to agents-md:main", async () => {
    const cwd = await makeProject({ "GEMINI.md": "# Gemini\n\nUse tests.\n" });

    const docs = await new GeminiCliAdapter(cwd).read("project");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe("# Gemini\n\nUse tests.\n");
    expect(docs[0]?.meta).toMatchObject({
      tier: "project",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "gemini-cli",
      sourcePath: path.join(cwd, "GEMINI.md"),
      bodyHash: sha256("# Gemini\n\nUse tests.\n"),
      rawHash: sha256("# Gemini\n\nUse tests.\n"),
    });
    expect(docs[0]?.meta.mtime).toBeGreaterThan(0);
  });

  test("read maps GEMINI.local.md to the project-local tier", async () => {
    const cwd = await makeProject({ "GEMINI.local.md": "# Local\n" });

    const docs = await new GeminiCliAdapter(cwd).read("project-local");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe("# Local\n");
    expect(docs[0]?.meta).toMatchObject({
      tier: "project-local",
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "gemini-cli",
      sourcePath: path.join(cwd, "GEMINI.local.md"),
    });
  });

  test("read preserves parsed frontmatter in metadata", async () => {
    const cwd = await makeProject({
      "GEMINI.md": "---\ntitle: Gemini\ntags:\n  - sync\n---\n# Body\n",
    });

    const docs = await new GeminiCliAdapter(cwd).read("project");

    expect(docs[0]?.body).toBe("# Body\n");
    expect(docs[0]?.meta.frontmatter).toEqual({
      title: "Gemini",
      tags: ["sync"],
    });
  });

  test("write creates a memory file in a new directory", async () => {
    const root = fixtureDir();
    const sourcePath = path.join(root, "new", "GEMINI.md");
    const adapter = new GeminiCliAdapter(root);

    const report = await adapter.write("project", [
      memoryDoc(sourcePath, "project", "# New\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# New\n");
    expect(report).toEqual({ written: [sourcePath], skipped: [] });
  });

  test("write updates an existing file", async () => {
    const cwd = await makeProject({ "GEMINI.md": "# Old\n" });
    const sourcePath = path.join(cwd, "GEMINI.md");

    const report = await new GeminiCliAdapter(cwd).write("project", [
      memoryDoc(sourcePath, "project", "# Updated\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# Updated\n");
    expect(report.written).toEqual([sourcePath]);
    expect(report.skipped).toEqual([]);
  });

  test("write reports skipped docs for a different tier", async () => {
    const root = fixtureDir();
    const projectPath = path.join(root, "GEMINI.md");
    const localPath = path.join(root, "GEMINI.local.md");

    const report = await new GeminiCliAdapter(root).write("project", [
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
    ["YAML frontmatter", "---\ntitle: Gemini\n---\n# Body\n"],
    ["CRLF line endings", "# Plain\r\n\r\nBody\r\n"],
    ["BOM", "\uFEFF# Plain\n\nBody\n"],
    ["trailing whitespace", "# Plain  \n\nBody\t\n"],
    ["multi-blank-line sections", "# Plain\n\n\nBody\n\n\n\nEnd\n"],
  ])("round-trips %s without changing rawHash", async (_name, content) => {
    const cwd = await makeProject({ "GEMINI.md": content });
    const adapter = new GeminiCliAdapter(cwd);
    const before = await adapter.read("project");

    const report = await adapter.write("project", before);
    const after = await adapter.read("project");

    expect(report).toEqual({
      written: [path.join(cwd, "GEMINI.md")],
      skipped: [],
    });
    expect(after.map((doc) => doc.meta.rawHash)).toEqual(
      before.map((doc) => doc.meta.rawHash),
    );
    await expect(
      fs.readFile(path.join(cwd, "GEMINI.md"), "utf8"),
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

async function makeFakeGemini(
  root: string,
  version = "gemini 0.0.0",
): Promise<string> {
  const binDir = path.join(root, "bin");
  const binPath = path.join(binDir, executableName("gemini"));
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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function memoryDoc(sourcePath: string, tier: Tier, body: string): MemoryDoc {
  return {
    body,
    meta: {
      tier,
      identityKey: "agents-md:main",
      subtype: "agents-md",
      source: "gemini-cli",
      sourcePath,
      mtime: 1,
      bodyHash: sha256(body),
      rawHash: sha256(body),
    },
  };
}

function mockAdapter(
  id: ProviderId,
  options: {
    paths: TierPaths;
  },
): ProviderAdapter {
  const probe: ProbeResult = { installStatus: "unknown" };

  return {
    id,
    displayName: id,
    probe: vi.fn(async () => probe),
    paths: vi.fn(() => options.paths),
    detect: vi.fn(async () => ({
      installed: false,
      hasMemory: false,
      active: false,
      activeTiers: [],
      probe,
    })),
    read: vi.fn(async () => []),
    write: vi.fn(
      async () => ({ written: [], skipped: [] }) satisfies WriteReport,
    ),
  };
}
