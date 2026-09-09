import { httpJson, HttpError, newTrace } from "../lib/http.js";
import { buildProvenance, WELL_KNOWN } from "../lib/provenance.js";

/**
 * The tool list a server *advertises about itself*, as opposed to the one it
 * serves.
 *
 * MCP endpoints publish a discovery document at a well-known path so a client
 * can learn what a server offers without opening a session. Mintlify's own
 * documentation tells integrators to read it "instead of calling initialize" —
 * which makes the document a contract in its own right, and makes any gap
 * between it and the live `tools/list` a defect somebody owns.
 *
 * This module only *reads* the claim. It does not compare it to anything; the
 * comparison lives in `lib/advertised.js`, because a claim that was read badly
 * and a claim that disagrees with reality are two different findings and must
 * not be able to masquerade as each other.
 */

export const CARD_PATH = "/.well-known/mcp/server-card.json";

/** The official registry schema. Cards carrying it describe *where* a server
 *  is, not *what it offers* — `remotes`, no `tools`. That is not a defect, and
 *  the shape is recorded so the census can say so out loud rather than counting
 *  a legitimately toolless card as a server that advertises nothing. */
export const OFFICIAL_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

export function cardUrlFor(serverUrl) {
  try {
    return new URL(CARD_PATH, new URL(serverUrl).origin).toString();
  } catch {
    return null;
  }
}

/**
 * One GET for one server's card, with the trail it left.
 *
 * A GET is idempotent, so unlike the contract probe this one may follow any
 * redirect without changing what it asked for. What it must still refuse to do
 * is *vouch* for a card that arrived from a different host than the one whose
 * card we asked for: a docs site that 308s to a shared origin will happily
 * serve a card, and printing it under the vendor's name is the same mistake
 * that put one host's contract under another host's row in cycle 6.
 */
export async function collectServerCard(server, at = new Date().toISOString()) {
  const url = cardUrlFor(server.url);
  const base = { id: server.id, cardUrl: url, at };

  if (!url) return { ...base, status: "no_url", error: "server URL is not absolute", card: null, provenance: null };

  const trace = newTrace(url);
  try {
    const res = await httpJson(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "mcp-drift-registry/0.1 (+https://github.com/he110/mcp-drift-registry)",
      },
      retries: 1,
      trace,
    });
    const provenance = buildProvenance({ declaredUrl: url, at, trace, via: WELL_KNOWN, envelope: "json" });
    let parsed;
    try {
      parsed = JSON.parse(res.text.trim());
    } catch (err) {
      return { ...base, status: "not_json", error: String(err.message).slice(0, 120), card: null, provenance };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...base, status: "not_json", error: "card is not a JSON object", card: null, provenance };
    }
    return { ...base, status: "ok", error: null, card: readCard(parsed), provenance };
  } catch (err) {
    return {
      ...base,
      status: err instanceof HttpError && err.status === 404 ? "absent" : "error",
      error: describeError(err),
      card: null,
      provenance: buildProvenance({ declaredUrl: url, at, trace, via: null, envelope: null }),
    };
  }
}

/**
 * The two card shapes seen in the wild, read into one record.
 *
 * `tools: null` and `tools: []` are kept apart on purpose. "This document does
 * not describe tools" and "this document says the server has no tools" are
 * different claims, and only the second one can be wrong about a server that
 * serves three.
 */
export function readCard(raw) {
  const tools = Array.isArray(raw.tools)
    ? raw.tools
        .filter((t) => t && typeof t === "object" && typeof t.name === "string")
        .map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : null;

  const remotes = Array.isArray(raw.remotes)
    ? raw.remotes.filter((r) => r && typeof r.url === "string").map((r) => ({ type: r.type ?? null, url: r.url }))
    : null;

  return {
    schema: typeof raw.$schema === "string" ? raw.$schema : null,
    name: typeof raw.name === "string" ? raw.name : null,
    version: typeof raw.version === "string" ? raw.version : null,
    // Where the card says the endpoint is. Two spellings, because the official
    // schema puts it in `remotes` and the hosted generator puts it in `url`.
    endpoints: [...(typeof raw.url === "string" ? [raw.url] : []), ...(remotes ?? []).map((r) => r.url)],
    remotes,
    tools,
    toolCount: tools?.length ?? null,
  };
}

function describeError(err) {
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  return String(err?.message ?? err).slice(0, 160);
}
