#!/usr/bin/env node
/**
 * Prints the advertised-versus-served census — Note № 03 — from committed
 * state, with no network.
 *
 * Same contract as `bin/fleet.js`, and for the same reason: the page tells a
 * reader they can clone the repository and reproduce every number on it, and
 * that sentence is only true if this file exists, reads the same state, and
 * calls the same function the page calls. There is no second implementation
 * here to drift out of agreement with the first.
 *
 *   node bin/advertised.js            the table, as the page prints it
 *   node bin/advertised.js --json     the object the site publishes as advertised.json
 *   node bin/advertised.js <id>       one endpoint, every divergence in full
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "../src/lib/store.js";
import { advertisedCensus } from "../src/lib/advertised.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = new Store(join(ROOT, "state"));
const servers = store.listServers();

if (servers.length === 0) {
  console.error("no state to read — run `node bin/pulse.js` first, or clone a repository that has state/ in it");
  process.exit(1);
}

const argv = process.argv.slice(2);
const census = advertisedCensus(servers, store.readMeta().lastRunAt ?? null);

if (argv.includes("--json")) {
  console.log(JSON.stringify(census, null, 2));
  process.exit(0);
}

const one = argv.find((a) => !a.startsWith("-"));
if (one) {
  const row = census.rows.find((r) => r.id === one);
  if (!row) {
    console.error(`no endpoint ${one} in state/`);
    process.exit(1);
  }
  console.log(`${row.id}  ${row.state}${row.vouched === false ? "  UNVOUCHED" : ""}`);
  console.log(`card ${row.cardUrl ?? "—"} (${row.cardStatus})`);
  if (row.comparable) console.log(`advertises ${row.advertisedCount} tool(s), serves ${row.servedCount}`);
  for (const d of row.divergences) {
    console.log(`\n  ${d.kind}${d.tool ? ` — ${d.tool}` : ""}`);
    for (const c of d.changes ?? []) {
      console.log(`    ${c.path} (${c.kind})`);
      console.log(`      advertised: ${c.advertised ?? "(absent)"}`);
      console.log(`      served:     ${c.served ?? "(absent)"}`);
    }
    if (d.kind === "endpoint_mismatch") {
      console.log(`    card names: ${d.advertised.join(", ")}`);
      console.log(`    read from:  ${d.served}`);
    }
  }
  process.exit(0);
}

console.log(`${census.total} tracked endpoints`);
for (const [state, n] of Object.entries(census.states)) console.log(`  ${String(n).padStart(3)}  ${state}`);
console.log(
  `\n${census.diverging} of ${census.comparable} endpoints that publish a tool list disagree with what they serve\n`,
);
for (const [kind, n] of Object.entries(census.byKind)) {
  if (n) console.log(`  ${String(n).padStart(3)}  ${kind}`);
}
console.log("\nby platform:");
for (const [platform, n] of Object.entries(census.byPlatform)) console.log(`  ${String(n).padStart(3)}  ${platform}`);

console.log();
for (const row of census.rows) {
  if (row.state !== "diverges") continue;
  const kinds = [...new Set(row.divergences.map((d) => d.kind))].join(",");
  const tools = row.divergences.filter((d) => d.tool).map((d) => d.tool);
  console.log(`  ${row.id.padEnd(26)} ${kinds.padEnd(46)} ${[...new Set(tools)].join(" ")}`);
}
if (census.unvouched.length) console.log(`\nunvouched (card or contract read off the declared host): ${census.unvouched.join(", ")}`);
