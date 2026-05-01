import { promises as fs } from "node:fs";

import * as TOML from "@iarna/toml";

import { atomicWrite, sha256Hex, statMtime } from "../adapters/shared/io.js";
import type { ResourceWriteReport } from "../adapters/types.js";
import { normalizeResourceSlug } from "../core/resource-identity.js";
import type {
  McpServerConfig,
  RedactionSpan,
  ResourceDoc,
  ResourceScope,
} from "../core/resource-types.js";
import type { ProviderId, Tier } from "../core/types.js";

export type McpRootFormat = "json" | "toml";

export interface McpRoot {
  path: string;
  provider: ProviderId;
  scope: ResourceScope;
  tier: Tier;
  format: McpRootFormat;
  writeable?: boolean;
}

type McpServerResourceDoc = ResourceDoc & {
  body: { type: "mcp-server"; server: McpServerConfig };
};

export async function readMcpResources(
  roots: McpRoot[],
): Promise<ResourceDoc[]> {
  const docs: ResourceDoc[] = [];

  for (const root of roots) {
    const raw = await readText(root.path);

    if (raw === null) {
      continue;
    }

    const parsed = parseConfig(raw, root.format);
    const servers = isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed.mcp_servers)
        ? parsed.mcp_servers
        : {};
    const mtime = (await statMtime(root.path)) ?? 0;

    for (const [name, value] of Object.entries(servers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!isRecord(value)) {
        continue;
      }

      const server = normalizeServer(name, value);
      const bodyHash = sha256Hex(stableStringify(server));

      docs.push({
        kind: "mcp",
        body: {
          type: "mcp-server",
          server,
        },
        meta: {
          provider: root.provider,
          scope: root.scope,
          tier: root.tier,
          identityKey: `mcp:${normalizeResourceSlug(name)}`,
          sourcePath: root.path,
          sourceFormat: root.format,
          sensitive: redactionsFor(server).length > 0,
          redactions: redactionsFor(server),
          mtime,
          bodyHash,
          rawHash: bodyHash,
          title: name,
          writeable: root.writeable ?? true,
        },
      });
    }
  }

  return docs;
}

export async function writeMcpResources(
  roots: McpRoot[],
  docs: ResourceDoc[],
): Promise<ResourceWriteReport> {
  const written: string[] = [];
  const skipped: string[] = [];
  const writesByRoot = new Map<McpRoot, McpServerResourceDoc[]>();

  for (const doc of docs) {
    const root = selectWritableRoot(roots, doc);

    if (!root || !isMcpServerDoc(doc)) {
      skipped.push(doc.meta.sourcePath);
      continue;
    }

    const pending = writesByRoot.get(root) ?? [];
    pending.push(doc);
    writesByRoot.set(root, pending);
  }

  for (const [root, pending] of writesByRoot) {
    const raw = await readText(root.path);
    const config = raw === null ? {} : parseConfig(raw, root.format);
    const serverTableKey = root.format === "toml" ? "mcp_servers" : "mcpServers";
    const servers = isRecord(config[serverTableKey])
      ? { ...config[serverTableKey] }
      : {};

    for (const doc of pending) {
      const server = doc.body.server;
      servers[server.name] = denormalizeServer(root.provider, server);
    }

    const nextConfig = {
      ...config,
      [serverTableKey]: servers,
    };
    const serialized =
      root.format === "toml"
        ? stringifyToml(nextConfig)
        : `${JSON.stringify(nextConfig, null, 2)}\n`;

    await atomicWrite(root.path, serialized);
    written.push(root.path);
  }

  return { written, skipped };
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

function parseConfig(raw: string, format: McpRootFormat): Record<string, unknown> {
  const parsed: unknown =
    format === "toml" ? TOML.parse(raw) : (JSON.parse(raw) as unknown);

  return isRecord(parsed) ? parsed : {};
}

function stringifyToml(value: unknown): string {
  return (TOML.stringify as (input: unknown) => string)(value);
}

function normalizeServer(name: string, value: Record<string, unknown>): McpServerConfig {
  const url = stringValue(value.url) ?? stringValue(value.serverUrl);
  const command = stringValue(value.command);
  const known = new Set([
    "command",
    "args",
    "env",
    "url",
    "serverUrl",
    "headers",
    "enabled",
  ]);
  const providerFields = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );

  return {
    name,
    transport: command ? "stdio" : url ? "sse" : "unknown",
    command,
    args: stringArray(value.args),
    env: stringRecord(value.env),
    url,
    headers: stringRecord(value.headers),
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    providerFields:
      Object.keys(providerFields).length > 0 ? providerFields : undefined,
  };
}

function denormalizeServer(
  provider: ProviderId,
  server: McpServerConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...(server.providerFields ?? {}),
  };

  if (server.command) {
    result.command = server.command;
  }

  if (server.args) {
    result.args = server.args;
  }

  if (server.env) {
    result.env = server.env;
  }

  if (server.url) {
    result[provider === "windsurf" ? "serverUrl" : "url"] = server.url;
  }

  if (server.headers) {
    result.headers = server.headers;
  }

  if (server.enabled !== undefined) {
    result.enabled = server.enabled;
  }

  return result;
}

function selectWritableRoot(
  roots: McpRoot[],
  doc: ResourceDoc,
): McpRoot | undefined {
  return (
    roots.find((root) => root.writeable !== false && root.tier === doc.meta.tier) ??
    roots.find((root) => root.writeable !== false)
  );
}

function isMcpServerDoc(
  doc: ResourceDoc,
): doc is McpServerResourceDoc {
  return (
    doc.kind === "mcp" &&
    typeof doc.body === "object" &&
    doc.body.type === "mcp-server"
  );
}

function redactionsFor(server: McpServerConfig): RedactionSpan[] {
  const spans: RedactionSpan[] = [];

  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (isSecretKey(key)) {
      spans.push({
        path: `env.${key}`,
        reason: "secret-key-name",
        preview: preview(value),
      });
    }
  }

  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (isSecretKey(key) || key.toLowerCase() === "authorization") {
      spans.push({
        path: `headers.${key}`,
        reason: "header",
        preview: preview(value),
      });
    }
  }

  return spans;
}

function isSecretKey(key: string): boolean {
  return /(token|secret|key|password|authorization)/i.test(key);
}

function preview(value: string): string {
  if (value.length <= 6) {
    return "***";
  }

  return `${value.slice(0, 3)}...${value.slice(-2)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.every((item) => typeof item === "string") ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);

  return entries.every(([, entryValue]) => typeof entryValue === "string")
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
