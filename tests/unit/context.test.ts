import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  ensureMementoDir,
  findGlobalContext,
  findProjectContext,
} from "../../src/core/context.js";
import { fixtureDir } from "./tmp-fixture.js";

describe("context discovery", () => {
  test("cwd has .memento directory", async () => {
    const root = fixtureDir();
    await fs.mkdir(path.join(root, ".memento"));

    expect(findProjectContext(root)).toEqual({
      root,
      mementoDir: path.join(root, ".memento"),
    });
  });

  test("parent has .memento directory", async () => {
    const root = fixtureDir();
    const child = path.join(root, "packages", "app");
    await fs.mkdir(path.join(root, ".memento"));
    await fs.mkdir(child, { recursive: true });

    expect(findProjectContext(child)).toEqual({
      root,
      mementoDir: path.join(root, ".memento"),
    });
  });

  test("no .memento directory anywhere returns null", async () => {
    const root = fixtureDir();
    const child = path.join(root, "nested");
    await fs.mkdir(child);

    expect(findProjectContext(child)).toBeNull();
  });

  test("findGlobalContext returns home .memento regardless of cwd", () => {
    expect(findGlobalContext()).toEqual({
      root: os.homedir(),
      mementoDir: path.join(os.homedir(), ".memento"),
    });
  });

  test("ensureMementoDir creates the dir if missing", async () => {
    const root = fixtureDir();
    const mementoDir = await ensureMementoDir(root);
    const stat = await fs.stat(mementoDir);

    expect(stat.isDirectory()).toBe(true);
    expect(mementoDir).toBe(path.join(root, ".memento"));
  });
});
