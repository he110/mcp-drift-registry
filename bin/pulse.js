#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store, readJson, writeJson } from "../src/lib/store.js";
import { mapLimit } from "../src/lib/http.js";
import { collectMcpServer } from "../src/sources/mcp.js";
import { checkCanary } from "../src/sources/canary.js";
import { buildEvents } from "../src/lib/events.js";
import { trackReachability } from "../src/lib/flap.js";
import { abandoned, applyAdmissions, describeProgress, foldProbe } from "../src/lib/admission.js";
import { buildProvenance } from "../src/lib/provenance.js";
import { publish } from "../src/publish/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const PUBLISH_ONLY = args.has("--publish-only");

/**
 * One pulse of the pipeline: collect -> diff -> record -> publish.
 *
 * Idempotent by construction. The baseline is the last committed snapshot, so a
 * skipped or delayed cron firing costs latency and nothing else. Running twice
 * in a row produces no events the second time.
 */
async function main() {
  const at = new Date().toISOString();
  const store = new Store(join(ROOT, "state"));
  const configPath = join(ROOT, "servers.json");
  let config = readJson(configPath, { servers: [] });

  if (PUBLISH_ONLY) {
    publish({ store, outDir: join(ROOT, "site"), config, at });
    console.log("published from existing state");
    return;
  }

  console.log(`pulse ${at} — ${config.servers.length} servers`);

  const results = await mapLimit(config.servers, 6, (s) => collectMcpServer(s, at));

  const allEvents = [];
  let okCount = 0;
  let unstableCount = 0;

  for (const [index, result] of results.entries()) {
    const declared = config.servers[index];
    const next = result.ok
      ? result.value
      : {
          id: declared.id,
          name: declared.name ?? declared.id,
          url: declared.url,
          platform: declared.platform ?? null,
          transport: "streamable-http",
          status: "error",
          error: String(result.error?.message ?? result.error).slice(0, 200),
          tools: [],
          toolCount: 0,
          fingerprint: null,
          protocolVersion: null,
          serverInfo: null,
          provenance: buildProvenance({ declaredUrl: declared.url, at }),
        };

    const prev = store.readServer(next.id);
    // Decide quarantine before the diff runs: a host that has bounced four
    // times in a week gets its up/down chatter dropped, its contract diffed as
    // usual, and its "ok" taken away from the headline count.
    const { transitions, unstable } = trackReachability(prev, next, at);
    const events = buildEvents(prev, next, at, { quarantined: unstable });
    allEvents.push(...events);

    // Establishing a baseline is not a change to the contract.
    const changed = events.some((e) => e.type !== "server_added");
    // A failed fetch carries no tools, and overwriting the snapshot with it
    // would erase the contract we need to diff against once the server comes
    // back. Carry the last contract that actually arrived.
    const lastGood =
      next.status === "ok"
        ? { at, tools: next.tools, fingerprint: next.fingerprint, protocolVersion: next.protocolVersion }
        : (prev?.lastGood ?? (prev?.status === "ok" && prev.tools?.length
            ? { at: prev.lastOkAt ?? prev.lastCheckedAt, tools: prev.tools, fingerprint: prev.fingerprint, protocolVersion: prev.protocolVersion }
            : null));

    const record = {
      ...next,
      lastGood,
      firstSeenAt: prev?.firstSeenAt ?? at,
      lastCheckedAt: at,
      lastOkAt: next.status === "ok" ? at : (prev?.lastOkAt ?? null),
      lastChangedAt: changed ? at : (prev?.lastChangedAt ?? null),
      changeCount: (prev?.changeCount ?? 0) + (changed ? 1 : 0),
      // Written only when there is something to say. A server that simply
      // answers every pulse keeps the same bytes on disk, so the state commit
      // stays readable instead of touching all 79 files for nothing.
      ...(transitions.length ? { reachability: transitions } : {}),
      ...(unstable ? { stability: "unstable" } : {}),
    };

    if (next.status === "ok") okCount += 1;
    if (unstable) unstableCount += 1;
    const mark = unstable ? "FLP" : next.status === "ok" ? "ok " : "ERR";
    console.log(
      `  ${mark} ${next.id.padEnd(28)} tools=${String(next.toolCount).padStart(3)} events=${events.length}` +
        (transitions.length ? ` flips=${transitions.length}` : "") +
        (next.error ? ` (${next.error.slice(0, 60)})` : ""),
    );

    if (!DRY_RUN) store.writeServer(record);
  }

  // --- candidates on trial ---------------------------------------------------
  //
  // Probed through the same collector as the registry itself, and kept strictly
  // out of it: no record under state/servers/, no event, no row, no place in any
  // count. A candidate is a claim we have not verified long enough to publish.
  const admitted = await runTrials(store, config, at);
  if (admitted.length) {
    const promoted = applyAdmissions(config, admitted);
    if (promoted !== config) {
      config = promoted;
      // Written only on an actual admission. A pulse with nothing to promote
      // does not rewrite this file, so the servers already listed in it cannot
      // be reordered or reserialised by a run that had no reason to touch them.
      if (!DRY_RUN) writeJson(configPath, config);
      console.log(`  admitted ${admitted.length}: ${admitted.join(", ")} — tracked from the next pulse`);
    }
  }

  const meta = store.readMeta();
  const canary = await checkCanary(meta.canary, at);
  const origins = await probeOrigins(config, meta.origins ?? [], at);
  const nextMeta = {
    firstRunAt: meta.firstRunAt ?? at,
    lastRunAt: at,
    runs: (meta.runs ?? 0) + 1,
    serversTotal: config.servers.length,
    serversOk: okCount,
    serversUnstable: unstableCount,
    canary,
    origins,
  };

  console.log(
    `  canary ${canary.healthy ? "healthy" : "UNHEALTHY"}` +
      (canary.error ? ` — ${canary.error}` : ` (last change ${canary.lastChangeAt})`),
  );
  for (const o of origins) {
    console.log(`  origin ${o.platform.padEnd(21)} ${o.status === "ok" ? "ok " : "ERR"} ${o.url}${o.error ? ` (${o.error.slice(0, 60)})` : ""} x${o.consecutive}`);
  }
  console.log(`  ${allEvents.length} events this pulse` + (unstableCount ? ` — ${unstableCount} server(s) quarantined for flapping` : ""));

  if (DRY_RUN) {
    for (const e of allEvents) console.log(`    [${e.severity}] ${e.server}: ${e.summary}`);
    console.log("dry run — nothing written");
    return;
  }

  store.appendEvents(allEvents);
  store.writeMeta(nextMeta);
  publish({ store, outDir: join(ROOT, "site"), config, at });
  console.log("state written, site published");
}

