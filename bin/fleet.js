#!/usr/bin/env node
/**
 * Prints the fleet census — Note № 02 — from committed state, with no network.
 *
 * The page says a reader can clone the repository and reproduce every number on
 * it. That sentence is only worth printing if this file exists and reads the
 * same state through the same function the page does, so it calls
 * `fleetCensus()` and formats the result: there is no second implementation to
 * drift out of agreement with the first.
 *
 *   node bin/fleet.js            the table, as the page prints it
 *   node bin/fleet.js --json     the same object the site publishes as fleet.json
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/lib/store.js";
import { fleetCensus } from "../src/publish/fleet.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = new Store(join(ROOT, "state"));
const servers = store.listServers();

if (servers.length === 0) {
  console.error("no state to read — run `node bin/pulse.js` first, or clone a repository that has state/ in it");
  process.exit(1);
}

const f = fleetCensus(servers);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(f, null, 2));
  process.exit(0);
}

const variantOf = new Map(f.variants.map((v, i) => [v.fingerprint, i + 1]));

console.log(`${f.total} of ${servers.length} tracked endpoints run the ${f.platform ?? "shared"} template`);
console.log(`${f.variants.length} distinct search_* schema${f.variants.length === 1 ? "" : "s"} among them\n`);

for (const [i, v] of f.variants.entries()) {
  const extra = v.optional.length ? v.optional.join(", ") : "(required only)";
  console.log(`  V${i + 1}  ${String(v.tenants).padStart(3)}  ${v.fingerprint ?? "—"}  ${extra}`);
}

const cp = f.crossProduct;
console.log(
  `\n2^${f.optionalUnion.length} = ${cp.expected} combinations of [${f.optionalUnion.join(", ")}], ${cp.observed} live — ` +
    (cp.complete ? "complete, no remainder" : `${cp.missing.length} unused, ${cp.collisions.length} collision(s)`),
);
console.log(
  `every variant requires [${(f.invariants.required ?? []).join(", ")}]` +
    `, additionalProperties=${JSON.stringify(f.invariants.additionalProperties)}\n`,
);

for (const t of f.tenants) {
  const mark = f.unvouched.includes(t.id) ? " UNVOUCHED" : "";
  console.log(`  V${variantOf.get(t.fingerprint) ?? "?"}  ${t.id.padEnd(28)} ${(t.optional.join(",") || "—").padEnd(18)} ${t.host ?? ""}${mark}`);
}

for (const [kind, ids] of Object.entries(f.anomalies)) {
  if (ids.length) console.log(`\n${kind}: ${ids.join(", ")}`);
}
