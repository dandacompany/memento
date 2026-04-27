import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const changelogPath = path.join(rootDir, "CHANGELOG.md");

async function readChangelog(): Promise<string> {
  return fs.readFile(changelogPath, "utf8");
}

describe("CHANGELOG.md", () => {
  test("exists at the repository root", async () => {
    await expect(fs.access(changelogPath)).resolves.toBeUndefined();
  });

  test("has a 0.1.0 section", async () => {
    await expect(readChangelog()).resolves.toContain("## [0.1.0]");
  });

  test("has an Added section under 0.1.0", async () => {
    const changelog = await readChangelog();
    const releaseSection = changelog.slice(
      changelog.indexOf("## [0.1.0]"),
      changelog.indexOf("[0.1.0]:"),
    );

    expect(releaseSection).toContain("### Added");
  });

  test("mentions provider support", async () => {
    const changelog = await readChangelog();

    expect(changelog).toMatch(/6 provider|Claude Code|Codex|Gemini CLI/);
  });
});
