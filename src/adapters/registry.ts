import path from "node:path";

import type { MemoryDoc, ProviderId } from "../core/types.js";
import type { ProviderAdapter } from "./types.js";

function canonicalPath(filePath: string): string {
  return path.resolve(filePath);
}

export class AdapterRegistry {
  private adapters: Map<ProviderId, ProviderAdapter> = new Map();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  async activeAdapters(cwd: string): Promise<ProviderAdapter[]> {
    const adapters = this.all();
    const detections = await Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        detect: await adapter.detect(cwd),
      })),
    );

    return detections
      .filter(({ detect }) => detect.active)
      .map(({ adapter }) => adapter);
  }

  sharedGlobalPaths(): Map<string, ProviderId[]> {
    const providersByPath = new Map<string, Set<ProviderId>>();

    for (const adapter of this.all()) {
      for (const globalPath of adapter.paths(process.cwd()).global) {
        const canonical = canonicalPath(globalPath);
        const providers =
          providersByPath.get(canonical) ?? new Set<ProviderId>();
        providers.add(adapter.id);
        providersByPath.set(canonical, providers);
      }
    }

    const sharedPaths = new Map<string, ProviderId[]>();
    for (const [globalPath, providers] of providersByPath) {
      if (providers.size < 2) {
        continue;
      }

      sharedPaths.set(globalPath, [...providers].sort());
    }

    return sharedPaths;
  }

  dedupeSharedGlobal(docs: MemoryDoc[]): MemoryDoc[] {
    const docsByPath = new Map<string, MemoryDoc[]>();

    for (const doc of docs) {
      if (doc.meta.tier !== "global") {
        continue;
      }

      const canonical = canonicalPath(doc.meta.sourcePath);
      const docsForPath = docsByPath.get(canonical) ?? [];
      docsForPath.push(doc);
      docsByPath.set(canonical, docsForPath);
    }

    const selectedByPath = new Map<string, MemoryDoc>();
    for (const [sourcePath, docsForPath] of docsByPath) {
      if (docsForPath.length < 2) {
        continue;
      }

      selectedByPath.set(
        sourcePath,
        [...docsForPath].sort((a, b) =>
          a.meta.source.localeCompare(b.meta.source),
        )[0],
      );
    }

    const emittedPaths = new Set<string>();

    return docs.filter((doc) => {
      if (doc.meta.tier !== "global") {
        return true;
      }

      const canonical = canonicalPath(doc.meta.sourcePath);
      const selected = selectedByPath.get(canonical);
      if (!selected) {
        return true;
      }

      if (emittedPaths.has(canonical)) {
        return false;
      }

      if (doc !== selected) {
        return false;
      }

      emittedPaths.add(canonical);
      return true;
    });
  }
}

export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}
