import { createRequire } from "node:module";

import { Command, CommanderError } from "commander";
import { describe, expect, test } from "vitest";

import { createProgram, stubCommand } from "../../../src/cli/index.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../../package.json") as { version: string };

function testProgram(): Command {
  const program = createProgram();
  const applyExitOverride = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(applyExitOverride);
  };
  applyExitOverride(program);
  return program;
}

async function parseExpectCommanderExit(
  program: Command,
  args: string[],
): Promise<CommanderError> {
  try {
    await program.parseAsync(["node", "memento", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected commander to exit");
}

describe("CLI entry", () => {
  test("registers all top-level commands", () => {
    const program = testProgram();

    expect(program.commands.map((command) => command.name())).toEqual([
      "init",
      "status",
      "sync",
      "watch",
      "diff",
      "restore",
      "global",
      "update",
      "install-skill",
      "uninstall-skill",
    ]);
  });

  test("registers all global subcommands", () => {
    const global = testProgram().commands.find(
      (command) => command.name() === "global",
    );

    expect(global?.commands.map((command) => command.name())).toEqual([
      "init",
      "status",
      "sync",
      "watch",
      "diff",
      "restore",
    ]);
  });

  test("registers init options", () => {
    const init = testProgram().commands.find(
      (command) => command.name() === "init",
    );

    expect(init?.options.map((option) => option.long)).toEqual([
      "--force",
      "--providers",
    ]);
  });

  test("registers sync options", () => {
    const sync = testProgram().commands.find(
      (command) => command.name() === "sync",
    );

    expect(sync?.options.map((option) => option.long)).toEqual([
      "--dry-run",
      "--strategy",
      "--tier",
      "--provider",
      "--resources",
      "--scope",
      "--no-mcp",
      "--no-skills",
      "--allow-project-secrets",
      "--yes",
      "--include-global",
    ]);
  });

  test("registers status resource options", () => {
    const status = testProgram().commands.find(
      (command) => command.name() === "status",
    );

    expect(status?.options.map((option) => option.long)).toEqual([
      "--tier",
      "--resources",
      "--scope",
      "--no-mcp",
      "--no-skills",
      "--include-global",
      "--json",
    ]);
  });

  test("registers resource options on watch and diff", () => {
    const program = testProgram();
    const watch = program.commands.find((command) => command.name() === "watch");
    const diff = program.commands.find((command) => command.name() === "diff");

    expect(watch?.options.map((option) => option.long)).toEqual([
      "--debounce",
      "--tier",
      "--provider",
      "--resources",
      "--scope",
      "--no-mcp",
      "--no-skills",
      "--include-global",
    ]);
    expect(diff?.options.map((option) => option.long)).toEqual([
      "--group",
      "--all",
      "--unified",
      "--tier",
      "--provider",
      "--resources",
      "--scope",
      "--no-mcp",
      "--no-skills",
      "--show-secrets",
      "--include-global",
      "--json",
    ]);
  });

  test("registers install-skill options", () => {
    const installSkill = testProgram().commands.find(
      (command) => command.name() === "install-skill",
    );

    expect(installSkill?.options.map((option) => option.long)).toEqual([
      "--force",
      "--dry-run",
    ]);
  });

  test("registers update options", () => {
    const update = testProgram().commands.find(
      (command) => command.name() === "update",
    );

    expect(update?.options.map((option) => option.long)).toEqual([
      "--dry-run",
    ]);
  });

  test("registers uninstall-skill options", () => {
    const uninstallSkill = testProgram().commands.find(
      (command) => command.name() === "uninstall-skill",
    );

    expect(uninstallSkill?.options.map((option) => option.long)).toEqual([
      "--dry-run",
    ]);
  });

  test("top-level help includes command descriptions", async () => {
    let output = "";
    const program = testProgram();
    program.configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });

    const exit = await parseExpectCommanderExit(program, ["--help"]);

    expect(exit.code).toBe("commander.helpDisplayed");
    expect(output).toContain("init");
    expect(output).toContain("AI memory sync CLI");
    expect(output).toContain("Show memento sync status");
    expect(output).toContain("update");
    expect(output).toContain("install-skill");
    expect(output).toContain("Manage the global memento context");
  });

  test("global help includes subcommands", async () => {
    let output = "";
    const program = testProgram();
    program.configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });

    const exit = await parseExpectCommanderExit(program, ["global", "--help"]);

    expect(exit.code).toBe("commander.helpDisplayed");
    expect(output).toContain("AI memory sync CLI");
    expect(output).toContain("sync");
    expect(output).toContain("Watch memory files");
    expect(output).toContain("Restore memory from backups");
  });

  test("--version outputs package version", async () => {
    let output = "";
    const program = testProgram();
    program.configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });

    const exit = await parseExpectCommanderExit(program, ["--version"]);

    expect(exit.code).toBe("commander.version");
    expect(output).toContain("Version");
    expect(output.trim().endsWith(packageJson.version)).toBe(true);
  });

  test("update dry-run prints update command with banner", async () => {
    let output = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = testProgram();
      await program.parseAsync(["node", "memento", "update", "--dry-run"], {
        from: "node",
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(output).toContain("Updating memento");
    expect(output).toContain("npm install -g @dantelabs/memento@latest");
  });

  test("stub command throws NOT_IMPLEMENTED MementoError", () => {
    try {
      stubCommand();
      throw new Error("Expected stubCommand to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "NOT_IMPLEMENTED",
        exitCode: 1,
        hint: "This command is implemented in Wave 5b",
      });
    }
  });

  test("global restore registers restore options", () => {
    const global = testProgram().commands.find(
      (command) => command.name() === "global",
    );
    const restore = global?.commands.find(
      (command) => command.name() === "restore",
    );

    expect(restore?.options.map((option) => option.long)).toEqual([
      "--list",
      "--at",
      "--group",
      "--prune",
    ]);
  });
});
