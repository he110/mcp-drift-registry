import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, fingerprint } from "../src/lib/canonical.js";
import { deepDiff, diffTool, classifyChange, worstSeverity } from "../src/lib/diff.js";
import { buildEvents } from "../src/lib/events.js";
import { trackReachability, FLAP_THRESHOLD, FLAP_WINDOW_MS } from "../src/lib/flap.js";
import {
  ADMISSION_PROBES,
  ADMISSION_SPAN_MS,
  abandoned,
  admits,
  applyAdmissions,
  describeProgress,
  foldProbe,
} from "../src/lib/admission.js";
import { parseRpc } from "../src/sources/mcp.js";
import { httpJson } from "../src/lib/http.js";
import { createServer } from "node:http";
import { esc, inlineCode, isUnstable, platformFamilies, publish } from "../src/publish/render.js";
import { noteFacts, SIGNATURE } from "../src/publish/note.js";
import { fleetCensus } from "../src/publish/fleet.js";
import { DIRECT, WELL_KNOWN, buildProvenance, describeProvenance, isCardObservation, isObservation } from "../src/lib/provenance.js";
import { readCard, cardUrlFor, OFFICIAL_SCHEMA } from "../src/sources/card.js";
import { advertisedCensus, compareCard } from "../src/lib/advertised.js";
import { Store } from "../src/lib/store.js";

const AT = "2026-01-01T00:00:00.000Z";

const tool = (over = {}) => ({
  name: "search",
  description: "Search the docs.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
  ...over,
});

const server = (tools, over = {}) => ({
  id: "acme",
  name: "Acme",
  url: "https://example.invalid/mcp",
  status: "ok",
  error: null,
  protocolVersion: "2025-06-18",
  tools,
  toolCount: tools.length,
  fingerprint: fingerprint(tools),
  ...over,
});

// --- canonicalisation -------------------------------------------------------

test("canonical form ignores key order but not array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("fingerprint is stable across reserialisation", () => {
  const a = fingerprint({ x: [1, { y: "z" }], w: null });
  const b = fingerprint(JSON.parse(JSON.stringify({ w: null, x: [1, { y: "z" }] })));
  assert.equal(a, b);
});

// --- diff and severity ------------------------------------------------------

test("identical schemas produce no changes", () => {
  assert.deepEqual(deepDiff(tool().inputSchema, tool().inputSchema), []);
});

test("a newly required field is breaking", () => {
  const next = tool();
  next.inputSchema.required = ["query", "limit"];
  const d = diffTool(tool(), next);
  assert.equal(d.severity, "breaking");
  assert.ok(d.schemaChanges.some((c) => c.kind === "required_added"));
});

test("a removed parameter is breaking, an added one is not", () => {
  const removed = tool();
  delete removed.inputSchema.properties.limit;
  assert.equal(diffTool(tool(), removed).severity, "breaking");

  const added = tool();
  added.inputSchema.properties.cursor = { type: "string" };
  assert.equal(diffTool(tool(), added).severity, "additive");
});

test("a changed type is breaking", () => {
  const next = tool();
  next.inputSchema.properties.limit.type = "string";
  const d = diffTool(tool(), next);
  assert.equal(d.severity, "breaking");
  assert.ok(d.schemaChanges.some((c) => c.kind === "type_changed"));
});

test("prose-only edits are cosmetic and never breaking", () => {
  const next = tool({ description: "Search the documentation." });
  next.inputSchema.properties.query.description = "the query";
  const d = diffTool(tool(), next);
  assert.equal(d.severity, "cosmetic");
  assert.equal(d.changed, true);
});

test("enum narrowing is breaking, widening is additive", () => {
  const base = tool();
  base.inputSchema.properties.query.enum = ["a", "b"];
  const narrowed = structuredClone(base);
  narrowed.inputSchema.properties.query.enum = ["a"];
  const widened = structuredClone(base);
  widened.inputSchema.properties.query.enum = ["a", "b", "c"];
  assert.equal(diffTool(base, narrowed).severity, "breaking");
  assert.equal(diffTool(base, widened).severity, "additive");
});

test("worstSeverity picks the loudest", () => {
  assert.equal(worstSeverity(["cosmetic", "breaking", "additive"]), "breaking");
  assert.equal(worstSeverity(["cosmetic", "additive"]), "additive");
  assert.equal(worstSeverity([]), "cosmetic");
});

test("classifyChange does not treat a description edit as a contract change", () => {
  const c = classifyChange({ op: "change", path: ["properties", "query", "description"] });
  assert.equal(c.severity, "cosmetic");
});

// --- the signal this registry exists for ------------------------------------

test("silent drift: schema moves while the description stays byte-identical", () => {
  const next = tool();
  next.inputSchema.required = ["query", "limit"];
  const d = diffTool(tool(), next);
  assert.equal(d.silent, true);
});

test("not silent when the description changed too", () => {
  const next = tool({ description: "Search the docs (v2)." });
  next.inputSchema.required = ["query", "limit"];
  assert.equal(diffTool(tool(), next).silent, false);
});

test("not silent when only prose moved", () => {
  assert.equal(diffTool(tool(), tool({ description: "Other." })).silent, false);
});

// --- events -----------------------------------------------------------------

test("a baseline is exactly one event, not one per tool", () => {
  const events = buildEvents(null, server([tool(), tool({ name: "fetch" })]), AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "server_added");
  assert.match(events[0].summary, /2 tools/);
});

test("baseline of a single-tool server reads grammatically", () => {
  const events = buildEvents(null, server([tool()]), AT);
  assert.match(events[0].summary, /1 tool\b/);
});

test("an unreachable server stops the tool diff and is not filed as breaking", () => {
  const prev = server([tool()]);
  const next = server([], { status: "error", error: "fetch failed", toolCount: 0 });
  const events = buildEvents(prev, next, AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "server_unreachable");
  assert.equal(events[0].severity, "operational");
});

test("recovery does not announce every tool as new", () => {
  const prev = server([], { status: "error", error: "fetch failed", toolCount: 0 });
  const next = server([tool(), tool({ name: "fetch" })]);
  const types = buildEvents(prev, next, AT).map((e) => e.type);
  // No contract was ever recorded, so this is a baseline — not two additions.
  assert.deepEqual(types, ["server_recovered", "server_baselined"]);
  assert.ok(!types.includes("tool_added"));
});

test("removing a tool is breaking, adding one is additive", () => {
  const prev = server([tool(), tool({ name: "fetch" })]);
  const next = server([tool()]);
  const [removal] = buildEvents(prev, next, AT);
  assert.equal(removal.type, "tool_removed");
  assert.equal(removal.severity, "breaking");

  const [addition] = buildEvents(next, prev, AT);
  assert.equal(addition.type, "tool_added");
  assert.equal(addition.severity, "additive");
});

test("a silent schema change surfaces as its own event type", () => {
  const changed = tool();
  changed.inputSchema.required = ["query", "limit"];
  const events = buildEvents(server([tool()]), server([changed]), AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_silent_schema_change");
  assert.equal(events[0].silent, true);
  assert.equal(events[0].severity, "breaking");
});

test("a protocol version bump is reported", () => {
  const next = server([tool()], { protocolVersion: "2026-01-01" });
  const events = buildEvents(server([tool()]), next, AT);
  assert.ok(events.some((e) => e.type === "protocol_version_changed" && e.severity === "breaking"));
});

test("an unchanged pulse produces nothing — reruns are idempotent", () => {
  assert.deepEqual(buildEvents(server([tool()]), server([tool()]), AT), []);
});

test("event ids are stable for the same change and differ across changes", () => {
  const changed = tool();
  changed.inputSchema.required = ["query", "limit"];
  const a = buildEvents(server([tool()]), server([changed]), AT)[0];
  const b = buildEvents(server([tool()]), server([changed]), "2026-02-02T00:00:00.000Z")[0];
  assert.equal(a.id, b.id);

  const other = buildEvents(server([tool()]), server([tool(), tool({ name: "fetch" })]), AT)[0];
  assert.notEqual(a.id, other.id);
});

// --- transport --------------------------------------------------------------

test("parseRpc reads a plain JSON-RPC body", () => {
  assert.deepEqual(parseRpc('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'), { tools: [] });
});

test("parseRpc reads an SSE-framed body", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"}]}}\n\n';
  assert.deepEqual(parseRpc(sse), { tools: [{ name: "a" }] });
});

