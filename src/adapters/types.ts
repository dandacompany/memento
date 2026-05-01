import type { MemoryDoc, ProviderId, Tier } from "../core/types.js";
import type {
  ResourceDoc,
  ResourceKind,
  ResourceScope,
} from "../core/resource-types.js";

export interface ProbeResult {
  installStatus: "installed" | "not-installed" | "unknown";
  binaryPath?: string;
  appPath?: string;
  configDirPath?: string;
  version?: string;
  hint?: string;
}

export interface DetectResult {
  installed: boolean;
  hasMemory: boolean;
  active: boolean;
  activeTiers: Tier[];
  probe: ProbeResult;
}

export interface TierPaths {
  project: string[];
  "project-local": string[];
  global: string[];
}

export interface WriteReport {
  written: string[];
  skipped: string[];
}

export interface ResourceCapability {
  kind: ResourceKind;
  scopes: ResourceScope[];
  readable: boolean;
  writeable: boolean;
  experimental?: boolean;
}

export interface ResourceWriteReport {
  written: string[];
  skipped: string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  probe(): Promise<ProbeResult>;
  paths(cwd: string): TierPaths;
  detect(cwd: string): Promise<DetectResult>;
  read(tier: Tier): Promise<MemoryDoc[]>;
  write(tier: Tier, docs: MemoryDoc[]): Promise<WriteReport>;
  resourceCapabilities?(): ResourceCapability[];
  resourceWatchPaths?(
    cwd: string,
    scope: ResourceScope,
    kinds: ResourceKind[],
  ): string[];
  readResources?(
    kind: ResourceKind,
    scope: ResourceScope,
  ): Promise<ResourceDoc[]>;
  writeResources?(
    kind: ResourceKind,
    scope: ResourceScope,
    docs: ResourceDoc[],
  ): Promise<ResourceWriteReport>;
}
