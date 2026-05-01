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
  default_scope?: "local" | "project" | "cross-cli";
  default_resources?: ("memory" | "skill" | "mcp")[];
  resources?: {
    memory?: {
      enabled: boolean;
    };
    skill?: {
      enabled: boolean;
      include: string[];
      exclude: string[];
    };
    mcp?: {
      enabled: boolean;
      redact_output: boolean;
      project_secret_policy: "wizard" | "fail" | "placeholder" | "env";
    };
  };
  providers: Record<
    ProviderId,
    {
      enabled: boolean;
      auto: boolean;
      include_orphan?: boolean;
      resources?: Partial<
        Record<
          "memory" | "skill" | "mcp",
          {
            enabled: boolean;
            write: boolean;
            experimental?: boolean;
          }
        >
      >;
    }
  >;
  mapping?: Record<string, string[]>;
  exclude?: {
    paths: string[];
  };
}
