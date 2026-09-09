#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store, readJson } from "../src/lib/store.js";
import { mapLimit } from "../src/lib/http.js";
import { collectMcpServer } from "../src/sources/mcp.js";
import { checkCanary } from "../src/sources/canary.js";
import { buildEvents } from "../src/lib/events.js";
import { trackReachability } from "../src/lib/flap.js";
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
  const config = readJson(join(ROOT, "servers.json"), { servers: [] });

  if (PUBLISH_ONLY) {
    publish({ store, outDir: join(ROOT, "site"), config, at });
    console.log("published from existing state");
    return;
  }

  console.log(`pulse ${at} — ${config.servers.length} servers`);

  const results = await mapLimit(config.servers, 6, (s) => collectMcpServer(s));

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

  const meta = store.readMeta();
  const canary = await checkCanary(meta.canary, at);
  const nextMeta = {
    firstRunAt: meta.firstRunAt ?? at,
    lastRunAt: at,
    runs: (meta.runs ?? 0) + 1,
    serversTotal: config.servers.length,
    serversOk: okCount,
    serversUnstable: unstableCount,
    canary,
  };

  console.log(
    `  canary ${canary.healthy ? "healthy" : "UNHEALTHY"}` +
      (canary.error ? ` — ${canary.error}` : ` (last change ${canary.lastChangeAt})`),
  );
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

main().catch((err) => {
  console.error("pulse failed:", err);
  process.exit(1);
});
