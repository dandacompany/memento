import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  installSkill,
  uninstallSkill,
} from "../../../src/install/skill-installer.js";
import { fixtureDir } from "../tmp-fixture.js";

describe("skill installer", () => {
  test("new install copies all files and returns created", async () => {
    const source = await makeSkillSource({ version: "1.0.0" });
    const dest = path.join(fixtureDir(), "memento");

    const result = await installSkill({ source, dest });

    expect(result.mode).toBe("created");
    expect(result.copied).toEqual([
      "SKILL.md",
      path.join("examples", "usage.md"),
      path.join("references", "api.md"),
      path.join("scripts", "sync.sh"),
    ]);
    await expect(
      fs.readFile(path.join(dest, "SKILL.md"), "utf8"),
    ).resolves.toContain("version: 1.0.0");
  });

  test("new install sets executable bit on shell scripts", async () => {
    const source = await makeSkillSource({ version: "1.0.0" });
    const dest = path.join(fixtureDir(), "memento");

    await installSkill({ source, dest });

    const stat = await fs.stat(path.join(dest, "scripts", "sync.sh"));
    expect(stat.mode & 0o111).not.toBe(0);
  });

  test("update with different version backs up old install", async () => {
    const root = fixtureDir();
    const dest = path.join(root, "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0", body: "old" }),
      dest,
    });

    const result = await installSkill({
      source: await makeSkillSource({ version: "2.0.0", body: "new" }),
      dest,
    });

    expect(result.mode).toBe("updated");
    expect(result.backupDir).toMatch(/memento-backup-/);
    await expect(
      fs.readFile(path.join(dest, "SKILL.md"), "utf8"),
    ).resolves.toContain("version: 2.0.0");
    await expect(
      fs.readFile(path.join(result.backupDir ?? "", "SKILL.md"), "utf8"),
    ).resolves.toContain("old");
  });

  test("update preserves old nested files in backup", async () => {
    const root = fixtureDir();
    const dest = path.join(root, "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0" }),
      dest,
    });

    const result = await installSkill({
      source: await makeSkillSource({ version: "2.0.0" }),
      dest,
    });

    await expect(
      fs.readFile(
        path.join(result.backupDir ?? "", "references", "api.md"),
        "utf8",
      ),
    ).resolves.toBe("reference\n");
  });

  test("same version returns unchanged and does not copy", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0" }),
      dest,
    });
    await fs.writeFile(path.join(dest, "sentinel.txt"), "keep", "utf8");

    const result = await installSkill({
      source: await makeSkillSource({ version: "1.0.0", body: "replacement" }),
      dest,
    });

    expect(result.mode).toBe("unchanged");
    expect(result.copied).toEqual([]);
    await expect(
      fs.readFile(path.join(dest, "sentinel.txt"), "utf8"),
    ).resolves.toBe("keep");
  });

  test("missing version falls back to 0.0.0 for unchanged comparison", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ version: undefined }),
      dest,
    });

    const result = await installSkill({
      source: await makeSkillSource({ version: undefined, body: "new" }),
      dest,
    });

    expect(result.mode).toBe("unchanged");
  });

  test("force copies even when versions match", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0" }),
      dest,
    });

    const result = await installSkill({
      source: await makeSkillSource({ version: "1.0.0", body: "forced" }),
      dest,
      force: true,
    });

    expect(result.mode).toBe("updated");
    await expect(
      fs.readFile(path.join(dest, "SKILL.md"), "utf8"),
    ).resolves.toContain("forced");
  });

  test("dryRun reports created actions without copying", async () => {
    const source = await makeSkillSource({ version: "1.0.0" });
    const dest = path.join(fixtureDir(), "memento");

    const result = await installSkill({ source, dest, dryRun: true });

    expect(result.mode).toBe("created");
    expect(result.copied).toContain("SKILL.md");
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("dryRun reports update and backup without mutating", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0" }),
      dest,
    });

    const result = await installSkill({
      source: await makeSkillSource({ version: "2.0.0" }),
      dest,
      dryRun: true,
    });

    expect(result.mode).toBe("updated");
    expect(result.backupDir).toMatch(/memento-backup-/);
    await expect(
      fs.readFile(path.join(dest, "SKILL.md"), "utf8"),
    ).resolves.toContain("version: 1.0.0");
    await expect(fs.stat(result.backupDir ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("install throws when source skill metadata is missing", async () => {
    const source = fixtureDir();

    await expect(
      installSkill({ source, dest: path.join(fixtureDir(), "memento") }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("uninstall removes a memento skill", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0" }),
      dest,
    });

    const result = await uninstallSkill({ dest });

    expect(result.removed).toContain("SKILL.md");
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("uninstall dryRun reports files without removing", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ version: "1.0.0" }),
      dest,
    });

    const result = await uninstallSkill({ dest, dryRun: true });

    expect(result.removed).toContain("SKILL.md");
    await expect(fs.stat(dest)).resolves.toBeDefined();
  });

  test("uninstall refuses when SKILL.md has a different name", async () => {
    const dest = path.join(fixtureDir(), "memento");
    await installSkill({
      source: await makeSkillSource({ name: "other", version: "1.0.0" }),
      dest,
    });

    const result = await uninstallSkill({ dest });

    expect(result).toEqual({ removed: [], skipped: [dest] });
    await expect(fs.stat(dest)).resolves.toBeDefined();
  });

  test("uninstall when nothing is present is a no-op", async () => {
    const dest = path.join(fixtureDir(), "memento");

    await expect(uninstallSkill({ dest })).resolves.toEqual({
      removed: [],
      skipped: [dest],
    });
  });
});

async function makeSkillSource(opts: {
  name?: string;
  version?: string;
  body?: string;
}): Promise<string> {
  const root = fixtureDir();
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "examples"), { recursive: true });
  await fs.mkdir(path.join(root, "references"), { recursive: true });

  const frontmatter = [
    "---",
    `name: ${opts.name ?? "memento"}`,
    ...(opts.version === undefined ? [] : [`version: ${opts.version}`]),
    "---",
    opts.body ?? "# Memento",
  ].join("\n");

  await fs.writeFile(path.join(root, "SKILL.md"), `${frontmatter}\n`, "utf8");
  await fs.writeFile(path.join(root, "scripts", "sync.sh"), "#!/bin/sh\n", {
    encoding: "utf8",
    mode: 0o644,
  });
  await fs.writeFile(path.join(root, "examples", "usage.md"), "example\n");
  await fs.writeFile(path.join(root, "references", "api.md"), "reference\n");

  return root;
}
