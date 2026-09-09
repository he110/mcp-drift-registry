import { httpJson, HttpError, newTrace } from "../lib/http.js";
import { fingerprint } from "../lib/canonical.js";
import { DIRECT, HANDSHAKE, buildProvenance } from "../lib/provenance.js";

export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcp-drift-registry", version: "0.1.0" };

/**
 * Reads the tool contract of a public MCP server over Streamable HTTP.
 *
 * Verified empirically against live servers, because the spec allows two
 * behaviours and real deployments use both:
 *   - stateless servers answer `tools/list` on a bare POST;
 *   - stateful servers reject it with "Mcp-Session-Id header is required" and
 *     demand initialize -> notifications/initialized -> tools/list.
 * We try the cheap path first and fall back, rather than paying a three-request
 * handshake against every server on every run.
 *
 * Responses come back either as plain JSON or as a one-event SSE stream; both
 * shapes are parsed here so the rest of the pipeline never sees the transport.
 */
export async function collectMcpServer(server, at = new Date().toISOString()) {
  const base = {
    id: server.id,
    name: server.name ?? server.id,
    url: server.url,
    homepage: server.homepage ?? null,
    // Declared, never inferred. Two endpoints on different vendor domains can
    // be the same hosted generator, and then they are one observation wearing
    // two names — the registry has to be able to say so out loud. `null` means
    // "unknown", which is not the same as "independent".
    platform: server.platform ?? null,
    transport: "streamable-http",
  };

  try {
    const direct = await callTools(server.url, null);
    return ok(base, direct, at);
  } catch (err) {
    if (!needsSession(err)) return failed(base, err, at, server.url);
  }

  try {
    const session = await initialize(server.url);
    const withSession = await callTools(server.url, session);
    return ok(base, withSession, at, session.protocolVersion, session.serverInfo);
  } catch (err) {
    return failed(base, err, at, server.url);
  }
}

function ok(base, read, at, protocolVersion = null, serverInfo = null) {
  const result = read.result;
  const tools = (result.tools ?? [])
    .map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
      schemaFingerprint: fingerprint(t.inputSchema ?? {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...base,
    status: "ok",
    error: null,
    protocolVersion: protocolVersion ?? result.protocolVersion ?? null,
    serverInfo: serverInfo ?? null,
    provenance: buildProvenance({
      declaredUrl: base.url,
      at,
      trace: read.trace,
      via: read.via,
      envelope: read.envelope,
    }),
    tools,
    toolCount: tools.length,
    fingerprint: fingerprint(tools.map((t) => [t.name, t.description, t.inputSchema])),
  };
}

function failed(base, err, at, declaredUrl) {
  return {
    ...base,
    status: err instanceof HttpError && err.status === 401 ? "auth_required" : "error",
    error: describeError(err),
    protocolVersion: null,
    serverInfo: null,
    tools: [],
    toolCount: 0,
    fingerprint: null,
    // A failure has provenance too, and it is the more interesting half: this
    // is where a refused redirect or a non-JSON-RPC envelope gets named instead
    // of disappearing into a one-line error string.
    provenance: buildProvenance({
      declaredUrl,
      at,
      trace: err?.trace ?? null,
      via: null,
      envelope: err?.envelope ?? null,
    }),
  };
}

function describeError(err) {
  if (err instanceof HttpError) return `${err.message}${err.detail ? `: ${err.detail.slice(0, 160)}` : ""}`;
  return String(err?.message ?? err).slice(0, 200);
}

function needsSession(err) {
  const text = String(err?.message ?? "") + String(err?.detail ?? "");
  return /session/i.test(text) || (err instanceof HttpError && err.status === 400);
}

async function initialize(url) {
  const trace = newTrace(url);
  const res = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  }, null, trace).catch((err) => {
    throw attach(err, trace);
  });
  const sessionId = res.headers.get("mcp-session-id");
  let payload;
  try {
    payload = parseRpc(res.text);
  } catch (err) {
    throw attach(err, trace);
  }
  const session = {
    sessionId,
    protocolVersion: payload.protocolVersion ?? PROTOCOL_VERSION,
    serverInfo: payload.serverInfo ?? null,
  };

  // Required by spec before any other request; some servers 400 without it.
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => {});
  return session;
}

/**
 * One `tools/list` read, returned together with the trail it left.
 *
 * The trail is created here and handed to the HTTP layer, so `read.trace`
 * describes the request that produced `read.result` and cannot describe any
 * other one. That is the whole invariant: provenance and payload come back in
 * the same object or not at all.
 */
async function callTools(url, session) {
  const trace = newTrace(url);
  try {
    const res = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session, trace);
    const { result, envelope } = parseEnvelope(res.text);
    return { result, envelope, trace, via: session ? HANDSHAKE : DIRECT };
  } catch (err) {
    throw attach(err, trace);
  }
}

/** Carry the trail out with the failure; a refused request still has a method. */
function attach(err, trace) {
  if (err && typeof err === "object" && !err.trace) err.trace = trace;
  return err;
}

function post(url, body, session = null, trace = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": session?.protocolVersion ?? PROTOCOL_VERSION,
    "user-agent": "mcp-drift-registry/0.1 (+https://github.com/he110/mcp-drift-registry)",
  };
  if (session?.sessionId) headers["mcp-session-id"] = session.sessionId;
  return httpJson(url, { method: "POST", headers, body: JSON.stringify(body), retries: 1, trace });
}

/**
 * Accepts either a plain JSON-RPC body or an SSE stream carrying one, and
 * turns a JSON-RPC error into a thrown error so callers have one failure path.
 */
export function parseRpc(text) {
  return parseEnvelope(text).result;
}

/**
 * The same parse, plus the shape of the envelope it came in.
 *
 * Callers need both: "a valid JSON-RPC result" and "an SSE stream carrying one"
 * are equally acceptable and are not the same event, and when the parse is
 * refused the reason is a property of the envelope, not of the payload. The
 * refusal is tagged with what it actually was so the record can say so.
 */
export function parseEnvelope(text) {
  const trimmed = text.trim();
  let payload;
  let envelope;

  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLines = trimmed
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) throw tag(new Error("SSE response carried no data frame"), "sse");
    envelope = "sse";
    payload = JSON.parse(dataLines.join(""));
  } else {
    envelope = "json-rpc";
    try {
      payload = JSON.parse(trimmed);
    } catch (err) {
      throw tag(new Error(`response body is not JSON: ${String(err.message).slice(0, 80)}`), "not-json");
    }
  }

  if (payload === null || typeof payload !== "object") {
    throw tag(new Error("response body is not a JSON object"), "not-json-rpc");
  }

  if (payload.error) {
    const err = new Error(payload.error.message ?? "JSON-RPC error");
    err.detail = JSON.stringify(payload.error);
    throw tag(err, envelope);
  }

  // The envelope is checked, not assumed. A JSON-RPC response carries `result`
  // or `error` and nothing else counts; falling back to the whole document —
  // which this used to do — accepts any JSON that happens to have a `tools`
  // key, including a static discovery manifest served to a plain GET. That is
  // exactly how one such manifest entered the registry as a tool contract.
  if (payload.jsonrpc !== undefined && payload.jsonrpc !== "2.0") {
    throw tag(new Error(`not JSON-RPC 2.0: jsonrpc=${JSON.stringify(payload.jsonrpc)}`), "not-json-rpc");
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw tag(new Error("not a JSON-RPC response: no `result` member"), "not-json-rpc");
  }
  return { result: payload.result, envelope };
}

function tag(err, envelope) {
  err.envelope = envelope;
  return err;
}
