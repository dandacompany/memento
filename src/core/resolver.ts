import { ConflictError } from "./errors.js";
import type { ConflictGroup, MemoryDoc, ResolveStrategy } from "./types.js";

export interface ResolveOptions {
  strategy: ResolveStrategy;
  isTTY: boolean;
  promptUser?: (group: ConflictGroup) => Promise<MemoryDoc | null>;
}

export interface ResolveResult {
  doc: MemoryDoc | null;
  status:
    | "identical"
    | "propagated"
    | "lww-resolved"
    | "prompt-resolved"
    | "skipped"
    | "conflict-failed";
}

interface CachePrev {
  bodyHash: string;
  mtime: number;
}

function maxByMtime(docs: MemoryDoc[]): MemoryDoc {
  const first = docs[0];
  if (!first) {
    throw new ConflictError(
      [buildConflictGroup(docs, undefined)],
      "Cannot resolve an empty conflict group",
    );
  }

  return docs.reduce(
    (winner, doc) => (doc.meta.mtime > winner.meta.mtime ? doc : winner),
    first,
  );
}

function buildConflictGroup(
  docs: MemoryDoc[],
  cachePrev: CachePrev | undefined,
): ConflictGroup {
  const first = docs[0];
  const key = first
    ? `${first.meta.tier}/${first.meta.identityKey}`
    : "unknown";

  return {
    key,
    candidates: docs,
    ...(cachePrev ? { cachePrev } : {}),
  };
}

export async function resolveGroup(
  docs: MemoryDoc[],
  cachePrev: CachePrev | undefined,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const uniqueBodyHashes = new Set(docs.map((doc) => doc.meta.bodyHash));

  if (uniqueBodyHashes.size === 1) {
    return {
      doc: docs[0] ?? null,
      status: "identical",
    };
  }

  if (cachePrev) {
    const changedDocs = docs.filter(
      (doc) => doc.meta.bodyHash !== cachePrev.bodyHash,
    );
    const changedBodyHashes = new Set(
      changedDocs.map((doc) => doc.meta.bodyHash),
    );

    if (changedDocs.length > 0 && changedBodyHashes.size === 1) {
      return {
        doc: maxByMtime(changedDocs),
        status: "propagated",
      };
    }
  }

  const group = buildConflictGroup(docs, cachePrev);

  if (opts.strategy === "fail") {
    throw new ConflictError([group]);
  }

  if (opts.strategy === "prompt" && opts.isTTY && opts.promptUser) {
    const doc = await opts.promptUser(group);

    return doc
      ? {
          doc,
          status: "prompt-resolved",
        }
      : {
          doc: null,
          status: "skipped",
        };
  }

  return {
    doc: maxByMtime(docs),
    status: "lww-resolved",
  };
}
