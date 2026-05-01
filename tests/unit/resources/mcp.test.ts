import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  readMcpResources,
  writeMcpResources,
} from "../../../src/resources/mcp.js";
import { fixtureDir } from "../tmp-fixture.js";

describe("mcp resources", () => {
  test("reads JSON mcpServers and redacts secret metadata", async () => {
    const root = fixtureDir();
    const configPath = path.join(root, ".mcp.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["@modelcontextprotocol/server-github"],
            env: {
              GITHUB_TOKEN: "ghp_fixtureSecretValue",
            },
          },
        },
      }),
      "utf8",
    );

    const docs = await readMcpResources([
      {
        path: configPath,
        provider: "claude-code",
        scope: "project",
        tier: "project",
        format: "json",
      },
    ]);

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      kind: "mcp",
      body: {
        type: "mcp-server",
        server: {
          name: "github",
          transport: "stdio",
          command: "npx",
          args: ["@modelcontextprotocol/server-github"],
          env: {
            GITHUB_TOKEN: "ghp_fixtureSecretValue",
          },
        },
      },
      meta: {
        provider: "claude-code",
        identityKey: "mcp:github",
        sensitive: true,
      },
    });
    expect(docs[0]?.meta.redactions[0]).toMatchObject({
      path: "env.GITHUB_TOKEN",
      reason: "secret-key-name",
    });
  });

  test("reads TOML mcp_servers and writes JSON mcpServers", async () => {
    const root = fixtureDir();
    const tomlPath = path.join(root, ".codex", "config.toml");
    const jsonPath = path.join(root, ".mcp.json");
    await fs.mkdir(path.dirname(tomlPath), { recursive: true });
    await fs.writeFile(
      tomlPath,
      [
        "[mcp_servers.playwright]",
        'command = "npx"',
        'args = ["@playwright/mcp@latest"]',
        "",
      ].join("\n"),
      "utf8",
    );

    const docs = await readMcpResources([
      {
        path: tomlPath,
        provider: "codex",
        scope: "project",
        tier: "project",
        format: "toml",
      },
    ]);
    const report = await writeMcpResources(
      [
        {
          path: jsonPath,
          provider: "claude-code",
          scope: "project",
          tier: "project",
          format: "json",
        },
      ],
      docs,
    );

    expect(report.written).toEqual([jsonPath]);
    await expect(fs.readFile(jsonPath, "utf8")).resolves.toContain(
      '"playwright"',
    );
  });
});
