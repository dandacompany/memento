import { findGlobalContext, findProjectContext } from "../../core/context.js";
import { MementoError } from "../../core/errors.js";

export interface CliContext {
  mode: "project" | "global";
  root: string;
  mementoDir: string;
}

export async function resolveCliContext(opts: {
  mode?: "project" | "global";
  cwd: string;
}): Promise<CliContext> {
  const mode = opts.mode ?? "project";

  if (mode === "global") {
    const context = await Promise.resolve(findGlobalContext());
    return {
      mode,
      ...context,
    };
  }

  const context = await Promise.resolve(findProjectContext(opts.cwd));
  if (!context) {
    throw new MementoError(
      "NOT_INITIALIZED",
      "No .memento directory found for this project.",
      {
        exitCode: 3,
        hint: "Run `memento init` first.",
      },
    );
  }

  return {
    mode,
    ...context,
  };
}
