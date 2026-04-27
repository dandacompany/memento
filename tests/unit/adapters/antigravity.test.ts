import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { AntigravityAdapter } from "../../../src/adapters/antigravity.js";
import type { MemoryDoc, Subtype, Tier } from "../../../src/core/types.js";
import { fixtureDir } from "../tmp-fixture.js";

const originalPlatform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("AntigravityAdapter", () => {
  test("probe reports installed when the Antigravity skill store exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    stubPlatform("linux");
    await fs.mkdir(path.join(home, ".gemini", "antigravity"), {
      recursive: true,
    });

    const probe = await new AntigravityAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.configDirPath).toBe(path.join(home, ".gemini", "antigravity"));
  });

  test("probe reports unknown when only ~/.antigravity exists", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    stubPlatform("linux");
    await fs.mkdir(path.join(home, ".antigravity"), { recursive: true });

    const probe = await new AntigravityAdapter(root).probe();

    expect(probe.installStatus).toBe("unknown");
    expect(probe.configDirPath).toBe(path.join(home, ".antigravity"));
    expect(probe.appPath).toBeUndefined();
  });

  test("probe reports not-installed without Antigravity app or config directories", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    stubPlatform("linux");

    const probe = await new AntigravityAdapter(root).probe();

    expect(probe.installStatus).toBe("not-installed");
    expect(probe.appPath).toBeUndefined();
    expect(probe.configDirPath).toBeUndefined();
  });

  test("probe checks the macOS application path", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const stat = fs.stat;
    stubHome(home);
    stubPlatform("darwin");
    vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      if (String(target) === "/Applications/Antigravity.app") {
        return { isDirectory: () => true } as Awaited<
          ReturnType<typeof fs.stat>
        >;
      }

      return stat(target);
    });

    const probe = await new AntigravityAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.appPath).toBe("/Applications/Antigravity.app");
  });

  test("probe checks the Windows LOCALAPPDATA application path", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const localAppData = path.join(root, "LocalAppData");
    stubHome(home);
    stubPlatform("win32");
    vi.stubEnv("LOCALAPPDATA", localAppData);
    await fs.mkdir(path.join(localAppData, "Programs", "antigravity"), {
      recursive: true,
    });

    const probe = await new AntigravityAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.appPath).toBe(
      path.join(localAppData, "Programs", "antigravity"),
    );
  });

  test("probe checks the Windows APPDATA antigravity directory", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const appData = path.join(root, "AppData", "Roaming");
    stubHome(home);
    stubPlatform("win32");
    vi.stubEnv("APPDATA", appData);
    await fs.mkdir(path.join(appData, "antigravity"), { recursive: true });

    const probe = await new AntigravityAdapter(root).probe();

    expect(probe.installStatus).toBe("installed");
    expect(probe.appPath).toBe(path.join(appData, "antigravity"));
  });

  test("paths expands project skill and memory-bank globs", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await writeProject(cwd, {
      ".agent/skills/git-flow/SKILL.md": "# Git flow\n",
      "memory-bank/core/state.md": "# State\n",
      "memory-bank/core/state.txt": "ignored\n",
    });

    const paths = new AntigravityAdapter(cwd).paths(cwd);

    expect(paths.project).toEqual([
      path.join(cwd, ".agent", "skills", "git-flow", "SKILL.md"),
      path.join(cwd, "memory-bank", "core", "state.md"),
    ]);
  });

  test("paths expands project-local memory-bank globs", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await writeProject(cwd, {
      "memory-bank/core/state.local.md": "# Local\n",
      "memory-bank/core/state.md": "# Shared\n",
    });

    const paths = new AntigravityAdapter(cwd).paths(cwd);

    expect(paths["project-local"]).toEqual([
      path.join(cwd, "memory-bank", "core", "state.local.md"),
    ]);
  });

  test("paths includes the shared ~/.gemini/GEMINI.md global file", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);

    const paths = new AntigravityAdapter(root).paths(root);

    expect(paths.global).toContain(path.join(home, ".gemini", "GEMINI.md"));
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
      stubPlatform("linux");

      if (installed) {
        await fs.mkdir(path.join(home, ".gemini", "antigravity"), {
          recursive: true,
        });
      }

      if (hasMemory) {
        await writeProject(cwd, {
          ".agent/skills/git-flow/SKILL.md": "# Git flow\n",
        });
      }

      const detect = await new AntigravityAdapter(cwd).detect(cwd);

      expect(detect.installed).toBe(installed);
      expect(detect.hasMemory).toBe(hasMemory);
      expect(detect.active).toBe(installed || hasMemory);
      expect(detect.activeTiers).toEqual(hasMemory ? ["project"] : []);
    },
  );

  test("read returns no docs when only blocked brain and conversations files exist", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await writeProject(cwd, {
      ".agent/skills/conversations/SKILL.md": "# Blocked\n",
      "memory-bank/conversations/secret.md": "# Secret\n",
    });
    await writeFile(
      path.join(home, ".antigravity", "brain", "state.md"),
      "# Brain\n",
    );

    const docs = await new AntigravityAdapter(cwd).read("project");

    expect(docs).toEqual([]);
  });

  test("read returns skill and memory-bank docs with derived identities", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await writeProject(cwd, {
      ".agent/skills/git-flow/SKILL.md": "# Git flow\n",
      "memory-bank/core/state.md": "# State\n",
    });

    const docs = await new AntigravityAdapter(cwd).read("project");

    expect(docs).toHaveLength(2);
    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "skill:git-flow",
      "memory-bank:core/state",
    ]);
    expect(docs.map((doc) => doc.meta.subtype)).toEqual([
      "skill",
      "memory-bank",
    ]);
    expect(docs.every((doc) => doc.meta.source === "antigravity")).toBe(true);
  });

  test("read returns docs from global Antigravity skills and shared Gemini memory", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    await writeFile(
      path.join(home, ".gemini", "antigravity", "skills", "ship", "SKILL.md"),
      "# Ship\n",
    );
    await writeFile(path.join(home, ".gemini", "GEMINI.md"), "# Gemini\n");

    const docs = await new AntigravityAdapter(root).read("global");

    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "skill:ship",
      "agents-md:main",
    ]);
    expect(docs.map((doc) => doc.meta.sourcePath)).toEqual([
      path.join(home, ".gemini", "antigravity", "skills", "ship", "SKILL.md"),
      path.join(home, ".gemini", "GEMINI.md"),
    ]);
  });

  test("read never reads files under ~/.antigravity/brain", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const readFile = fs.readFile;
    stubHome(home);
    await writeFile(
      path.join(home, ".antigravity", "brain", "secret.md"),
      "# Secret\n",
    );
    await writeFile(
      path.join(home, ".gemini", "antigravity", "skills", "ok", "SKILL.md"),
      "# OK\n",
    );
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(readFile);

    const docs = await new AntigravityAdapter(root).read("global");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.meta.sourcePath).not.toContain(
      path.join(".antigravity", "brain"),
    );
    expect(
      readSpy.mock.calls.some((call) =>
        String(call[0]).includes(path.join(".antigravity", "brain")),
      ),
    ).toBe(false);
  });

  test("read filters blocked paths before file IO", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    const readFile = fs.readFile;
    stubHome(home);
    await writeProject(cwd, {
      ".agent/skills/conversations/SKILL.md": "# Secret\n",
    });
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(readFile);

    const docs = await new AntigravityAdapter(cwd).read("project");

    expect(docs).toEqual([]);
    expect(
      readSpy.mock.calls.some((call) =>
        String(call[0]).includes(`${path.sep}conversations${path.sep}`),
      ),
    ).toBe(false);
  });

  test("write throws BRAIN_WRITE_REFUSED for ~/.antigravity/brain paths", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    stubHome(home);
    const brainPath = path.join(home, ".antigravity", "brain", "state.md");

    await expect(
      new AntigravityAdapter(root).write("global", [
        memoryDoc(brainPath, "global", "memory-bank", "# Brain\n"),
      ]),
    ).rejects.toMatchObject({
      code: "BRAIN_WRITE_REFUSED",
      providerId: "antigravity",
      phase: "write",
    });
  });

  test("write throws BRAIN_WRITE_REFUSED for conversations paths", async () => {
    const root = fixtureDir();
    const cwd = path.join(root, "repo");
    const secretPath = path.join(
      cwd,
      "memory-bank",
      "conversations",
      "secret.md",
    );

    await expect(
      new AntigravityAdapter(cwd).write("project", [
        memoryDoc(secretPath, "project", "memory-bank", "# Secret\n"),
      ]),
    ).rejects.toMatchObject({ code: "BRAIN_WRITE_REFUSED" });
  });

  test("brain blocklist is system-enforced and not loaded from config", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    const brainPath = path.join(home, ".antigravity", "brain", "state.md");
    stubHome(home);
    await writeProject(cwd, {
      ".memento/config.toml": "exclude = { paths = [] }\n",
    });

    await expect(
      new AntigravityAdapter(cwd).write("global", [
        memoryDoc(brainPath, "global", "memory-bank", "# Brain\n"),
      ]),
    ).rejects.toMatchObject({ code: "BRAIN_WRITE_REFUSED" });
  });

  test("write creates parent directories and writes atomically", async () => {
    const root = fixtureDir();
    const sourcePath = path.join(root, "repo", "memory-bank", "core", "new.md");

    const report = await new AntigravityAdapter(root).write("project", [
      memoryDoc(sourcePath, "project", "memory-bank", "# New\n"),
    ]);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("# New\n");
    expect(report).toEqual({ written: [sourcePath], skipped: [] });
  });

  test("write reports skipped docs for a different tier", async () => {
    const root = fixtureDir();
    const projectPath = path.join(root, "memory-bank", "core", "state.md");
    const localPath = path.join(root, "memory-bank", "core", "state.local.md");

    const report = await new AntigravityAdapter(root).write("project", [
      memoryDoc(projectPath, "project", "memory-bank", "# Project\n"),
      memoryDoc(localPath, "project-local", "memory-bank", "# Local\n"),
    ]);

    await expect(fs.readFile(projectPath, "utf8")).resolves.toBe("# Project\n");
    await expect(fs.readFile(localPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(report).toEqual({ written: [projectPath], skipped: [localPath] });
  });

  test.each(roundTripCases())(
    "round-trips %s %s without changing rawHash",
    async (_name, target, content) => {
      const root = fixtureDir();
      const home = await makeHome(root);
      const cwd = path.join(root, "repo");
      const relativePath =
        target === "skill"
          ? ".agent/skills/round-trip/SKILL.md"
          : "memory-bank/core/round-trip.md";
      const sourcePath = path.join(cwd, ...relativePath.split("/"));
      stubHome(home);
      await writeProject(cwd, { [relativePath]: content });
      const adapter = new AntigravityAdapter(cwd);

      const before = await adapter.read("project");
      const report = await adapter.write("project", before);
      const after = await adapter.read("project");

      expect(report).toEqual({ written: [sourcePath], skipped: [] });
      expect(after.map((doc) => doc.meta.rawHash)).toEqual(
        before.map((doc) => doc.meta.rawHash),
      );
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(content);
    },
  );

  test("read handles multiple skill and memory-bank files", async () => {
    const root = fixtureDir();
    const home = await makeHome(root);
    const cwd = path.join(root, "repo");
    stubHome(home);
    await writeProject(cwd, {
      ".agent/skills/a/SKILL.md": "# A\n",
      ".agent/skills/b/SKILL.md": "# B\n",
      ".agent/skills/c/SKILL.md": "# C\n",
      "memory-bank/core/state.md": "# State\n",
      "memory-bank/team/notes.md": "# Notes\n",
    });

    const docs = await new AntigravityAdapter(cwd).read("project");

    expect(docs).toHaveLength(5);
    expect(docs.map((doc) => doc.meta.identityKey)).toEqual([
      "skill:a",
      "skill:b",
      "skill:c",
      "memory-bank:core/state",
      "memory-bank:team/notes",
    ]);
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

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

async function writeProject(
  cwd: string,
  files: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(path.join(cwd, ...name.split("/")), content),
    ),
  );
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function memoryDoc(
  sourcePath: string,
  tier: Tier,
  subtype: Subtype,
  body: string,
): MemoryDoc {
  const stem = path.basename(sourcePath).replace(/\.local\.md$|\.md$/u, "");
  const identityKey =
    subtype === "skill"
      ? `skill:${path.basename(path.dirname(sourcePath))}`
      : `memory-bank:${stem}`;

  return {
    body,
    meta: {
      tier,
      identityKey,
      subtype,
      source: "antigravity",
      sourcePath,
      mtime: 0,
      bodyHash: sha256(body),
      rawHash: sha256(body),
    },
  };
}

function roundTripCases(): [string, "skill" | "memory-bank", string][] {
  const variants: [string, string][] = [
    ["plain markdown", "# Plain\n\nBody\n"],
    ["YAML frontmatter", "---\ntitle: Antigravity\n---\n# Body\n"],
    ["CRLF line endings", "# Plain\r\n\r\nBody\r\n"],
    ["BOM", "\uFEFF# Plain\n\nBody\n"],
    ["trailing whitespace", "# Plain  \n\nBody\t\n"],
    ["multi-blank-line sections", "# Plain\n\n\nBody\n\n\n\nEnd\n"],
  ];

  return variants.flatMap(([name, content]) => [
    [name, "skill", content],
    [name, "memory-bank", content],
  ]);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
