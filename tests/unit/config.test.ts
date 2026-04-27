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
      providers: {
        antigravity: { enabled: false, auto: true, include_orphan: false },
        "claude-code": { enabled: true, auto: false, include_orphan: true },
        codex: { enabled: true, auto: true, include_orphan: false },
        cursor: { enabled: false, auto: true, include_orphan: false },
        "gemini-cli": { enabled: false, auto: true, include_orphan: false },
        windsurf: { enabled: true, auto: true, include_orphan: true },
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

    expect(config.providers.windsurf).toEqual({
      enabled: true,
      auto: false,
      include_orphan: true,
    });
    expect(config.providers.codex).toEqual({
      enabled: false,
      auto: true,
      include_orphan: false,
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
