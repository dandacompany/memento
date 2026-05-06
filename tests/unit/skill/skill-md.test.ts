import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { parseMarkdown } from "../../../src/adapters/shared/markdown.js";

const root = process.cwd();
const skillDir = join(root, "skill");
let skillMarkdown: ReturnType<typeof parseMarkdown>;

async function readSkillFile(relativePath: string): Promise<string> {
  return readFile(join(skillDir, relativePath), "utf8");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("Claude Code skill resources", () => {
  beforeAll(async () => {
    skillMarkdown = parseMarkdown(await readSkillFile("SKILL.md"));
  });

  test("SKILL.md frontmatter declares the memento skill name", () => {
    expect(skillMarkdown.frontmatter?.name).toBe("memento");
  });

  test("SKILL.md description includes trigger keywords", () => {
    expect(skillMarkdown.frontmatter?.description).toEqual(
      expect.stringContaining("Synchronize code assistant memory"),
    );
    expect(skillMarkdown.frontmatter?.description).toEqual(
      expect.stringContaining("global memory sync"),
    );
    expect(skillMarkdown.frontmatter?.description).toEqual(
      expect.stringContaining("memento sync"),
    );
    expect(skillMarkdown.frontmatter?.description).toEqual(
      expect.stringContaining("multi-assistant context portability"),
    );
  });

  test("SKILL.md body mentions every documented command", () => {
    const commands = [
      "init",
      "status",
      "sync",
      "watch",
      "diff",
      "restore",
      "global",
      "install-skill",
      "uninstall-skill",
    ];

    for (const command of commands) {
      expect(skillMarkdown.body).toContain(`memento ${command}`);
    }
  });

  test("ensure-cli.sh is a bash script with strict failure mode", async () => {
    const script = normalizeLineEndings(
      await readSkillFile("scripts/ensure-cli.sh"),
    );

    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("set -e");
  });

  test("ensure-cli.sh checks and invokes the memento command", async () => {
    const script = await readSkillFile("scripts/ensure-cli.sh");

    expect(script).toContain("command -v memento");
    expect(script).toContain("memento --version");
    expect(script).toContain("npm i -g @dantelabs/memento");
  });

  test("doctor.sh diagnoses CLI, skill directory, and global config", async () => {
    const script = normalizeLineEndings(
      await readSkillFile("scripts/doctor.sh"),
    );

    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("memento --version");
    expect(script).toContain(".claude/skills/memento");
    expect(script).toContain(".memento");
    expect(script).toContain("config.toml");
  });

  test("examples cover project init-sync-watch and global sync flows", async () => {
    const singleProject = await readSkillFile("examples/single-project.md");
    const globalSync = await readSkillFile("examples/global-sync.md");

    expect(singleProject).toContain("memento init");
    expect(singleProject).toContain("memento sync");
    expect(singleProject).toContain("memento watch");
    expect(globalSync).toContain("memento global init");
    expect(globalSync).toContain("memento global sync");
  });

  test("command cheatsheet lists skill install commands and project commands", async () => {
    const cheatsheet = await readSkillFile("references/command-cheatsheet.md");

    expect(cheatsheet).toContain("memento install-skill");
    expect(cheatsheet).toContain("memento uninstall-skill");
    expect(cheatsheet).toContain("memento restore");
    expect(cheatsheet).toContain("--strategy <lww|prompt|fail>");
  });
});
