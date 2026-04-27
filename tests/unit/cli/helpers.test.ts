import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveCliContext } from "../../../src/cli/helpers/context.js";
import { handleCliError } from "../../../src/cli/helpers/errors.js";
import { loggerFromOpts } from "../../../src/cli/helpers/logger.js";
import { createCliRegistry } from "../../../src/cli/helpers/registry.js";
import { MementoError } from "../../../src/core/errors.js";
import type { Logger } from "../../../src/core/logger.js";
import { fixtureDir } from "../tmp-fixture.js";

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }
});

describe("CLI helpers", () => {
  test("createCliRegistry registers all adapters in alphabetical order", () => {
    const registry = createCliRegistry();

    expect(registry.all().map((adapter) => adapter.id)).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
      "windsurf",
    ]);
  });

  test("resolveCliContext resolves a project context at cwd", async () => {
    const root = fixtureDir();
    await fs.mkdir(path.join(root, ".memento"));

    await expect(resolveCliContext({ cwd: root })).resolves.toEqual({
      mode: "project",
      root,
      mementoDir: path.join(root, ".memento"),
    });
  });

  test("resolveCliContext resolves a project context from a parent", async () => {
    const root = fixtureDir();
    const cwd = path.join(root, "packages", "app");
    await fs.mkdir(path.join(root, ".memento"));
    await fs.mkdir(cwd, { recursive: true });

    await expect(resolveCliContext({ cwd })).resolves.toEqual({
      mode: "project",
      root,
      mementoDir: path.join(root, ".memento"),
    });
  });

  test("resolveCliContext throws NOT_INITIALIZED for missing project context", async () => {
    const root = fixtureDir();

    await expect(resolveCliContext({ cwd: root })).rejects.toMatchObject({
      code: "NOT_INITIALIZED",
      exitCode: 3,
    });
  });

  test("resolveCliContext resolves global context", async () => {
    const root = fixtureDir();

    await expect(
      resolveCliContext({ cwd: root, mode: "global" }),
    ).resolves.toEqual({
      mode: "global",
      root: os.homedir(),
      mementoDir: path.join(os.homedir(), ".memento"),
    });
  });

  test("loggerFromOpts emits JSON when requested", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const logger = loggerFromOpts({ json: true });

    logger.info("hello");

    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ level: "info", message: "hello", args: ["hello"] })}\n`,
    );
  });

  test("loggerFromOpts suppresses info in quiet mode but keeps errors", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logger = loggerFromOpts({ quiet: true });

    logger.info("hidden");
    logger.error("visible");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("error visible\n");
  });

  test("loggerFromOpts respects debug flag", () => {
    setStdoutIsTTY(false);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    loggerFromOpts({ debug: false }).debug("hidden");
    loggerFromOpts({ debug: true }).debug("visible");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("debug visible\n");
  });

  test("loggerFromOpts detects tty mode", () => {
    setStdoutIsTTY(true);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const logger = loggerFromOpts({});

    logger.startSpinner("working");
    logger.stopSpinner("done");

    expect(write).toHaveBeenCalledWith("working\n");
    expect(write).toHaveBeenCalledWith("done\n");
  });

  test("handleCliError formats MementoError and returns its exit code", () => {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
      startSpinner: vi.fn(),
      stopSpinner: vi.fn(),
    };

    const exitCode = handleCliError(
      new MementoError("NO_ACTIVE_PROVIDERS", "No active providers.", {
        exitCode: 4,
        hint: "Run status.",
      }),
      logger,
      false,
    );

    expect(exitCode).toBe(4);
    expect(logger.error).toHaveBeenCalledWith("No active providers.");
    expect(logger.error).toHaveBeenCalledWith("Hint: Run status.");
  });

  test("handleCliError returns generic exit code for unknown errors", () => {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
      startSpinner: vi.fn(),
      stopSpinner: vi.fn(),
    };

    expect(handleCliError(new Error("boom"), logger, false)).toBe(1);
    expect(logger.error).toHaveBeenCalledWith("boom");
  });
});
