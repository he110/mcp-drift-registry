#!/usr/bin/env node
/**
 * Nominates candidate MCP endpoints for the trial that precedes the registry.
 *
 * Coverage is the only lever we have on how fast real drift shows up, so
 * candidates arrive in bulk and mostly wrong: dead hosts, stdio-only packages
 * published with a placeholder URL, servers that demand a key. Adding those
 * blind would fill the registry with permanent `error` rows that drown the
 * signal we exist to publish.
 *
 * This is a first filter, not the decision. One anonymous tools/list answer with
 * at least one tool — through exactly the same collector the pipeline uses, so
 * "it probed fine" and "it collects fine" cannot diverge — buys a place in
 * `candidates`, nothing more. Admission into `servers` is earned over 8
 * consecutive successful pulses spanning at least 48 hours, and is granted by
 * the pulse (see src/lib/admission.js). This script can no longer put a row in
 * the registry, which is the point: there is exactly one door.
 *
 *   node bin/probe.js candidates.json  [--out nominated.json] [--concurrency 8] [--dry-run]
 *
 * Candidates: [{ id?, name?, vendor?, url, homepage? }, ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapLimit } from "../src/lib/http.js";
import { collectMcpServer } from "../src/sources/mcp.js";
import { readJson, writeJson } from "../src/lib/store.js";
import { ADMISSION_PROBES, ADMISSION_SPAN_MS } from "../src/lib/admission.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

if (!file) {
  console.error("usage: node bin/probe.js <candidates.json> [--out nominated.json] [--concurrency 8] [--dry-run]");
  process.exit(2);
}

const concurrency = Number(flag("concurrency", 8));
const outFile = flag("out", null);
const dryRun = argv.includes("--dry-run");

const configPath = join(ROOT, "servers.json");
const config = readJson(configPath, { servers: [] });
const existing = [...config.servers, ...(config.candidates ?? [])];
const knownUrls = new Set(existing.map((s) => s.url));
const knownIds = new Set(existing.map((s) => s.id));

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

const nominated = [];
const rejected = [];

for (const [i, r] of results.entries()) {
  const c = candidates[i];
  const v = r.ok ? r.value : null;
  if (v && v.status === "ok" && v.toolCount > 0) {
    nominated.push({
      id: c.id,
      name: c.name ?? v.serverInfo?.name ?? c.id,
      ...(c.vendor ? { vendor: c.vendor } : {}),
      url: c.url,
      ...(c.homepage ? { homepage: c.homepage } : {}),
      ...(c.platform ? { platform: c.platform } : {}),
    });
    console.error(`  ok   ${c.id.padEnd(34)} tools=${String(v.toolCount).padStart(3)}  ${c.url}`);
  } else {
    const why = v ? `${v.status}: ${v.error ?? "no tools"}` : String(r.error?.message ?? r.error);
    rejected.push({ id: c.id, url: c.url, reason: String(why).slice(0, 160) });
  }
}

console.error(`\nnominated ${nominated.length} / ${candidates.length}`);
if (outFile) {
  writeFileSync(outFile, JSON.stringify(nominated, null, 2));
  console.error(`wrote ${outFile}`);
}
writeFileSync(join(ROOT, "probe-rejected.json"), JSON.stringify(rejected, null, 2));

// The nomination is appended to `candidates`, never to `servers`. From here the
// pulse takes over: ADMISSION_PROBES consecutive good probes spanning
// ADMISSION_SPAN_MS before any of these becomes a row.
if (nominated.length && !dryRun) {
  writeJson(configPath, { ...config, candidates: [...(config.candidates ?? []), ...nominated] });
  console.error(
    `added to candidates in servers.json — each needs ${ADMISSION_PROBES} consecutive ok probes` +
      ` spanning ${ADMISSION_SPAN_MS / 3600000}h before it joins the registry`,
  );
} else if (nominated.length) {
  console.error("dry run — servers.json not touched");
}
