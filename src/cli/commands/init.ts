import { promises as fs } from "node:fs";
import path from "node:path";

import type { DetectResult, ProviderAdapter } from "../../adapters/types.js";
import { defaultConfig, saveConfig } from "../../core/config.js";
import { findGlobalContext, findProjectContext } from "../../core/context.js";
import { MementoError } from "../../core/errors.js";
import type { ProviderId, Tier } from "../../core/types.js";
import { createCliRegistry } from "../helpers/registry.js";

export interface InitOpts {
  force?: boolean;
  providers?: ProviderId[];
  quiet?: boolean;
  json?: boolean;
  debug?: boolean;
  contextMode?: "project" | "global";
}

type ProviderStatus = "active" | "orphan" | "skipped" | "forced";

interface ProbeRow {
  id: ProviderId;
  displayName: string;
  installed: boolean;
  hasMemory: boolean;
  activeTiers: Tier[];
  installStatus: DetectResult["probe"]["installStatus"];
  status: ProviderStatus;
  hint?: string;
}

const providerIds = new Set<ProviderId>([
  "antigravity",
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "windsurf",
]);

const gitignoreEntries = [".memento/cache.json", ".memento/backup/"] as const;

export function parseProviderList(value: string): ProviderId[] {
  const providers = value
    .split(",")
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);

  const invalid = providers.filter(
    (provider): provider is string => !providerIds.has(provider as ProviderId),
  );

  if (invalid.length > 0) {
    throw new MementoError(
      "INVALID_PROVIDER",
      `Unknown provider(s): ${invalid.join(", ")}`,
      {
        exitCode: 1,
        hint: `Valid providers: ${[...providerIds].join(", ")}`,
      },
    );
  }

  return [...new Set(providers as ProviderId[])];
}

export async function runInit(opts: InitOpts): Promise<number> {
  const projectRoot = findProjectContext(process.cwd())?.root ?? process.cwd();
  const context =
    opts.contextMode === "global"
      ? findGlobalContext()
      : {
          root: projectRoot,
          mementoDir: path.join(projectRoot, ".memento"),
        };
  const { root, mementoDir } = context;
  const configPath = path.join(mementoDir, "config.toml");

  if ((await fileExists(configPath)) && !opts.force) {
    warn(opts, `already initialized at ${configPath}`);
    return 0;
  }

  const registry = createCliRegistry();
  const detections = await detectProviders(registry.all(), root);
  const forcedProviders = opts.providers
    ? new Set<ProviderId>(opts.providers)
    : undefined;
  const rows = makeProbeRows(detections, forcedProviders);

  printProbeReport(opts, rows);

  const activeProviders = forcedProviders
    ? [...forcedProviders]
    : rows.filter((row) => row.status === "active").map((row) => row.id);
  const anyProviderDetected = rows.some(
    (row) => row.installed || row.hasMemory,
  );

  if (!anyProviderDetected && activeProviders.length === 0) {
    warn(opts, "no providers detected, run with --providers <list> to force");
    return 4;
  }

  const config = defaultConfig(activeProviders);
  for (const row of rows) {
    if (row.status === "orphan") {
      config.providers[row.id].include_orphan = true;
    }

    if (forcedProviders?.has(row.id) && row.hasMemory && !row.installed) {
      config.providers[row.id].include_orphan = true;
    }
  }

  await saveConfig(mementoDir, config);
  if (opts.contextMode !== "global") {
    await updateGitignore(root);
  }

  success(
    opts,
    `Initialized memento at ${configPath}. Run \`memento sync\` to perform first sync.`,
  );
  return 0;
}

async function detectProviders(
  adapters: ProviderAdapter[],
  cwd: string,
): Promise<Array<{ adapter: ProviderAdapter; detect: DetectResult }>> {
  return Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      detect: await adapter.detect(cwd),
    })),
  );
}

function makeProbeRows(
  detections: Array<{ adapter: ProviderAdapter; detect: DetectResult }>,
  forcedProviders: Set<ProviderId> | undefined,
): ProbeRow[] {
  return detections.map(({ adapter, detect }) => {
    const orphan = !detect.installed && detect.hasMemory;
    const forced = forcedProviders?.has(adapter.id) ?? false;
    const status: ProviderStatus = forced
      ? "forced"
      : orphan
        ? "orphan"
        : detect.installed || detect.active
          ? "active"
          : "skipped";

    return {
      id: adapter.id,
      displayName: adapter.displayName,
      installed: detect.installed,
      hasMemory: detect.hasMemory,
      activeTiers: detect.activeTiers,
      installStatus: detect.probe.installStatus,
      status,
      hint: detect.probe.hint,
    };
  });
}

async function updateGitignore(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".gitignore");
  const existing = (await readText(gitignorePath)) ?? "";
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = gitignoreEntries.filter((entry) => !existingLines.has(entry));

  if (missing.length === 0) {
    return;
  }

  const prefix =
    existing.length === 0 || existing.endsWith("\n")
      ? existing
      : `${existing}\n`;
  const content = `${prefix}${missing.join("\n")}\n`;
  const tmpPath = `${gitignorePath}.${process.pid}.${Date.now()}.tmp`;

  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, gitignorePath);
}

function printProbeReport(opts: InitOpts, rows: ProbeRow[]): void {
  if (opts.quiet) {
    return;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        type: "init.probeReport",
        providers: rows,
      })}\n`,
    );
    return;
  }

  if (process.stdout.isTTY) {
    process.stdout.write(`${formatTtyReport(rows)}\n`);
    return;
  }

  process.stdout.write(`${formatTabReport(rows)}\n`);
}

function formatTtyReport(rows: ProbeRow[]): string {
  const header = ["Provider", "Installed", "Memory", "Tiers", "Status"];
  const body = rows.map((row) => [
    row.displayName,
    row.installed ? "yes" : "no",
    row.hasMemory ? "yes" : "no",
    row.activeTiers.length > 0 ? row.activeTiers.join(",") : "-",
    row.status,
  ]);
  const widths = header.map((value, index) =>
    Math.max(value.length, ...body.map((row) => row[index]?.length ?? 0)),
  );
  const line = (columns: string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index] ?? column.length))
      .join("  ");

  return [
    "Provider probe report",
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
  ].join("\n");
}

function formatTabReport(rows: ProbeRow[]): string {
  return [
    ["provider", "installed", "hasMemory", "tiers", "status"].join("\t"),
    ...rows.map((row) =>
      [
        row.id,
        String(row.installed),
        String(row.hasMemory),
        row.activeTiers.join(","),
        row.status,
      ].join("\t"),
    ),
  ].join("\n");
}

function warn(opts: InitOpts, message: string): void {
  if (opts.quiet) {
    return;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ type: "warning", level: "warn", message })}\n`,
    );
    return;
  }

  process.stderr.write(`warn ${message}\n`);
}

function success(opts: InitOpts, message: string): void {
  if (opts.quiet) {
    return;
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ type: "init.success", message })}\n`,
    );
    return;
  }

  process.stdout.write(`${message}\n`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
