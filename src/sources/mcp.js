import { httpJson, HttpError } from "../lib/http.js";
import { fingerprint } from "../lib/canonical.js";

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
export async function collectMcpServer(server) {
  const base = {
    id: server.id,
    name: server.name ?? server.id,
    url: server.url,
    homepage: server.homepage ?? null,
    transport: "streamable-http",
  };

  try {
    const direct = await callTools(server.url, null);
    return ok(base, direct);
  } catch (err) {
    if (!needsSession(err)) return failed(base, err);
  }

  try {
    const session = await initialize(server.url);
    const withSession = await callTools(server.url, session);
    return ok(base, withSession, session.protocolVersion, session.serverInfo);
  } catch (err) {
    return failed(base, err);
  }
}

function ok(base, result, protocolVersion = null, serverInfo = null) {
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
    tools,
    toolCount: tools.length,
    fingerprint: fingerprint(tools.map((t) => [t.name, t.description, t.inputSchema])),
  };
}

function failed(base, err) {
  return {
    ...base,
    status: err instanceof HttpError && err.status === 401 ? "auth_required" : "error",
    error: describeError(err),
    protocolVersion: null,
    serverInfo: null,
    tools: [],
    toolCount: 0,
    fingerprint: null,
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
  const res = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const sessionId = res.headers.get("mcp-session-id");
  const payload = parseRpc(res.text);
  const session = {
    sessionId,
    protocolVersion: payload.protocolVersion ?? PROTOCOL_VERSION,
    serverInfo: payload.serverInfo ?? null,
  };

  // Required by spec before any other request; some servers 400 without it.
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => {});
  return session;
}

async function callTools(url, session) {
  const res = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
  return parseRpc(res.text);
}

function post(url, body, session = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": session?.protocolVersion ?? PROTOCOL_VERSION,
    "user-agent": "mcp-drift-registry/0.1 (+https://github.com/he110/mcp-drift-registry)",
  };
  if (session?.sessionId) headers["mcp-session-id"] = session.sessionId;
  return httpJson(url, { method: "POST", headers, body: JSON.stringify(body), retries: 1 });
}

/**
 * Accepts either a plain JSON-RPC body or an SSE stream carrying one, and
 * turns a JSON-RPC error into a thrown error so callers have one failure path.
 */
export function parseRpc(text) {
  const trimmed = text.trim();
  let payload;

  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLines = trimmed
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) throw new Error("SSE response carried no data frame");
    payload = JSON.parse(dataLines.join(""));
  } else {
    payload = JSON.parse(trimmed);
  }

  if (payload.error) {
    const err = new Error(payload.error.message ?? "JSON-RPC error");
    err.detail = JSON.stringify(payload.error);
    throw err;
  }
  return payload.result ?? payload;
}
