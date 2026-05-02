import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const root = process.cwd();
const workflowsDir = join(root, ".github", "workflows");

async function readWorkflow(name: string): Promise<string> {
  return readFile(join(workflowsDir, name), "utf8");
}

describe("GitHub Actions workflows", () => {
  test("ci.yml exists", async () => {
    await expect(readWorkflow("ci.yml")).resolves.toContain("name: CI");
  });

  test("ci.yml triggers on pushes to main and pull requests", async () => {
    const workflow = await readWorkflow("ci.yml");

    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/);
    expect(workflow).toMatch(/pull_request:/);
  });

  test("ci.yml cancels in-progress runs for the same workflow and ref", async () => {
    const workflow = await readWorkflow("ci.yml");

    expect(workflow).toContain(
      "group: ${{ github.workflow }}-${{ github.ref }}",
    );
    expect(workflow).toContain("cancel-in-progress: true");
  });

  test("ci.yml has a matrix for Node 18, 20, and 22", async () => {
    const workflow = await readWorkflow("ci.yml");

    expect(workflow).toMatch(/node-version:\s*\[18,\s*20,\s*22\]/);
  });

  test("ci.yml has a matrix for Ubuntu, macOS, and Windows", async () => {
    const workflow = await readWorkflow("ci.yml");

    expect(workflow).toMatch(
      /os:\s*\[ubuntu-latest,\s*macos-latest,\s*windows-latest\]/,
    );
  });

  test("ci.yml uses checkout and setup-node with npm cache", async () => {
    const workflow = await readWorkflow("ci.yml");

    expect(workflow).toContain("uses: actions/checkout@v6");
    expect(workflow).toContain("uses: actions/setup-node@v6");
    expect(workflow).toContain("cache: npm");
  });

  test("ci.yml installs with npm ci and runs lint, build, and test", async () => {
    const workflow = await readWorkflow("ci.yml");

    expect(workflow).toContain("run: npm ci");
    expect(workflow).toContain("run: npm run lint");
    expect(workflow).toContain("run: npm run build");
    expect(workflow).toContain("run: npm test");
  });

  test("release.yml exists", async () => {
    await expect(readWorkflow("release.yml")).resolves.toContain(
      "name: Release",
    );
  });

  test("release.yml triggers on v*.*.* tag pushes", async () => {
    const workflow = await readWorkflow("release.yml");

    expect(workflow).toMatch(/tags:\s*\n\s+- "v\*\.\*\.\*"/);
  });

  test("release.yml uses Node 22 and npm registry publishing auth", async () => {
    const workflow = await readWorkflow("release.yml");

    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org/");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });

  test("release.yml builds, tests, and publishes with provenance", async () => {
    const workflow = await readWorkflow("release.yml");

    expect(workflow).toContain("run: npm run build");
    expect(workflow).toContain("run: npm test");
    expect(workflow).toContain("run: npm publish --access public --provenance");
  });

  test("release.yml grants id-token permission for npm provenance", async () => {
    const workflow = await readWorkflow("release.yml");

    expect(workflow).toContain("id-token: write");
  });
});
