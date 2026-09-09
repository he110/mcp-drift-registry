import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, fingerprint } from "../src/lib/canonical.js";
import { deepDiff, diffTool, classifyChange, worstSeverity } from "../src/lib/diff.js";
import { buildEvents } from "../src/lib/events.js";
import { parseRpc } from "../src/sources/mcp.js";
import { esc, inlineCode } from "../src/publish/render.js";

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

test("an unreachable server is breaking and stops the tool diff", () => {
  const prev = server([tool()]);
  const next = server([], { status: "error", error: "fetch failed", toolCount: 0 });
  const events = buildEvents(prev, next, AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "server_unreachable");
  assert.equal(events[0].severity, "breaking");
});

test("recovery re-baselines instead of announcing every tool as new", () => {
  const prev = server([], { status: "error", error: "fetch failed", toolCount: 0 });
  const next = server([tool(), tool({ name: "fetch" })]);
  const events = buildEvents(prev, next, AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "server_recovered");
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
