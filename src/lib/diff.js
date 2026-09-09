import { canonicalize, canonicalJson } from "./canonical.js";

/**
 * Deep structural diff over canonicalised JSON.
 * Returns a flat list of {op, path, from, to} with `path` as an array of keys.
 */
export function deepDiff(a, b, path = []) {
  const A = canonicalize(a);
  const B = canonicalize(b);
  if (canonicalJson(A) === canonicalJson(B)) return [];

  const bothObjects =
    A && B && typeof A === "object" && typeof B === "object" &&
    Array.isArray(A) === Array.isArray(B);

  if (!bothObjects) return [{ op: "change", path, from: A, to: B }];

  if (Array.isArray(A)) {
    // Arrays in JSON Schema are mostly sets (`required`, `enum`). Comparing them
    // as sets gives a far more useful answer than index-by-index.
    const setA = new Set(A.map((v) => canonicalJson(v)));
    const setB = new Set(B.map((v) => canonicalJson(v)));
    const out = [];
    for (const v of setA) if (!setB.has(v)) out.push({ op: "remove", path, from: JSON.parse(v), to: undefined });
    for (const v of setB) if (!setA.has(v)) out.push({ op: "add", path, from: undefined, to: JSON.parse(v) });
    if (out.length === 0) out.push({ op: "reorder", path, from: A, to: B });
    return out;
  }

  const out = [];
  for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const inA = Object.hasOwn(A, key);
    const inB = Object.hasOwn(B, key);
    if (inA && !inB) out.push({ op: "remove", path: [...path, key], from: A[key], to: undefined });
    else if (!inA && inB) out.push({ op: "add", path: [...path, key], from: undefined, to: B[key] });
    else out.push(...deepDiff(A[key], B[key], [...path, key]));
  }
  return out.sort((x, y) => x.path.join("/").localeCompare(y.path.join("/")));
}

const COSMETIC_KEYS = new Set(["description", "title", "examples", "$comment", "default"]);

/**
 * Severity is the product. An agent author does not need to know that a
 * description was reworded; they need to know that an argument they pass is
 * gone, or that a field they never sent is now required.
 */
export function classifyChange(change) {
  const path = change.path;
  const last = path[path.length - 1];
  const parent = path[path.length - 2];

  if (parent === "required" || last === "required") {
    return change.op === "add"
      ? { severity: "breaking", kind: "required_added" }
      : { severity: "additive", kind: "required_removed" };
  }
  if (parent === "properties") {
    if (change.op === "remove") return { severity: "breaking", kind: "param_removed" };
    if (change.op === "add") return { severity: "additive", kind: "param_added" };
  }
  if (last === "type") return { severity: "breaking", kind: "type_changed" };
  if (last === "enum" || parent === "enum") {
    return change.op === "remove"
      ? { severity: "breaking", kind: "enum_value_removed" }
      : { severity: "additive", kind: "enum_value_added" };
  }
  if (COSMETIC_KEYS.has(last)) return { severity: "cosmetic", kind: "text_changed" };
  if (change.op === "reorder") return { severity: "cosmetic", kind: "reordered" };
  if (change.op === "remove") return { severity: "breaking", kind: "field_removed" };
  if (change.op === "add") return { severity: "additive", kind: "field_added" };
  return { severity: "breaking", kind: "value_changed" };
}

const RANK = { cosmetic: 0, additive: 1, breaking: 2 };

export function worstSeverity(severities) {
  return severities.reduce(
    (worst, s) => (RANK[s] > RANK[worst] ? s : worst),
    "cosmetic",
  );
}

export function formatPath(path) {
  return path.length ? path.join(".") : "(root)";
}

/**
 * Diff two tool records. Beyond the raw changes it answers the one question
 * that no RSS feed and no changelog can answer: did the machine-readable
 * contract move while the human-readable text stayed identical?
 */
export function diffTool(prev, next) {
  const schemaChanges = deepDiff(prev.inputSchema ?? {}, next.inputSchema ?? {})
    .map((c) => ({ ...c, ...classifyChange(c) }));
  const descriptionChanged = (prev.description ?? "") !== (next.description ?? "");
  const contractChanges = schemaChanges.filter((c) => c.severity !== "cosmetic");

  return {
    schemaChanges,
    descriptionChanged,
    /** The signal this registry exists for. */
    silent: contractChanges.length > 0 && !descriptionChanged,
    severity: worstSeverity(
      schemaChanges.map((c) => c.severity).concat(descriptionChanged ? ["cosmetic"] : []),
    ),
    changed: schemaChanges.length > 0 || descriptionChanged,
  };
}
