export type Tier = "project" | "project-local" | "global";

export type Subtype = "agents-md" | "rule" | "skill" | "memory-bank";

export type ProviderId =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "antigravity"
  | "cursor"
  | "windsurf";

export interface MemoryDoc {
  body: string;
  meta: {
    tier: Tier;
    identityKey: string;
    subtype: Subtype;
    source: ProviderId;
    sourcePath: string;
    mtime: number;
    bodyHash: string;
    rawHash: string;
    frontmatter?: Record<string, unknown>;
    title?: string;
    tags?: string[];
  };
}

export interface ConflictGroup {
  key: string;
  candidates: MemoryDoc[];
  cachePrev?: {
    bodyHash: string;
    mtime: number;
  };
}

export type ResolveStrategy = "lww" | "prompt" | "fail";

export interface MementoConfig {
  providers: Record<
    ProviderId,
    {
      enabled: boolean;
      auto: boolean;
      include_orphan?: boolean;
    }
  >;
  mapping?: Record<string, string[]>;
  exclude?: {
    paths: string[];
  };
}
