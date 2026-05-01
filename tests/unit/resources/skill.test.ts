import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  readSkillResources,
  writeSkillResources,
} from "../../../src/resources/skill.js";
import { fixtureDir } from "../tmp-fixture.js";

describe("skill resources", () => {
  test("reads a skill bundle and derives identity from frontmatter name", async () => {
    const root = fixtureDir();
    const skillDir = path.join(root, ".agents", "skills", "review");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Code Review\n---\n# Review\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(skillDir, "scripts", "check.sh"),
      "#!/bin/sh\nexit 0\n",
      "utf8",
    );

    const docs = await readSkillResources([
      {
        path: path.join(root, ".agents", "skills"),
        provider: "codex",
        scope: "project",
        tier: "project",
      },
    ]);

    expect(docs).toHaveLength(1);
    expect(docs[0]?.meta).toMatchObject({
      provider: "codex",
      scope: "project",
      tier: "project",
      identityKey: "skill:code-review",
      sourcePath: skillDir,
      sourceFormat: "directory",
      sensitive: false,
      writeable: true,
    });
    expect(docs[0]?.body).toMatchObject({
      type: "skill-bundle",
      files: [
        {
          relativePath: "SKILL.md",
          binary: false,
        },
        {
          relativePath: "scripts/check.sh",
          binary: false,
        },
      ],
    });
  });

  test("falls back to directory name and skips hidden/log files", async () => {
    const root = fixtureDir();
    const skillDir = path.join(root, ".claude", "skills", "review");
    await fs.mkdir(path.join(skillDir, ".cache"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Review\n", "utf8");
    await fs.writeFile(path.join(skillDir, "debug.log"), "noise\n", "utf8");
    await fs.writeFile(path.join(skillDir, ".cache", "state"), "noise\n", "utf8");

    const docs = await readSkillResources([
      {
        path: path.join(root, ".claude", "skills"),
        provider: "claude-code",
        scope: "local",
        tier: "project",
      },
    ]);
    const body = docs[0]?.body;

    expect(docs[0]?.meta.identityKey).toBe("skill:review");
    expect(body).toMatchObject({
      type: "skill-bundle",
      files: [
        {
          relativePath: "SKILL.md",
        },
      ],
    });
  });

  test("dedupes shared skill roots by absolute skill directory", async () => {
    const root = fixtureDir();
    const skillsRoot = path.join(root, ".agents", "skills");
    await fs.mkdir(path.join(skillsRoot, "review"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "review", "SKILL.md"),
      "---\nname: review\n---\n# Review\n",
      "utf8",
    );

    const docs = await readSkillResources([
      {
        path: skillsRoot,
        provider: "codex",
        scope: "local",
        tier: "project",
      },
      {
        path: path.join(skillsRoot, "..", "skills"),
        provider: "windsurf",
        scope: "local",
        tier: "project",
      },
    ]);

    expect(docs).toHaveLength(1);
  });

  test("returns empty list when root is missing", async () => {
    const docs = await readSkillResources([
      {
        path: path.join(fixtureDir(), "missing"),
        provider: "codex",
        scope: "local",
        tier: "project",
      },
    ]);

    expect(docs).toEqual([]);
  });

  test("writes a text skill bundle to a writable root", async () => {
    const root = fixtureDir();
    const skillsRoot = path.join(root, ".agents", "skills");
    const report = await writeSkillResources(
      [
        {
          path: skillsRoot,
          provider: "codex",
          scope: "project",
          tier: "project",
        },
      ],
      [
        {
          kind: "skill",
          body: {
            type: "skill-bundle",
            files: [
              {
                relativePath: "SKILL.md",
                contentHash: "hash",
                content: "---\nname: review\n---\n# Review\n",
                binary: false,
              },
              {
                relativePath: "scripts/check.sh",
                contentHash: "hash",
                content: "#!/bin/sh\nexit 0\n",
                binary: false,
              },
            ],
          },
          meta: {
            provider: "claude-code",
            scope: "project",
            tier: "project",
            identityKey: "skill:review",
            sourcePath: "",
            sourceFormat: "directory",
            sensitive: false,
            redactions: [],
            mtime: 1,
            bodyHash: "body",
            rawHash: "raw",
          },
        },
      ],
    );

    expect(report.written).toEqual([path.join(skillsRoot, "review")]);
    await expect(
      fs.readFile(path.join(skillsRoot, "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Review");
    await expect(
      fs.readFile(
        path.join(skillsRoot, "review", "scripts", "check.sh"),
        "utf8",
      ),
    ).resolves.toContain("exit 0");
  });
});
