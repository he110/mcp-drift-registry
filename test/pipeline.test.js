import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, fingerprint } from "../src/lib/canonical.js";
import { deepDiff, diffTool, classifyChange, worstSeverity } from "../src/lib/diff.js";
import { buildEvents } from "../src/lib/events.js";
import { trackReachability, FLAP_THRESHOLD, FLAP_WINDOW_MS } from "../src/lib/flap.js";
import { parseRpc } from "../src/sources/mcp.js";
import { esc, inlineCode, isUnstable, platformFamilies, publish } from "../src/publish/render.js";
import { noteFacts } from "../src/publish/note.js";
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