/**
 * One probe of every candidate still on trial, folded into the ledger.
 *
 * Returns the ids that cleared the gate on this pulse. Everything else stays a
 * candidate: no snapshot, no event, no row. Candidates that have been on trial
 * for a fortnight without clearing it stop being probed — they answered once at
 * nomination and have not held up since, which is the whole finding.
 */
async function runTrials(store, config, at) {
  const declared = config.candidates ?? [];
  if (declared.length === 0) return [];

  const ledger = store.readCandidates();
  const onTrial = declared.filter((c) => {
    const record = ledger[c.id];
    return !record?.admittedAt && !abandoned(record, at);
  });

  if (onTrial.length === 0) return [];
  console.log(`  ${onTrial.length} candidate(s) on trial`);

  const results = await mapLimit(onTrial, 6, (c) => collectMcpServer(c, at));
  const admitted = [];

  for (const [index, result] of results.entries()) {
    const candidate = onTrial[index];
    const record = foldProbe(
      ledger[candidate.id],
      candidate,
      result.ok ? result.value : { status: "error", error: String(result.error?.message ?? result.error), toolCount: 0 },
      at,
    );
    ledger[candidate.id] = record;
    if (record.admittedAt === at) admitted.push(candidate.id);
    console.log(`  try ${candidate.id.padEnd(28)} ${describeProgress(record, at)}`);
  }

  if (!DRY_RUN) store.writeCandidates(ledger);
  return admitted;
}

/**
 * The hosting platforms themselves, probed by the same collector, kept out of
 * the registry entirely.
 *
 * A platform that generates fifty tenants' contracts is not one of its own
 * tenants: it gets no record under `state/servers/`, no event, no row and no
 * place in any count. But "the generator's own endpoint could not be read while
 * every endpoint it generates answered" is a fact about the fleet that no
 * tenant's record contains, so it is recorded here — with a streak, so the page
 * can say how long it has been true instead of implying it is permanent.
 */
async function probeOrigins(config, previous, at) {
  const declared = config.origins ?? [];
  if (declared.length === 0) return [];

  const before = new Map(previous.map((o) => [o.platform, o]));
  const results = await mapLimit(declared, 3, (o) => collectMcpServer(o, at));

  return declared.map((origin, index) => {
    const probe = results[index].ok
      ? results[index].value
      : { status: "error", error: String(results[index].error?.message ?? results[index].error).slice(0, 200), provenance: null };
    const prev = before.get(origin.platform);
    const same = prev?.status === probe.status;
    return {
      platform: origin.platform,
      url: origin.url,
      status: probe.status,
      error: probe.error ?? null,
      toolCount: probe.toolCount ?? 0,
      at,
      since: same ? (prev.since ?? at) : at,
      consecutive: same ? (prev.consecutive ?? 1) + 1 : 1,
      provenance: probe.provenance ?? null,
    };
  });
}

main().catch((err) => {
  console.error("pulse failed:", err);
  process.exit(1);
});
