/**
 * How a record was obtained, recorded by the code that obtained it.
 *
 * Cycle 6 published a non-observation as an observation and nothing in the
 * pipeline noticed: a declared endpoint answered 301, the redirect turned the
 * POST into a GET, and the static discovery manifest that came back was read as
 * a `tools/list` result. The envelope check now stops that particular defect —
 * but the class of defect is "we read something other than what we think we
 * read", and a check only covers the instances someone already thought of.
 *
 * So every record carries its own method: the URL that was actually opened,
 * whether that is the URL we declared, what redirect (if any) stood between
 * them, which of the two contract paths was taken, and what shape of envelope
 * came back. It is built from the trail the HTTP layer filled in while
 * requesting, never reconstructed afterwards from the declaration — a
 * reconstruction is exactly the thing that was wrong last time.
 */

/** The two ways a contract can be read. Anything else is not an observation. */
export const DIRECT = "direct-post";
export const HANDSHAKE = "initialize-handshake";

export function buildProvenance({ declaredUrl, at, trace = null, via = null, envelope = null }) {
  const hops = trace?.hops ?? [];
  const observedUrl = trace?.finalUrl ?? null;
  const methodChangingRedirect = hops.some((h) => h.preservesMethod === false);

  return {
    at,
    declaredUrl: declaredUrl ?? null,
    // `null` means the request never got far enough to open a connection —
    // DNS failure, abort, refusal before the first hop. It is not "the same".
    observedUrl,
    urlMatchesDeclared: observedUrl === null ? null : observedUrl === declaredUrl,
    redirected: hops.length > 0,
    redirects: hops.map((h) => ({ status: h.status, to: h.to, preservesMethod: h.preservesMethod === true })),
    // Which path produced the contract. `null` means none did, and then this
    // record is not an observation of a contract at all.
    via,
    // "json-rpc" (plain body) or "sse" (one-event stream). Anything the parser
    // refused is reported as what it was, so the reason is legible.
    envelope,
    methodChangingRedirect,
    refused: methodChangingRedirect && via === null ? "redirect-would-change-method" : null,
  };
}

/**
 * An observation is a contract read over a path we are willing to vouch for.
 *
 * Three conditions, and the third is the one that is easy to drop. A record is
 * an observation when a contract path actually produced it, when no redirect
 * turned the POST into something else on the way — and when the URL that
 * answered is the URL this registry declared. The last one matters because the
 * registry does not publish contracts, it publishes *this vendor's* contract:
 * a 308 to somewhere else is followed happily by the HTTP layer and yields a
 * perfectly valid `tools/list` result, which is exactly the shape of the
 * mistake worth catching. Vouching for it would mean printing one host's schema
 * under another host's name.
 */
export function isObservation(p) {
  return (
    (p?.via === DIRECT || p?.via === HANDSHAKE) &&
    p?.methodChangingRedirect !== true &&
    p?.urlMatchesDeclared !== false
  );
}

/** One sentence, for a reader who wants to know what they are looking at. */
export function describeProvenance(p) {
  if (!p) return "No provenance recorded for this pulse.";

  if (p.refused === "redirect-would-change-method") {
    const hop = p.redirects.find((h) => !h.preservesMethod) ?? {};
    return (
      `Refused. The declared URL answered HTTP ${hop.status ?? "3xx"} to ${hop.to ?? "an unnamed target"}, ` +
      `which would have turned the POST into a GET and returned whatever that host serves to a browser. ` +
      `No contract was read, and nothing here is presented as an observation.`
    );
  }

  if (!p.via) {
    return `No contract was read on this pulse: ${p.observedUrl ? `${p.observedUrl} was reached and did not answer usably` : "the endpoint was never reached"}.`;
  }

  const where = p.urlMatchesDeclared
    ? "the declared URL"
    : `${p.observedUrl} — not the declared ${p.declaredUrl}`;
  const hop = p.redirected
    ? ` after ${p.redirects.length === 1 ? "one" : p.redirects.length} method-preserving redirect${p.redirects.length === 1 ? "" : "s"} (${p.redirects.map((h) => h.status).join(", ")})`
    : " with no redirect";
  const how = p.via === HANDSHAKE ? "a full initialize handshake" : "a direct POST";
  const shape = p.envelope === "sse" ? "an SSE-framed JSON-RPC result" : "a plain JSON-RPC result";
  return `Read from ${where}${hop}, over ${how}. The response was ${shape}.`;
}

/** Registry-wide provenance, for the page that has to show it at a glance. */
export function summarizeProvenance(servers) {
  const s = {
    recorded: 0,
    direct: 0,
    handshake: 0,
    redirected: 0,
    offDeclared: 0,
    sse: 0,
    json: 0,
    refused: 0,
    unread: 0,
  };
  for (const server of servers ?? []) {
    const p = server?.provenance;
    if (!p) continue;
    s.recorded += 1;
    if (p.via === DIRECT) s.direct += 1;
    else if (p.via === HANDSHAKE) s.handshake += 1;
    else s.unread += 1;
    if (p.redirected) s.redirected += 1;
    if (p.urlMatchesDeclared === false) s.offDeclared += 1;
    if (p.envelope === "sse") s.sse += 1;
    if (p.envelope === "json-rpc") s.json += 1;
    if (p.refused) s.refused += 1;
  }
  return s;
}
