import type {
  ResourceDoc,
  ResourceKind,
  ResourceScope,
} from "./resource-types.js";

export function resourceGroupKey(input: {
  kind: ResourceKind;
  scope: ResourceScope;
  identityKey: string;
}): string {
  return `${input.kind}/${input.scope}/${input.identityKey}`;
}

export function resourceGroupKeyForDoc(doc: ResourceDoc): string {
  return resourceGroupKey({
    kind: doc.kind,
    scope: doc.meta.scope,
    identityKey: doc.meta.identityKey,
  });
}

export function normalizeResourceSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
