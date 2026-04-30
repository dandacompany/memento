import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readmePath = path.join(rootDir, "README.md");
const koreanReadmePath = path.join(rootDir, "README.ko.md");

async function readReadme(): Promise<string> {
  return fs.readFile(readmePath, "utf8");
}

async function readKoreanReadme(): Promise<string> {
  return fs.readFile(koreanReadmePath, "utf8");
}

describe("README.md", () => {
  test("exists at the repository root", async () => {
    await expect(fs.access(readmePath)).resolves.toBeUndefined();
  });

  test("contains the npm global install command", async () => {
    await expect(readReadme()).resolves.toContain(
      "npm i -g @dantelabs/memento",
    );
  });

  test("mentions all supported providers", async () => {
    const readme = await readReadme();

    for (const provider of [
      "Claude Code",
      "Codex",
      "Gemini CLI",
      "Antigravity",
      "Cursor",
      "Windsurf",
    ]) {
      expect(readme).toContain(provider);
    }
  });

  test("mentions all CLI commands by name", async () => {
    const readme = await readReadme();

    for (const command of [
      "init",
      "status",
      "sync",
      "watch",
      "diff",
      "restore",
      "global",
      "install-skill",
      "uninstall-skill",
    ]) {
      expect(readme).toContain(`memento ${command}`);
    }
  });

  test("documents the three memory tiers", async () => {
    const readme = await readReadme();

    expect(readme).toContain("project");
    expect(readme).toContain("project-local");
    expect(readme).toContain("global");
  });

  test("documents conflict resolution strategies", async () => {
    const readme = await readReadme();

    expect(readme).toContain("lww");
    expect(readme).toContain("prompt");
    expect(readme).toContain("fail");
  });

  test("has a License section", async () => {
    await expect(readReadme()).resolves.toContain("## License");
  });

  test("has a Korean user manual", async () => {
    await expect(fs.access(koreanReadmePath)).resolves.toBeUndefined();

    const readme = await readKoreanReadme();
    expect(readme).toContain("npm i -g @dantelabs/memento");
    expect(readme).toContain("## 빠른 설치");
    expect(readme).toContain("memento sync");
  });
});
