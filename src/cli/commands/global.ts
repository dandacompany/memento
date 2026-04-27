import { runDiff, type DiffCmdOpts } from "./diff.js";
import { runInit, type InitOpts } from "./init.js";
import { runRestore, type RestoreCmdOpts } from "./restore.js";
import { runStatus, type StatusOpts } from "./status.js";
import { runSync, type SyncCmdOpts } from "./sync.js";
import { runWatch, type WatchCmdOpts } from "./watch.js";

export async function runGlobalInit(opts: InitOpts): Promise<number> {
  return runInit({ ...opts, contextMode: "global" });
}

export async function runGlobalStatus(opts: StatusOpts): Promise<number> {
  return runStatus({
    ...opts,
    tier: undefined,
    includeGlobal: undefined,
    contextMode: "global",
  });
}

export async function runGlobalSync(opts: SyncCmdOpts): Promise<number> {
  return runSync({
    ...opts,
    tier: undefined,
    includeGlobal: undefined,
    mode: "global",
  });
}

export async function runGlobalWatch(opts: WatchCmdOpts): Promise<number> {
  return runWatch({
    ...opts,
    tier: undefined,
    includeGlobal: undefined,
    mode: "global",
  });
}

export async function runGlobalDiff(opts: DiffCmdOpts): Promise<number> {
  return runDiff({
    ...opts,
    tier: undefined,
    includeGlobal: undefined,
    mode: "global",
  });
}

export async function runGlobalRestore(opts: RestoreCmdOpts): Promise<number> {
  return runRestore({
    ...opts,
    mode: "global",
  });
}