test("parseRpc turns a JSON-RPC error into a thrown error", () => {
  assert.throws(() => parseRpc('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}'), /nope/);
});

// --- rendering: third-party strings reach the page --------------------------

test("markup in a vendor-controlled string is escaped", () => {
  const hostile = `</script><img src=x onerror="alert(1)">`;
  assert.ok(!esc(hostile).includes("<img"));
  assert.ok(!esc(hostile).includes("</script>"));
});

test("backticked names become code without letting markup through", () => {
  const out = inlineCode("tool `search<script>` changed");
  assert.ok(out.includes("<code>"));
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

// --- outages must not launder a contract change -----------------------------
//
// The failure these cover is silent by construction: a server sleeps, a tool
// disappears while it is down, and the naive implementation re-baselines on
// recovery and reports nothing at all. The registry would stay quiet about
// precisely the event it exists to catch.

const down = (over = {}) => ({
  id: "acme",
  name: "Acme",
  url: "https://example.invalid/mcp",
  status: "error",
  error: "HTTP 502",
  protocolVersion: null,
  tools: [],
  toolCount: 0,
  fingerprint: null,
  ...over,
});

test("going unreachable is operational, not a breaking contract change", () => {
  const [e] = buildEvents(server([tool()]), down(), AT);
  assert.equal(e.type, "server_unreachable");
  assert.equal(e.severity, "operational");
});

test("a tool removed during an outage is still reported on recovery", () => {
  const before = server([tool(), tool({ name: "fetch" })]);
  // What pulse.js persists while the server is down: no tools, contract kept.
  const whileDown = down({
    lastGood: { at: AT, tools: before.tools, fingerprint: before.fingerprint, protocolVersion: before.protocolVersion },
  });
  const after = server([tool()]);

  const events = buildEvents(whileDown, after, AT);
  const removal = events.find((e) => e.type === "tool_removed");

  assert.ok(removal, "the removal must survive the outage");
  assert.equal(removal.tool, "fetch");
  assert.equal(removal.severity, "breaking");
  assert.ok(events.some((e) => e.type === "server_recovered" && e.severity === "operational"));
});

test("recovery reports nothing extra when the contract is unchanged", () => {
  const before = server([tool()]);
  const whileDown = down({
    lastGood: { at: AT, tools: before.tools, fingerprint: before.fingerprint, protocolVersion: before.protocolVersion },
  });
  const types = buildEvents(whileDown, server([tool()]), AT).map((e) => e.type);
  assert.deepEqual(types, ["server_recovered"]);
});

test("a record predating lastGood still diffs against its own snapshot", () => {
  // Existing state on disk has no `lastGood` key; it must not re-baseline.
  const legacy = { ...server([tool(), tool({ name: "fetch" })]), status: "ok" };
  const events = buildEvents(legacy, server([tool()]), AT);
  assert.ok(events.some((e) => e.type === "tool_removed" && e.tool === "fetch"));
});

test("recovery with no contract ever recorded is a baseline, not a hundred additions", () => {
  const types = buildEvents(down(), server([tool(), tool({ name: "fetch" })]), AT).map((e) => e.type);
  assert.deepEqual(types, ["server_recovered", "server_baselined"]);
});

// --- flap quarantine --------------------------------------------------------
//
// At 79 endpoints, two hosts that bounce every other pulse produce more feed
// entries than every real contract change combined. These cover the deal:
// availability chatter from a proven-unreliable host is dropped, its contract
// is not.

const NOW = "2026-03-15T00:00:00.000Z";
const daysAgo = (d) => new Date(Date.parse(NOW) - d * 24 * 60 * 60 * 1000).toISOString();
const flips = (...days) => days.map((d, i) => ({ at: daysAgo(d), to: i % 2 === 0 ? "error" : "ok" }));

test("four ok<->error transitions in seven days quarantine the server", () => {
  // Three already on record, and this pulse supplies the fourth.
  const prev = server([tool()], { reachability: flips(5, 4, 2) });
  const { transitions, unstable } = trackReachability(prev, down(), NOW);
  assert.equal(transitions.length, FLAP_THRESHOLD);
  assert.equal(unstable, true);
  assert.equal(transitions.at(-1).to, "error");
});

test("three transitions are still published — the threshold is not a hair trigger", () => {
  const prev = server([tool()], { reachability: flips(5, 4) });
  const { transitions, unstable } = trackReachability(prev, down(), NOW);
  assert.equal(transitions.length, 3);
  assert.equal(unstable, false);

  const [e] = buildEvents(prev, down(), NOW, { quarantined: unstable });
  assert.equal(e.type, "server_unreachable");
});

test("a quarantined server publishes neither unreachable nor recovered", () => {
  const up = server([tool()]);
  const goingDown = buildEvents(up, down(), NOW, { quarantined: true });
  assert.deepEqual(goingDown, []);

  const whileDown = down({
    lastGood: { at: NOW, tools: up.tools, fingerprint: up.fingerprint, protocolVersion: up.protocolVersion },
  });
  const comingBack = buildEvents(whileDown, up, NOW, { quarantined: true });
  assert.deepEqual(comingBack, []);
});

test("quarantine covers availability only — a contract change is still recorded", () => {
  const before = server([tool(), tool({ name: "fetch" })]);

  // Recovering from an outage while a tool went missing.
  const whileDown = down({
    lastGood: { at: NOW, tools: before.tools, fingerprint: before.fingerprint, protocolVersion: before.protocolVersion },
  });
  const onRecovery = buildEvents(whileDown, server([tool()]), NOW, { quarantined: true });
  const removal = onRecovery.find((e) => e.type === "tool_removed");
  assert.ok(removal, "the drift must survive quarantine");
  assert.equal(removal.tool, "fetch");
  assert.equal(removal.severity, "breaking");
  assert.ok(!onRecovery.some((e) => e.type === "server_recovered"));

  // And on an ordinary up-to-up pulse.
  const changed = tool();
  changed.inputSchema.required = ["query", "limit"];
  const steady = buildEvents(server([tool()]), server([changed]), NOW, { quarantined: true });
  assert.equal(steady.length, 1);
  assert.equal(steady[0].type, "tool_silent_schema_change");
  assert.equal(steady[0].severity, "breaking");
});

test("transitions older than the window fall out and quarantine lifts by itself", () => {
  const stale = [
    { at: daysAgo(30), to: "error" },
    { at: daysAgo(29), to: "ok" },
    { at: daysAgo(8), to: "error" },
    { at: daysAgo(7.5), to: "ok" },
    { at: daysAgo(2), to: "error" },
    { at: daysAgo(1), to: "ok" },
  ];
  const prev = server([tool()], { reachability: stale, stability: "unstable" });
  const { transitions, unstable } = trackReachability(prev, server([tool()]), NOW);

  assert.equal(transitions.length, 2, "only the two inside the 7-day window survive");
  assert.equal(unstable, false);
  assert.ok(transitions.every((t) => Date.parse(NOW) - Date.parse(t.at) < FLAP_WINDOW_MS));
});

test("a record predating the flap tracker is not treated as a flapping server", () => {
  // Exactly what the 79 files on disk look like today: no `reachability` key.
  const legacy = server([tool()]);
  assert.equal("reachability" in legacy, false);

  const steady = trackReachability(legacy, server([tool()]), NOW);
  assert.deepEqual(steady, { transitions: [], unstable: false });

  // A single outage against a legacy record is one transition, not a flap.
  const firstOutage = trackReachability(legacy, down(), NOW);
  assert.equal(firstOutage.transitions.length, 1);
  assert.equal(firstOutage.unstable, false);
  assert.equal(buildEvents(legacy, down(), NOW, { quarantined: false })[0].type, "server_unreachable");

  // A brand-new server has no previous status at all.
  assert.deepEqual(trackReachability(null, server([tool()]), NOW), { transitions: [], unstable: false });
});

test("a corrupt or hand-edited reachability list does not stop the pulse", () => {
  const prev = server([tool()], { reachability: [null, "nonsense", { to: "ok" }, { at: "not-a-date", to: "ok" }] });
  const { transitions, unstable } = trackReachability(prev, server([tool()]), NOW);
  assert.deepEqual(transitions, []);
  assert.equal(unstable, false);
});

test("steady state records nothing — the history cannot grow without transitions", () => {
  let prev = server([tool()]);
  for (let i = 0; i < 50; i += 1) {
    const { transitions } = trackReachability(prev, server([tool()]), NOW);
    prev = server([tool()], transitions.length ? { reachability: transitions } : {});
  }
  assert.equal(prev.reachability, undefined);
});

test("stability defaults to stable for every record that predates the field", () => {
  assert.equal(isUnstable(server([tool()])), false);
  assert.equal(isUnstable({ stability: "unstable" }), true);
  assert.equal(isUnstable(undefined), false);
});

// --- 79 rows are not 79 observations ----------------------------------------

test("platform families collapse a shared generator and never assume independence", () => {
  const fleet = [
    { id: "a", platform: "mintlify-docs" },
    { id: "b", platform: "mintlify-docs" },
    { id: "c", platform: "mintlify-docs" },
    { id: "d", platform: "openapi-explorer" },
    { id: "e" },
    { id: "f", platform: null },
  ];
  const f = platformFamilies(fleet);

  // 2 declared platforms + 2 endpoints of unknown provenance, each its own.
  assert.equal(f.platformFamilies, 4);
  assert.equal(f.unlabelledPlatform, 2);
  assert.deepEqual(f.platforms, { "mintlify-docs": 3, "openapi-explorer": 1 });
  assert.deepEqual(f.largestPlatform, { platform: "mintlify-docs", servers: 3 });
});

test("with no platform declared anywhere, families equal servers — no free credit", () => {
  const f = platformFamilies([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(f.platformFamilies, 3);
  assert.equal(f.largestPlatform, null);
});

test("the shipped registry declares fewer families than it has rows", () => {
  const config = JSON.parse(readFileSync(new URL("../servers.json", import.meta.url), "utf8"));
  const f = platformFamilies(config.servers);
  assert.ok(f.platformFamilies < config.servers.length, "otherwise the caveat on the site is a lie");
  assert.ok(f.largestPlatform.servers > 1);
});

// --- what a consumer of the JSON API actually receives ----------------------

test("the API publishes platform and stability for every server", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-"));
  try {
    const store = new Store(join(dir, "state"));
    store.writeServer({
      ...server([tool()]),
      id: "shared",
      name: "Shared",
      platform: "mintlify-docs",
      firstSeenAt: AT,
      lastCheckedAt: AT,
      changeCount: 0,
    });
    store.writeServer({
      ...server([tool()]),
      id: "flappy",
      name: "Flappy",
      stability: "unstable",
      reachability: flips(5, 4, 2, 1),
      firstSeenAt: AT,
      lastCheckedAt: AT,
      changeCount: 0,
    });
    store.writeServer({ ...server([tool()]), id: "lonely", name: "Lonely", firstSeenAt: AT, lastCheckedAt: AT, changeCount: 0 });

    const outDir = join(dir, "site");
    publish({
      store,
      outDir,
      at: AT,
      config: {
        site: { title: "T", tagline: "t", url: "https://example.invalid", repo: "he110/mcp-drift-registry" },
        servers: [{ id: "shared", platform: "mintlify-docs" }, { id: "flappy" }, { id: "lonely" }],
      },
    });

    const registry = JSON.parse(readFileSync(join(outDir, "api/registry.json"), "utf8"));
    const byId = Object.fromEntries(registry.servers.map((s) => [s.id, s]));

    assert.equal(byId.shared.platform, "mintlify-docs");
    assert.equal(byId.lonely.platform, null, "unlabelled stays null — we do not invent a platform");
    assert.equal(byId.shared.stability, "stable");
    assert.equal(byId.flappy.stability, "unstable");
    assert.equal(byId.flappy.flapCount, 4);

    // Three servers, one shared platform, two unknown: 1 + 2 families.
    assert.equal(registry.counts.platformFamilies, 3);
    assert.equal(registry.counts.servers, 3);

    // A quarantined host answered, but it is not counted as a healthy endpoint.
    assert.equal(registry.counts.unstable, 1);
    assert.equal(registry.counts.ok, 2);
    assert.equal(registry.counts.answered, 3);

    const one = JSON.parse(readFileSync(join(outDir, "api/servers/flappy.json"), "utf8"));
    assert.equal(one.stability, "unstable");
    assert.equal(one.platform, null);

    // And the reader is told, in words, which of the two claims is being made.
    const html = readFileSync(join(outDir, "servers/flappy.html"), "utf8");
    assert.match(html, /statement about the host, not about its contract/);
    assert.ok(!html.includes("sev--breaking"), "quarantine must not borrow the breaking-change styling");

    const index = readFileSync(join(outDir, "index.html"), "utf8");
    assert.match(index, /3 independent contract families/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- note № 01: the page that argues about the sample -----------------------

const templated = (id, vendor, searchFp, feedbackFp = "feed-a", over = {}, props = ["query"]) => ({
  id,
  name: id,
  url: `https://${vendor}.example.invalid/mcp`,
  status: "ok",
  tools: [
    { name: `query_docs_filesystem_${vendor}`, schemaFingerprint: `q-${vendor}` },
    {
      name: `search_${vendor}`,
      schemaFingerprint: searchFp,
      inputSchema: { type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) },
    },
    { name: "submit_feedback", schemaFingerprint: feedbackFp },
  ],
  ...over,
});

test("the template is counted from tool names, not from our own labels", () => {
  const f = noteFacts([
    templated("a", "alpha", "s-1", "feed-a", { platform: null }),
    templated("b", "bravo", "s-1", "feed-a", { platform: null }),
    templated("c", "charlie", "s-2", "feed-b", { platform: null }),
    { id: "d", name: "d", url: "https://other.example.invalid/mcp", tools: [{ name: "fetch", schemaFingerprint: "x" }] },
  ]);

  // Not one of the four carries a platform label; the signature finds three anyway.
  assert.equal(f.total, 4);
  assert.equal(f.templated, 3);
  assert.equal(f.sharePct, 75);
  assert.deepEqual(
    f.strata.map((s) => s.servers),
    [2, 1],
    "strata are ordered by size so the modal one reads first",
  );
  assert.equal(f.feedback[0].servers, 2);
});

test("a stratum reports what its schema accepts, not just that it differs", () => {
  const f = noteFacts([
    templated("a", "alpha", "s-1", "feed", {}, ["query"]),
    templated("b", "bravo", "s-2", "feed", {}, ["query", "version"]),
    // Same parameters, different fingerprint: it differs somewhere a parameter
    // list cannot show, and the page has to say so rather than print two
    // identical-looking rows.
    templated("c", "charlie", "s-3", "feed", {}, ["query"]),
  ]);
  const byFp = Object.fromEntries(f.strata.map((s) => [s.value, s]));
  assert.deepEqual(byFp["s-2"].properties, ["query", "version"]);
  assert.equal(byFp["s-2"].ambiguous, false);
  assert.equal(byFp["s-1"].ambiguous, true, "s-1 and s-3 accept the same parameters");
  assert.equal(byFp["s-3"].ambiguous, true);
  assert.deepEqual(byFp["s-1"].properties, ["query"]);
});

test("two endpoints on one host are reported as one deployment", () => {
  const f = noteFacts([
    { id: "twin-a", url: "https://one.example.invalid/docs", tools: [] },
    { id: "twin-b", url: "https://one.example.invalid/repo", tools: [] },
    { id: "solo", url: "https://two.example.invalid/mcp", tools: [] },
  ]);
  assert.equal(f.sharedHosts.length, 1);
  assert.equal(f.sharedHosts[0].host, "one.example.invalid");
  assert.deepEqual(f.sharedHosts[0].ids, ["twin-a", "twin-b"]);
});

test("a malformed url does not take the whole page down with it", () => {
  const f = noteFacts([{ id: "bad", url: "not a url", tools: [] }, { id: "worse", url: null, tools: [] }]);
  assert.deepEqual(f.sharedHosts, []);
});

test("the note cannot contradict the ledger it is drawn from", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-note-"));
  try {
    const store = new Store(join(dir, "state"));
    for (const s of [
      templated("alpha-docs", "alpha", "s-1"),
      templated("bravo-docs", "bravo", "s-1"),
      templated("charlie-docs", "charlie", "s-2"),
    ]) {
      store.writeServer({ ...s, toolCount: s.tools.length, platform: "mintlify-docs", firstSeenAt: AT, lastCheckedAt: AT, changeCount: 0 });
    }
    store.writeServer({ ...server([tool()]), id: "lonely", name: "Lonely", firstSeenAt: AT, lastCheckedAt: AT, changeCount: 0 });

    const outDir = join(dir, "site");
    publish({
      store,
      outDir,
      at: AT,
      config: {
        site: { title: "T", tagline: "t", url: "https://example.invalid", repo: "he110/mcp-drift-registry" },
        servers: [],
      },
    });

    const registry = JSON.parse(readFileSync(join(outDir, "api/registry.json"), "utf8"));
    const note = readFileSync(join(outDir, "notes/one-template.html"), "utf8");

    // The headline, the family count and the jq output are all the ledger's numbers.
    assert.match(note, new RegExp(`${registry.counts.servers} servers is not`));
    assert.match(note, new RegExp(`${registry.counts.platformFamilies} families, and that is a ceiling`));
    assert.match(note, /3 of the 4 endpoints — 75% —/);
    assert.match(note, /Two strata inside one template/);
    // The figure names the parameters; a table of bare hashes is not a finding.
    assert.match(note, /strata__props/);

    // And it is reachable: a page nobody can navigate to is not published.
    assert.match(readFileSync(join(outDir, "index.html"), "utf8"), /notes\/one-template\.html/);
    assert.match(readFileSync(join(outDir, "sitemap.xml"), "utf8"), /notes\/one-template\.html/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a uniform template publishes no strata chart rather than a chart of one", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-note-"));
  try {
    const store = new Store(join(dir, "state"));
    for (const s of [templated("alpha-docs", "alpha", "same"), templated("bravo-docs", "bravo", "same")]) {
      store.writeServer({ ...s, toolCount: s.tools.length, firstSeenAt: AT, lastCheckedAt: AT, changeCount: 0 });
    }
    const outDir = join(dir, "site");
    publish({
      store,
      outDir,
      at: AT,
      config: { site: { url: "https://example.invalid", repo: "he110/mcp-drift-registry" }, servers: [] },
    });

    const note = readFileSync(join(outDir, "notes/one-template.html"), "utf8");
    assert.ok(!note.includes("strata__bar"), "one bucket is not a distribution");
    assert.match(note, /single schema fingerprint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hostile server id reaches the note escaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-note-"));
  try {
    const store = new Store(join(dir, "state"));
    const evil = "<script>alert(1)</script>";
    for (const id of ["twin-a", "twin-b"]) {
      store.writeServer({
        ...server([tool()]),
        id,
        name: evil,
        url: "https://one.example.invalid/" + id,
        firstSeenAt: AT,
        lastCheckedAt: AT,
        changeCount: 0,
      });
    }
    const outDir = join(dir, "site");
    publish({
      store,
      outDir,
      at: AT,
      config: { site: { url: "https://example.invalid", repo: evil }, servers: [] },
    });
    const note = readFileSync(join(outDir, "notes/one-template.html"), "utf8");
    assert.ok(!note.includes("<script>alert(1)</script>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the probe must reach the endpoint it says it reached -------------------

test("a JSON-RPC response without a result member is not a result", () => {
  // The exact shape that got in: a static discovery manifest, served to a plain
  // GET, carrying a `tools` array and no JSON-RPC envelope at all.
  const manifest = JSON.stringify({
    server: { name: "Docs", version: "1.0.0" },
    instructions: "…",
    tools: [{ name: "search_docs", inputSchema: { type: "object" } }],
  });
  assert.throws(() => parseRpc(manifest), /no `result` member/);
  assert.throws(() => parseRpc(JSON.stringify({ jsonrpc: "1.0", result: {} })), /not JSON-RPC 2\.0/);
  assert.deepEqual(parseRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })), { tools: [] });
});

test("a method-changing redirect is refused, a method-preserving one is followed", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method });
    if (req.url === "/moved-301") return res.writeHead(301, { location: "/target" }).end();
    if (req.url === "/moved-308") return res.writeHead(308, { location: "/target" }).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 308 keeps POST, so the probe still reaches an MCP endpoint.
    const kept = await httpJson(`${base}/moved-308`, { method: "POST", body: "{}", retries: 0 });
    assert.equal(JSON.parse(kept.text).method, "POST");

    // 301 would turn the probe into a page request. Refused, and the message
    // names the target so the fix is to correct the declared URL.
    await assert.rejects(() => httpJson(`${base}/moved-301`, { method: "POST", body: "{}", retries: 0 }), (err) => {
      assert.equal(err.status, 301);
      assert.match(err.message, /would change POST to GET/);
      assert.match(err.detail, /\/target/);
      return true;
    });
    assert.ok(!seen.some((r) => r.method === "GET"), "no GET may be issued on behalf of a POST probe");

    // A GET is idempotent; following it changes nothing.
    const got = await httpJson(`${base}/moved-301`, { retries: 0 });
    assert.equal(JSON.parse(got.text).method, "GET");
  } finally {
    server.close();
  }
});

// --- admission gate ---------------------------------------------------------
//
// The invariants here are the ones that break silently. Nothing in the pipeline
// fails loudly if the gate quietly starts admitting on the first probe again,
// or if a promotion drops a row that was already in the registry — the site
// still renders, the tests still pass, and the only symptom is a number on the
// front page that is no longer true.

const HOUR = 3600 * 1000;
const CANDIDATE = { id: "newcomer", name: "Newcomer", url: "https://example.invalid/mcp" };
const okProbe = { status: "ok", toolCount: 3 };
const failedProbe = { status: "error", error: "HTTP 502", toolCount: 0 };

/** Fold n probes spaced `spacingMs` apart, starting at `startMs`. */
function probeSeries(n, spacingMs, { start = Date.parse(AT), outcomes = null } = {}) {
  let record = null;
  const stamps = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(start + i * spacingMs).toISOString();
    stamps.push(at);
    record = foldProbe(record, CANDIDATE, outcomes ? outcomes(i) : okProbe, at);
  }
  return { record, stamps };
}

test("eight good probes inside two hours do not admit a candidate", () => {
  const { record } = probeSeries(ADMISSION_PROBES, (2 * HOUR) / (ADMISSION_PROBES - 1));
  assert.equal(record.consecutiveOk, ADMISSION_PROBES);
  assert.equal(record.admittedAt, null, "the probe count alone must not open the gate");
});

test("eight good probes spanning fifty hours admit the candidate", () => {
  const { record, stamps } = probeSeries(ADMISSION_PROBES, (50 * HOUR) / (ADMISSION_PROBES - 1));
  assert.equal(record.consecutiveOk, ADMISSION_PROBES);
  assert.equal(record.admittedAt, stamps.at(-1));
});

test("the real cron cadence needs a ninth probe, and gets there", () => {
  // Eight pulses six hours apart cover 42h of wall clock, not 48. Both clauses
  // of the gate bind; that is the design, not an off-by-one.
  const eight = probeSeries(8, 6 * HOUR).record;
  assert.equal(eight.admittedAt, null);
  const nine = probeSeries(9, 6 * HOUR).record;
  assert.equal(nine.admittedAt, nine.lastProbeAt);
});

test("one failed probe resets the streak and the clock with it", () => {
  // Seven days of good probes, one 502, then eight good probes in two hours.
  // Measuring the span from first sighting would admit this host; measuring it
  // across the streak — which is what the gate does — does not.
  const long = probeSeries(7, 24 * HOUR).record;
  assert.equal(long.consecutiveOk, 7);

  const afterFailure = foldProbe(long, CANDIDATE, failedProbe, new Date(Date.parse(long.lastProbeAt) + HOUR).toISOString());
  assert.equal(afterFailure.consecutiveOk, 0);
  assert.equal(afterFailure.streakStartedAt, null);
  assert.equal(afterFailure.failures, 1);
  assert.match(afterFailure.lastError, /502/);

  let record = afterFailure;
  for (let i = 1; i <= ADMISSION_PROBES; i++) {
    record = foldProbe(record, CANDIDATE, okProbe, new Date(Date.parse(afterFailure.lastProbeAt) + i * 900_000).toISOString());
  }
  assert.equal(record.consecutiveOk, ADMISSION_PROBES);
  assert.equal(record.admittedAt, null, "a broken streak must restart the 48h clock, not resume it");
  assert.equal(record.probes, 16);
});

test("a server that answers with an empty tool list is a failed probe", () => {
  // No tools means no contract, and a row that can never drift is a row that
  // only dilutes the family counts.
  const { record } = probeSeries(ADMISSION_PROBES, 8 * HOUR, {
    outcomes: (i) => (i === 4 ? { status: "ok", toolCount: 0 } : okProbe),
  });
  assert.equal(record.admittedAt, null);
  assert.equal(record.failures, 1);
  assert.equal(record.consecutiveOk, 3, "the empty answer broke the streak like any other failure");

  const emptyOnly = foldProbe(null, CANDIDATE, { status: "ok", toolCount: 0 }, AT);
  assert.equal(emptyOnly.consecutiveOk, 0);
  assert.match(emptyOnly.lastError, /no tools/);
});

test("admission is granted once and does not re-fire on later probes", () => {
  const { record } = probeSeries(9, 6 * HOUR);
  const admittedAt = record.admittedAt;
  assert.ok(admittedAt);
  const later = foldProbe(record, CANDIDATE, okProbe, new Date(Date.parse(record.lastProbeAt) + 6 * HOUR).toISOString());
  assert.equal(later.admittedAt, admittedAt, "re-stamping admission would promote the same server twice");
});

test("a candidate on trial for a fortnight without clearing the gate is dropped", () => {
  const record = probeSeries(3, 24 * HOUR, { outcomes: (i) => (i % 2 ? failedProbe : okProbe) }).record;
  const at = new Date(Date.parse(record.firstProbeAt) + 15 * 24 * HOUR).toISOString();
  assert.equal(abandoned(record, at), true);
  assert.equal(abandoned(record, record.lastProbeAt), false);
  const admittedRecord = probeSeries(9, 6 * HOUR).record;
  assert.equal(abandoned(admittedRecord, at), false, "an admitted server is never abandoned");
});

test("promotion appends and never disturbs the servers already in the registry", () => {
  // The regression that would cost the most and announce itself the least:
  // rewriting servers.json in a way that drops or reorders the existing cohort
  // resets every frozen baseline the registry's own headline claim rests on.
  const servers = Array.from({ length: 79 }, (_, i) => ({ id: `server-${i}`, name: `Server ${i}`, url: `https://s${i}.invalid/mcp` }));
  const config = {
    site: { title: "MCP Drift Registry" },
    servers,
    candidates: [
      { id: "newcomer", name: "Newcomer", vendor: "Acme", url: "https://example.invalid/mcp", homepage: "https://example.invalid" },
      { id: "still-trying", name: "Still Trying", url: "https://other.invalid/mcp" },
    ],
  };

  const after = applyAdmissions(config, ["newcomer"]);
  assert.equal(after.servers.length, 80);
  assert.deepEqual(after.servers.slice(0, 79), servers, "the existing 79 must survive byte for byte, in order");
  assert.deepEqual(after.servers[79], {
    id: "newcomer",
    name: "Newcomer",
    vendor: "Acme",
    url: "https://example.invalid/mcp",
    homepage: "https://example.invalid",
  });
  assert.deepEqual(after.candidates.map((c) => c.id), ["still-trying"]);
  assert.deepEqual(after.site, config.site);
});

test("a pulse with nothing to admit hands back the very same config", () => {
  // Identity, not equality: the caller skips the write on this, so any pulse
  // without an admission leaves servers.json untouched on disk.
  const config = { servers: [{ id: "a", url: "https://a.invalid/mcp" }], candidates: [{ id: "b", url: "https://b.invalid/mcp" }] };
  assert.equal(applyAdmissions(config, []), config);
  assert.equal(applyAdmissions(config, ["never-nominated"]), config);
});

test("a config with no candidates key is untouched by the gate", () => {
  // This is the state of the repository today: 79 servers, no candidates. The
  // gate must be a no-op for them, now and after any future refactor.
  const config = { servers: [{ id: "a", url: "https://a.invalid/mcp" }] };
  assert.equal(applyAdmissions(config, ["a"]), config);
});

test("promoting a candidate that is somehow already a server does not duplicate the row", () => {
  const config = {
    servers: [{ id: "dupe", name: "Dupe", url: "https://dupe.invalid/mcp" }],
    candidates: [{ id: "dupe", name: "Dupe", url: "https://dupe.invalid/mcp" }],
  };
  const after = applyAdmissions(config, ["dupe"]);
  assert.equal(after.servers.length, 1);
  assert.deepEqual(after.candidates, []);
});

test("the candidate ledger survives a missing, truncated or hand-edited file", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-admission-"));
  try {
    const store = new Store(join(dir, "state"));
    assert.deepEqual(store.readCandidates(), {}, "no file yet is an empty ledger, not a crash");

    const record = foldProbe(null, CANDIDATE, okProbe, AT);
    store.writeCandidates({ newcomer: record });
    assert.deepEqual(store.readCandidates(), { newcomer: record });

    writeFileSync(join(dir, "state", "candidates.json"), "[]");
    assert.deepEqual(store.readCandidates(), {}, "an array is not a ledger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidates never reach the published registry", () => {
  // Belt and braces on the separation: publish reads state/servers/, and the
  // trial ledger writes nowhere near it.
  const dir = mkdtempSync(join(tmpdir(), "drift-admission-site-"));
  try {
    const store = new Store(join(dir, "state"));
    store.writeServer(server([tool()], { id: "admitted", name: "Admitted", lastCheckedAt: AT, lastOkAt: AT, firstSeenAt: AT, changeCount: 0 }));
    store.writeCandidates({ newcomer: foldProbe(null, CANDIDATE, okProbe, AT) });

    const outDir = join(dir, "site");
    publish({
      store,
      outDir,
      config: {
        site: { title: "T", url: "https://example.invalid" },
        servers: [{ id: "admitted" }],
        candidates: [CANDIDATE],
      },
      at: AT,
    });

    const registry = JSON.parse(readFileSync(join(outDir, "api/registry.json"), "utf8"));
    assert.deepEqual(registry.servers.map((s) => s.id), ["admitted"]);
    assert.ok(!readFileSync(join(outDir, "index.html"), "utf8").includes("Newcomer"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the trial log line says what is still owed", () => {
  const { record } = probeSeries(3, 12 * HOUR);
  assert.equal(admits(record, record.lastProbeAt), false);
  assert.equal(describeProgress(record, record.lastProbeAt), `3/${ADMISSION_PROBES} ok, 24h/${ADMISSION_SPAN_MS / 3600000}h`);
  assert.equal(describeProgress(probeSeries(9, 6 * HOUR).record, AT), "admitted");
});

// --- note № 02: the fleet census --------------------------------------------
//
// This page names fifty-odd third-party vendors and states, for each of them,
// which contract they serve. It is meant to be linked from somebody else's
// issue tracker, where every claim on it can be checked in one curl. So the
// tests here are aimed at the failures that would still render, still pass
// every other test, and still be wrong in public: a tenant silently dropped, a
// completeness claim that is not actually checked, a row we did not read from
// the URL we say we read it from, and prose that keeps saying "four" after the
// data has stopped saying four.

/** One tenant of the hosted template: the signature tool, plus its search_*. */
const tenant = (
  id,
  { optional = [], fp = `fp-${optional.join("-") || "base"}`, required = ["query"], additionalProperties = false, provenance, name = id } = {},
) => ({
  id,
  name,
  url: `https://${id}.example.invalid/mcp`,
  status: "ok",
  platform: "mintlify-docs",
  ...(provenance ? { provenance } : {}),
  tools: [
    { name: `${SIGNATURE}${id}`, schemaFingerprint: `q-${id}` },
    {
      name: `search_${id}`,
      schemaFingerprint: fp,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(["query", ...optional].map((p) => [p, { type: "string" }])),
        required,
        additionalProperties,
      },
    },
  ],
});

const provenanceOf = (id, over = {}) =>
  buildProvenance({
    declaredUrl: `https://${id}.example.invalid/mcp`,
    at: AT,
    trace: { finalUrl: `https://${id}.example.invalid/mcp`, hops: [] },
    via: DIRECT,
    envelope: "json-rpc",
    ...over,
  });

test("the census groups by fingerprint and only members of the template are tenants", () => {
  const f = fleetCensus([
    tenant("a"),
    tenant("b"),
    tenant("c"),
    tenant("d", { optional: ["version"] }),
    tenant("e", { optional: ["version"] }),
    tenant("f", { optional: ["language"] }),
    tenant("g", { optional: ["language", "version"] }),
    { id: "outsider", name: "Outsider", url: "https://outsider.example.invalid/mcp", tools: [{ name: "search", schemaFingerprint: "x" }] },
  ]);

  assert.equal(f.total, 7, "the outsider does not run the template and is not one of its tenants");
  assert.equal(f.platform, "mintlify-docs", "the label is read off the members, not asserted about them");
  assert.deepEqual(f.variants.map((v) => v.tenants), [3, 2, 1, 1], "largest variant first");
  assert.deepEqual(f.variants[0].ids, ["a", "b", "c"]);
  assert.deepEqual(f.optionalUnion, ["language", "version"]);
  assert.deepEqual(f.invariants.required, ["query"]);
  assert.equal(f.invariants.additionalProperties, false);
  assert.deepEqual(f.crossProduct, { expected: 4, observed: 4, missing: [], collisions: [], complete: true });
});

test("a hole in the matrix is named, not rounded away", () => {
  // Three of the four combinations of two switches. "Complete" is a claim the
  // page makes in bold; it has to be false the moment it stops being true.
  const f = fleetCensus([tenant("a"), tenant("d", { optional: ["version"] }), tenant("g", { optional: ["language", "version"] })]);

  assert.equal(f.crossProduct.expected, 4);
  assert.equal(f.crossProduct.observed, 3);
  assert.deepEqual(f.crossProduct.missing, ["language"]);
  assert.equal(f.crossProduct.complete, false);
});

test("two fingerprints accepting identical parameters collide, they are not a fifth combination", () => {
  // The finding this exists to catch: two variants that a parameter list cannot
  // tell apart. Counting them as separate cells of the matrix would let a
  // complete-looking 2x2 be built out of five variants.
  const f = fleetCensus([
    tenant("a"),
    tenant("b", { fp: "fp-base-but-different" }),
    tenant("d", { optional: ["version"] }),
    tenant("f", { optional: ["language"] }),
    tenant("g", { optional: ["language", "version"] }),
  ]);

  assert.equal(f.variants.length, 5);
  assert.deepEqual(f.crossProduct.missing, [], "every combination is present…");
  assert.equal(f.crossProduct.collisions.length, 1, "…and one of them is served by two different schemas");
  assert.deepEqual(f.crossProduct.collisions[0].optional, []);
  assert.deepEqual(f.crossProduct.collisions[0].fingerprints.sort(), ["fp-base", "fp-base-but-different"]);
  assert.equal(f.crossProduct.complete, false);
});

test("a tenant with no search tool, or with two, is recorded rather than quietly dropped", () => {
  // Both cases mean "tenant -> variant is not a function", and both are
  // invisible in a table that simply omits the row.
  const mute = { ...tenant("mute"), tools: [{ name: `${SIGNATURE}mute`, schemaFingerprint: "q-mute" }] };
  const twin = tenant("twin");
  twin.tools.push({
    name: "search_twin_legacy",
    schemaFingerprint: "fp-legacy",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  });

  const f = fleetCensus([tenant("a"), mute, twin]);

  assert.deepEqual(f.anomalies.noSearchTool, ["mute"]);
  assert.deepEqual(f.anomalies.multipleSearchTools, ["twin"]);
  assert.deepEqual(f.tenants.map((t) => t.id), ["a", "twin"]);
  assert.equal(f.total, 2, "the mute tenant is out of the table and named above it, not missing from both");
});

test("a contract read from a URL we never declared is not vouched for", () => {
  const clean = provenanceOf("a");
  // A 308 preserves the method, so the HTTP layer follows it happily and a
  // perfectly valid tools/list comes back — from a host this registry never
  // declared. Publishing it under the declared vendor's name is the mistake.
  const moved = buildProvenance({
    declaredUrl: "https://b.example.invalid/mcp",
    at: AT,
    trace: {
      finalUrl: "https://elsewhere.example.invalid/mcp",
      hops: [{ status: 308, to: "https://elsewhere.example.invalid/mcp", preservesMethod: true }],
    },
    via: DIRECT,
    envelope: "json-rpc",
  });
  const refused = buildProvenance({
    declaredUrl: "https://c.example.invalid/mcp",
    at: AT,
    trace: { finalUrl: "https://c.example.invalid/mcp", hops: [{ status: 301, to: "https://c.example.invalid/docs", preservesMethod: false }] },
    via: null,
    envelope: null,
  });

  assert.equal(isObservation(clean), true);
  assert.equal(moved.urlMatchesDeclared, false);
  assert.equal(isObservation(moved), false, "a followed redirect still lands somewhere we did not declare");
  assert.equal(refused.refused, "redirect-would-change-method");
  assert.equal(isObservation(refused), false);
  assert.match(describeProvenance(refused), /Refused\./);
  assert.match(describeProvenance(moved), /not the declared/);

  const f = fleetCensus([
    tenant("a", { provenance: clean }),
    tenant("b", { provenance: moved }),
    tenant("c", { provenance: refused }),
  ]);
  assert.deepEqual(f.unvouched, ["b", "c"]);
  assert.equal(f.provenance.recorded, 3);
  assert.equal(f.provenance.offDeclared, 1);
  assert.equal(f.provenance.refused, 1);
});

test("a record with no provenance is not silently promoted to a vouched one", () => {
  // Every row written before the field existed carries none. "We do not know
  // how this was read" must not read as "we read it properly".
  const f = fleetCensus([tenant("a"), tenant("b")]);
  assert.equal(f.provenance.recorded, 0);
  assert.deepEqual(f.unvouched, [], "nor is it flagged as a defect — it is unknown, and says so");
  assert.equal(describeProvenance(null), "No provenance recorded for this pulse.");
});

/** Publish a fleet into a throwaway directory and hand back the artefacts. */
function publishFleet(servers, site = { url: "https://example.invalid", repo: "he110/mcp-drift-registry" }) {
  const dir = mkdtempSync(join(tmpdir(), "drift-fleet-"));
  const store = new Store(join(dir, "state"));
  for (const s of servers) {
    store.writeServer({ ...s, toolCount: s.tools.length, firstSeenAt: AT, lastCheckedAt: AT, changeCount: 0 });
  }
  const outDir = join(dir, "site");
  publish({ store, outDir, at: AT, config: { site, servers: [] } });
  const read = (p) => readFileSync(join(outDir, p), "utf8");
  return { dir, read, json: (p) => JSON.parse(read(p)) };
}

test("the census prose cannot outlive its data: two variants never print four", () => {
  // The one editorial rule this whole site rests on. Note № 01 derives every
  // threshold-dependent word from the sample; Note № 02 has to do the same, or
  // it becomes a page that was true on the day somebody typed it.
  const { dir, read, json } = publishFleet([tenant("a"), tenant("b"), tenant("c", { optional: ["version"] })]);
  try {
    const page = read("notes/fleet.html");

    assert.match(page, /3 tenants,<br><em>two contracts<\/em>/);
    assert.match(page, /two distinct schema fingerprints<\/strong> across 3 tenants/);
    assert.match(page, /Two variants, no remainder/);
    assert.ok(!page.includes("four"), "the numeral is spelled from the count, never typed into the prose");
    assert.match(page, /every variant requires <code>query<\/code> and every variant is closed/);

    // The JSON published on the same pulse is the same measurement, not a second one.
    const api = json("api/fleet.json");
    assert.equal(api.total, 3);
    assert.equal(api.variants.length, 2);
    assert.equal(api.crossProduct.complete, true);
    assert.deepEqual(api.optionalUnion, ["version"]);

    // And it is reachable from everywhere Note № 01 is.
    assert.match(read("index.html"), /notes\/fleet\.html/);
    assert.match(read("sitemap.xml"), /notes\/fleet\.html/);
    assert.match(read("notes/one-template.html"), /one-template/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an incomplete matrix changes the page, not just the JSON", () => {
  const { dir, read } = publishFleet([
    tenant("a"),
    tenant("d", { optional: ["version"] }),
    tenant("g", { optional: ["language", "version"] }),
  ]);
  try {
    const page = read("notes/fleet.html");
    assert.match(page, /Three variants, and a remainder/);
    assert.match(page, /do <strong>not<\/strong> line up with the power set/);
    assert.ok(!page.includes("no remainder"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unvouched row is marked on the census, not quietly listed as a contract", () => {
  const { dir, read } = publishFleet([
    tenant("a", { provenance: provenanceOf("a") }),
    tenant("b", {
      optional: ["version"],
      provenance: buildProvenance({
        declaredUrl: "https://b.example.invalid/mcp",
        at: AT,
        trace: {
          finalUrl: "https://elsewhere.example.invalid/mcp",
          hops: [{ status: 308, to: "https://elsewhere.example.invalid/mcp", preservesMethod: true }],
        },
        via: DIRECT,
        envelope: "json-rpc",
      }),
    }),
  ]);
  try {
    const page = read("notes/fleet.html");
    assert.match(page, /class="flag" title="[^"]*">unvouched/);
    assert.match(page, /<strong>1 row is not vouched for and is marked as such above\.<\/strong>/);
    // Counts in the prose agree in number with themselves. A page that says
    // "1 were read" is a page a reader stops believing on the next sentence.
    assert.match(page, /1 was read from a URL other than the one declared/);
    assert.ok(!page.includes("1 were read"));

    // And the server page for it does not present the contract as an observation.
    const server = read("servers/b.html");
    assert.match(server, /notice--suspect/);
    assert.match(server, /The URL read is not the URL declared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hostile tenant name and id reach the census escaped", () => {
  const evil = '<script>alert(1)</script>';
  const { dir, read } = publishFleet([
    tenant("a"),
    { ...tenant('evil"><script>alert(2)</script>', { optional: ["version"], name: evil }), url: "https://evil.example.invalid/mcp" },
  ]);
  try {
    const page = read("notes/fleet.html");
    assert.ok(!page.includes(evil), "a vendor-controlled name is not markup");
    assert.ok(!page.includes("<script>alert(2)</script>"));
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- advertised versus served -----------------------------------------------
//
// The axis added in cycle 9. Its whole risk is category confusion: a static
// disagreement between two documents is not drift, the two must never be able
// to reach the same counter, and a card read badly must never be reported as a
// vendor's defect. Every test below is about one of those three.

const cardRead = (over = {}) => ({
  id: "t",
  cardUrl: "https://docs.example.com/.well-known/mcp/server-card.json",
  status: "ok",
  provenance: buildProvenance({
    declaredUrl: "https://docs.example.com/.well-known/mcp/server-card.json",
    at: AT,
    trace: { finalUrl: "https://docs.example.com/.well-known/mcp/server-card.json", hops: [] },
    via: WELL_KNOWN,
    envelope: "json",
  }),
  card: readCard({ url: "https://docs.example.com/mcp", tools: [{ name: "search", description: "Search the docs.", inputSchema: tool().inputSchema }] }),
  ...over,
});

const servedServer = (over = {}) => ({
  id: "t",
  status: "ok",
  url: "https://docs.example.com/mcp",
  platform: "hosted",
  tools: [tool()],
  provenance: buildProvenance({
    declaredUrl: "https://docs.example.com/mcp",
    at: AT,
    trace: { finalUrl: "https://docs.example.com/mcp", hops: [] },
    via: DIRECT,
    envelope: "json-rpc",
  }),
  ...over,
});

test("a card is vouched for by the rule written for cards, not the one written for contracts", () => {
  // The bug this pins down shipped and was caught in the same hour: cards are
  // fetched with GET, `isObservation` demands one of the two *contract* paths,
  // and so every card ever read came back unvouched — a census that quietly
  // disowned all of its own evidence while still printing it.
  const p = cardRead().provenance;
  assert.equal(isObservation(p), false, "a GET is not a contract path, and must not pretend to be");
  assert.equal(isCardObservation(p), true);
  assert.equal(compareCard(cardRead(), servedServer()).vouched, true);
});

test("a card fetched off the declared host is not vouched for", () => {
  const read = cardRead({
    provenance: buildProvenance({
      declaredUrl: "https://docs.example.com/.well-known/mcp/server-card.json",
      at: AT,
      trace: { finalUrl: "https://shared.host.invalid/.well-known/mcp/server-card.json", hops: [{ status: 308, to: "https://shared.host.invalid/.well-known/mcp/server-card.json", preservesMethod: true }] },
      via: WELL_KNOWN,
      envelope: "json",
    }),
  });
  assert.equal(compareCard(read, servedServer()).vouched, false);
});

test("a tool served but not advertised is the finding; the reverse is a different finding", () => {
  const server = servedServer({ tools: [tool(), tool({ name: "submit_feedback" })] });
  const row = compareCard(cardRead(), server);
  assert.equal(row.state, "diverges");
  assert.deepEqual(
    row.divergences.filter((d) => d.kind === "served_not_advertised").map((d) => d.tool),
    ["submit_feedback"],
  );
  assert.equal(row.divergences.some((d) => d.kind === "advertised_not_served"), false);
});

test("a schema mismatch records which side said what, because the direction is the finding", () => {
  const server = servedServer({
    tools: [tool({ inputSchema: { ...tool().inputSchema, additionalProperties: false } })],
  });
  const d = compareCard(cardRead(), server).divergences.find((x) => x.kind === "schema_mismatch");
  const change = d.changes.find((c) => c.path === "additionalProperties");
  assert.equal(change.advertised, undefined, "the card omitted it");
  assert.equal(change.served, "false", "the live endpoint declared it");
});

test("a card that declines to describe an input is not a card that describes it as empty", () => {
  // `inputSchema: null` means the document said nothing. Comparing that against
  // a real schema manufactures a mismatch out of an omission, and a census that
  // does it reports the platform for our own parsing decision.
  const read = cardRead({ card: readCard({ url: "https://docs.example.com/mcp", tools: [{ name: "search", description: "Search the docs." }] }) });
  const row = compareCard(read, servedServer());
  assert.equal(row.divergences.some((d) => d.kind === "schema_mismatch"), false);
});

test("a card naming a host other than the endpoint it sits beside is recorded as such", () => {
  const read = cardRead({
    card: readCard({ url: "https://tenant.internal-build.invalid/mcp", tools: [{ name: "search", description: "Search the docs.", inputSchema: tool().inputSchema }] }),
  });
  const d = compareCard(read, servedServer()).divergences.find((x) => x.kind === "endpoint_mismatch");
  assert.deepEqual(d.advertised, ["https://tenant.internal-build.invalid/mcp"]);
  assert.equal(d.served, "https://docs.example.com/mcp");
});

test("an official-schema card advertises a location, not a catalogue, and is not counted as a defect", () => {
  const read = cardRead({
    card: readCard({ $schema: OFFICIAL_SCHEMA, name: "com.readme/x", remotes: [{ type: "streamable-http", url: "https://docs.example.com/mcp" }] }),
  });
  const row = compareCard(read, servedServer());
  assert.equal(row.state, "no_tools_advertised");
  assert.equal(row.comparable, false);
  assert.equal(row.official, true);
});

test("an unreadable card is our problem and an absent one is a fact, and they are not the same row", () => {
  assert.equal(compareCard({ id: "t", status: "absent", card: null }, servedServer()).state, "no_card");
  assert.equal(compareCard({ id: "t", status: "error", card: null }, servedServer()).state, "card_unreadable");
  assert.equal(compareCard(undefined, servedServer()).state, "card_unknown", "no reading is not a claim about the vendor");
  assert.equal(compareCard(cardRead(), servedServer({ status: "error", tools: [] })).state, "server_unreadable");
});

test("the divergence rate is taken over endpoints that publish a list, never over the fleet", () => {
  // Thirty-nine endpoints that advertise nothing cannot dilute — or inflate —
  // a statement about the ones that do. The headline is two numbers precisely
  // so that it cannot be quoted as a percentage of anything else.
  const servers = [
    { ...servedServer({ id: "a" }), card: cardRead({ id: "a" }) },
    { ...servedServer({ id: "b", tools: [tool(), tool({ name: "extra" })] }), card: cardRead({ id: "b" }) },
    { ...servedServer({ id: "c" }), card: { id: "c", status: "absent", card: null } },
  ];
  const census = advertisedCensus(servers, AT);
  assert.equal(census.total, 3);
  assert.equal(census.comparable, 2);
  assert.equal(census.diverging, 1);
  assert.equal(census.states.no_card, 1);
  assert.deepEqual(census.byPlatform, { hosted: 1 });
});

test("a divergence between two simultaneous documents never becomes a drift event", () => {
  // The invariant the whole axis rests on. K5 asks whether contracts *moved*
  // this month; a card disagreeing with its own endpoint is not movement, and
  // forty such rows landing in the event stream would answer that question with
  // a number describing one build pipeline. `buildEvents` is not given cards at
  // all — this test exists so that stays true when somebody is tempted to pass
  // them in for convenience.
  const prev = { ...servedServer(), card: cardRead() };
  const next = { ...servedServer(), card: cardRead({ card: readCard({ url: "https://elsewhere.invalid/mcp", tools: [] }) }) };
  const events = buildEvents(prev, next, AT);
  assert.deepEqual(events, [], "the card moved and the contract did not; nothing happened");
});

test("the census is reproducible from state alone, with the card it makes claims about", () => {
  // The cycle-8 rule, applied to the new axis: do not cite an artefact as proof
  // of something the artefact does not contain. A row asserting "this card omits
  // a tool" is only checkable if the card travels with it.
  const server = { ...servedServer({ tools: [tool(), tool({ name: "submit_feedback" })] }), card: cardRead() };
  const row = advertisedCensus([server], AT).rows[0];
  assert.equal(row.advertisedCount, 1);
  assert.equal(row.servedCount, 2);
  assert.equal(server.card.card.tools[0].name, "search", "the card itself is in the state the row is derived from");
});

test("a card path is derived from the origin, not glued onto the endpoint path", () => {
  assert.equal(cardUrlFor("https://docs.example.com/mcp"), "https://docs.example.com/.well-known/mcp/server-card.json");
  assert.equal(cardUrlFor("https://docs.example.com/docs/deep/mcp"), "https://docs.example.com/.well-known/mcp/server-card.json");
  assert.equal(cardUrlFor("not a url"), null);
});

test("rows collected before provenance existed are neither vouched for nor faulted", () => {
  // Three states, not two. `unvouched` means "read badly and we know it";
  // unknown is its own list, because an empty complaint list beside no other
  // number reads to a visitor as a clean bill of health for rows whose reading
  // was never recorded.
  const f = fleetCensus([tenant("a"), tenant("b")]);
  assert.deepEqual(f.unvouched, []);
  assert.deepEqual(f.unknownProvenance, ["a", "b"]);
  // The dangerous shape is the mixed one: some rows read cleanly, some never
  // recorded how they were read. With no third state the page prints "every row
  // ... vouched for" over rows it cannot describe the reading of.
  const clean = tenant("c", {
    provenance: buildProvenance({
      declaredUrl: "https://c.example.invalid/mcp",
      at: AT,
      trace: { finalUrl: "https://c.example.invalid/mcp", hops: [] },
      via: DIRECT,
      envelope: "json-rpc",
    }),
  });
  const mixed = fleetCensus([clean, tenant("a")]);
  assert.deepEqual(mixed.unvouched, []);
  assert.deepEqual(mixed.unknownProvenance, ["a"]);
  const page = publishFleet([clean, tenant("a")]).read("notes/fleet.html");
  assert.ok(!page.includes("Every row on this page is a contract this registry actually read"));
  assert.ok(page.includes("neither vouched for nor faulted"));
});
