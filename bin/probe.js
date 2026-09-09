#!/usr/bin/env node
/**
 * Verifies candidate MCP endpoints before they are allowed into servers.json.
 *
 * Coverage is the only lever we have on how fast real drift shows up, so
 * candidates arrive in bulk and mostly wrong: dead hosts, stdio-only packages
 * published with a placeholder URL, servers that demand a key. Adding those
 * blind would fill the registry with permanent `error` rows that drown the
 * signal we exist to publish.
 *
 * A candidate is accepted only if it answers tools/list anonymously with at
 * least one tool, through exactly the same collector the pipeline uses — so
 * "it probed fine" and "it collects fine" cannot diverge.
 *
 *   node bin/probe.js candidates.json  [--out accepted.json] [--concurrency 8]
 *
 * Candidates: [{ id?, name?, vendor?, url, homepage? }, ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapLimit } from "../src/lib/http.js";
import { collectMcpServer } from "../src/sources/mcp.js";
import { readJson } from "../src/lib/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

if (!file) {
  console.error("usage: node bin/probe.js <candidates.json> [--out accepted.json] [--concurrency 8]");
  process.exit(2);
}

const concurrency = Number(flag("concurrency", 8));
const outFile = flag("out", null);

const config = readJson(join(ROOT, "servers.json"), { servers: [] });
const knownUrls = new Set(config.servers.map((s) => s.url));
const knownIds = new Set(config.servers.map((s) => s.id));

const raw = JSON.parse(readFileSync(file, "utf8"));
const candidates = [];
const seenUrl = new Set();

for (const c of Array.isArray(raw) ? raw : (raw.servers ?? [])) {
  if (!c?.url || knownUrls.has(c.url) || seenUrl.has(c.url)) continue;
  seenUrl.add(c.url);
  candidates.push({ ...c, id: uniqueId(c) });
}

function uniqueId(c) {
  const base = slug(c.id ?? c.name ?? new URL(c.url).hostname);
  let id = base;
  for (let n = 2; knownIds.has(id); n++) id = `${base}-${n}`;
  knownIds.add(id);
  return id;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "server";
}

console.error(`probing ${candidates.length} candidates (${(Array.isArray(raw) ? raw : raw.servers ?? []).length} submitted, rest already known or duplicate)`);

const results = await mapLimit(candidates, concurrency, (c) => collectMcpServer(c));

const accepted = [];
const rejected = [];

for (const [i, r] of results.entries()) {
  const c = candidates[i];
  const v = r.ok ? r.value : null;
  if (v && v.status === "ok" && v.toolCount > 0) {
    accepted.push({
      id: c.id,
      name: c.name ?? v.serverInfo?.name ?? c.id,
      vendor: c.vendor ?? null,
      url: c.url,
      homepage: c.homepage ?? null,
      toolCount: v.toolCount,
    });
    console.error(`  ok   ${c.id.padEnd(34)} tools=${String(v.toolCount).padStart(3)}  ${c.url}`);
  } else {
    const why = v ? `${v.status}: ${v.error ?? "no tools"}` : String(r.error?.message ?? r.error);
    rejected.push({ id: c.id, url: c.url, reason: String(why).slice(0, 160) });
  }
}

console.error(`\naccepted ${accepted.length} / ${candidates.length}`);
if (outFile) {
  writeFileSync(outFile, JSON.stringify(accepted, null, 2));
  console.error(`wrote ${outFile}`);
}
writeFileSync(join(ROOT, "probe-rejected.json"), JSON.stringify(rejected, null, 2));
