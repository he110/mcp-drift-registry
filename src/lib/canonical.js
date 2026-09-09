import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace.
 *
 * This is the whole basis of the registry. If canonicalisation is not stable,
 * every run reports drift that did not happen, and the product becomes noise —
 * the failure mode that killed the previous product line (docs/critic).
 * Arrays keep their order: in a JSON Schema, `required: [a, b]` and
 * `required: [b, a]` are semantically equal but we deliberately do not reorder,
 * because a server that reshuffles its arrays IS changing its wire output.
 * Instead we report array reordering as a distinct, lower-severity event.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** Short, stable content fingerprint. 16 hex chars is plenty for a registry. */
export function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}
