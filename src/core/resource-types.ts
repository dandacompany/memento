import type { MemoryDoc, ProviderId, Tier } from "./types.js";

export type ResourceKind = "memory" | "skill" | "mcp";

export type ResourceScope = "local" | "project" | "cross-cli";

export type ResourceSourceFormat =
  | "markdown"
  | "json"
  | "toml"
  | "directory";

export interface ResourceFile {
  relativePath: string;
  contentHash: string;
  content?: string;
  binary: boolean;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "http" | "unknown";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  providerFields?: Record<string, unknown>;
}

export type StructuredResourceBody =
  | { type: "skill-bundle"; files: ResourceFile[] }
  | { type: "mcp-server"; server: McpServerConfig };

export interface RedactionSpan {
  path: string;
  reason: "secret-key-name" | "secret-value-pattern" | "url-query" | "header";
  preview: string;
}

export interface ResourceDoc {
  kind: ResourceKind;
  body: string | StructuredResourceBody;
  meta: {
    provider: ProviderId;
    scope: ResourceScope;
    tier: Tier;
    identityKey: string;
    sourcePath: string;
    sourceFormat: ResourceSourceFormat;
    sensitive: boolean;
    redactions: RedactionSpan[];
    mtime: number;
    bodyHash: string;
    rawHash: string;
    title?: string;
    tags?: string[];
    writeable?: boolean;
  };
}

export interface ResourceGroup {
  key: string;
  kind: ResourceKind;
  scope: ResourceScope;
  docs: ResourceDoc[];
}

export function memoryDocToResourceDoc(
  doc: MemoryDoc,
  scope: ResourceScope = "project",
): ResourceDoc {
  return {
    kind: "memory",
    body: doc.body,
    meta: {
      provider: doc.meta.source,
      scope,
      tier: doc.meta.tier,
      identityKey: doc.meta.identityKey,
      sourcePath: doc.meta.sourcePath,
      sourceFormat: "markdown",
      sensitive: false,
      redactions: [],
      mtime: doc.meta.mtime,
      bodyHash: doc.meta.bodyHash,
      rawHash: doc.meta.rawHash,
      title: doc.meta.title,
      tags: doc.meta.tags,
      writeable: true,
    },
  };
}
