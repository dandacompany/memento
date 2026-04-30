import { spawn } from "node:child_process";

import { commandHeader } from "../art.js";

export interface UpdateOpts {
  dryRun?: boolean;
  quiet?: boolean;
}

const npmArgs = ["install", "-g", "@dantelabs/memento@latest"] as const;

export async function runUpdate(opts: UpdateOpts): Promise<number> {
  if (!opts.quiet) {
    process.stdout.write(commandHeader("Updating memento"));
  }

  if (opts.dryRun) {
    process.stdout.write(`Run: npm ${npmArgs.join(" ")}\n`);
    return 0;
  }

  return new Promise<number>((resolve) => {
    const child = spawn("npm", [...npmArgs], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", (error) => {
      process.stderr.write(`memento update failed: ${error.message}\n`);
      resolve(1);
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
