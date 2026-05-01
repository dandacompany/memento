import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type MementoConfigFile,
} from "../../src/core/config.js";
import { MementoError } from "../../src/core/errors.js";
import { fixtureDir } from "./tmp-fixture.js";

const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml") as typeof import("@iarna/toml");

describe("config", () => {
  test("defaultConfig enables only active providers", () => {
    const config = defaultConfig(["codex", "windsurf"]);

    expect(config.providers.codex.enabled).toBe(true);
    expect(config.providers.windsurf.enabled).toBe(true);
    expect(config.providers["claude-code"].enabled).toBe(false);
    expect(config.providers.codex.auto).toBe(true);
    expect(config.providers.codex.include_orphan).toBe(false);
    expect(config.default_scope).toBe("local");
    expect(config.default_resources).toEqual(["memory", "skill", "mcp"]);
    expect(config.resources?.mcp?.project_secret_policy).toBe("wizard");
    expect(config.providers.antigravity.resources?.mcp).toMatchObject({
      enabled: false,
      write: false,
      experimental: true,
    });
    expect(config.exclude).toEqual({ paths: [] });
  });

  test("defaultConfig includes all known providers", () => {
    expect(Object.keys(defaultConfig([]).providers)).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
      "windsurf",
    ]);
  });

  test("loadConfig returns defaults when config.toml is missing", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");

    await expect(loadConfig(mementoDir)).resolves.toEqual(defaultConfig([]));
  });

  test("saveConfig creates the memento directory", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");

    await saveConfig(mementoDir, defaultConfig(["cursor"]));

    const stat = await fs.stat(path.join(mementoDir, "config.toml"));
    expect(stat.isFile()).toBe(true);
  });

  test("loadConfig and saveConfig round-trip", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");
    const expected: MementoConfigFile = {
      ...defaultConfig(["claude-code", "codex", "windsurf"]),
      providers: {
        ...defaultConfig(["claude-code", "codex", "windsurf"]).providers,
        "claude-code": {
          ...defaultConfig(["claude-code"]).providers["claude-code"],
          auto: false,
          include_orphan: true,
        },
        windsurf: {
          ...defaultConfig(["windsurf"]).providers.windsurf,
          include_orphan: true,
        },
      },
      mapping: {
        "agents-md:main": ["codex", "claude-code"],
      },
      exclude: {
        paths: ["node_modules/**", "dist/**"],
      },
    };

    await saveConfig(mementoDir, expected);

    await expect(loadConfig(mementoDir)).resolves.toEqual(expected);
  });

  test("loadConfig parses provider overrides", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(
      path.join(mementoDir, "config.toml"),
      TOML.stringify({
        providers: {
          windsurf: {
            enabled: true,
            auto: false,
            include_orphan: true,
          },
        },
      }),
      "utf8",
    );

    const config = await loadConfig(mementoDir);

    expect(config.providers.windsurf).toMatchObject({
      enabled: true,
      auto: false,
      include_orphan: true,
    });
    expect(config.providers.codex).toMatchObject({
      enabled: false,
      auto: true,
      include_orphan: false,
    });
  });

  test("loadConfig parses resource defaults and provider resource overrides", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(
      path.join(mementoDir, "config.toml"),
      TOML.stringify({
        default_scope: "project",
        default_resources: ["memory", "mcp"],
        resources: {
          skill: {
            enabled: false,
            include: ["SKILL.md"],
            exclude: ["tmp/**"],
          },
          mcp: {
            enabled: true,
            redact_output: false,
            project_secret_policy: "placeholder",
          },
        },
        providers: {
          codex: {
            resources: {
              mcp: {
                enabled: true,
                write: false,
              },
            },
          },
        },
      }),
      "utf8",
    );

    const config = await loadConfig(mementoDir);

    expect(config.default_scope).toBe("project");
    expect(config.default_resources).toEqual(["memory", "mcp"]);
    expect(config.resources?.skill).toEqual({
      enabled: false,
      include: ["SKILL.md"],
      exclude: ["tmp/**"],
    });
    expect(config.resources?.mcp).toEqual({
      enabled: true,
      redact_output: false,
      project_secret_policy: "placeholder",
    });
    expect(config.providers.codex.resources?.mcp).toMatchObject({
      enabled: true,
      write: false,
    });
  });

  test("loadConfig parses mapping and exclude paths", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(
      path.join(mementoDir, "config.toml"),
      TOML.stringify({
        mapping: {
          "rule:typescript": ["cursor", "windsurf"],
        },
        exclude: {
          paths: [".git/**"],
        },
      }),
      "utf8",
    );

    const config = await loadConfig(mementoDir);

    expect(config.mapping).toEqual({
      "rule:typescript": ["cursor", "windsurf"],
    });
    expect(config.exclude).toEqual({ paths: [".git/**"] });
  });

  test("loadConfig ignores malformed mapping entries", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(
      path.join(mementoDir, "config.toml"),
      TOML.stringify({
        mapping: {
          valid: ["codex"],
          invalid: "codex",
        },
      }),
      "utf8",
    );

    const config = await loadConfig(mementoDir);

    expect(config.mapping).toEqual({ valid: ["codex"] });
  });

  test("loadConfig throws MementoError on malformed TOML", async () => {
    const root = fixtureDir();
    const mementoDir = path.join(root, ".memento");
    await fs.mkdir(mementoDir);
    await fs.writeFile(path.join(mementoDir, "config.toml"), "[broken", "utf8");

    await expect(loadConfig(mementoDir)).rejects.toMatchObject({
      code: "CONFIG_PARSE_ERROR",
      exitCode: 1,
    });
    await expect(loadConfig(mementoDir)).rejects.toBeInstanceOf(MementoError);
  });
});
