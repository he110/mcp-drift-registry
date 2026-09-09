import { deepDiff, classifyChange, formatPath } from "./diff.js";
import { isCardObservation, isObservation } from "./provenance.js";
import { OFFICIAL_SCHEMA } from "../sources/card.js";

/**
 * Advertised contract versus served contract.
 *
 * Every other comparison in this repository is *temporal*: the same endpoint,
 * two moments, what moved. This one is not. It compares two things that are
 * true at the same instant — what a server publishes about itself at its
 * well-known path, and what it hands back to `tools/list` — and reports where
 * they disagree.
 *
 * That distinction is the reason none of this reaches `history.jsonl`. A
 * disagreement between two simultaneous documents is not drift, and filing it
 * as a `breaking` event would add ninety findings to a counter whose entire
 * purpose is to answer "did contracts move this month" (K5). The counter would
 * read as a busy month and would be measuring nothing. So this axis is stored
 * and published as *state*: a census, recomputed every pulse, with its own page
 * and its own JSON, and no ability to touch the event stream at all.
 *
 * Why it is worth computing regardless: the disagreement has a named owner. A
 * contract that changed is nobody's fault, but a card that omits a tool the
 * endpoint serves is a defect the platform can fix, and telling them is the
 * cheapest legitimate reason this project has ever had to write to a stranger.
 */

/** Findings, in the order a reader should care about them. */
export const KINDS = [
  "served_not_advertised",
  "advertised_not_served",
  "schema_mismatch",
  "description_mismatch",
  "endpoint_mismatch",
];

/**
 * Compare one card against one served contract.
 *
 * Returns a verdict even when there is nothing to compare, because "this
 * endpoint publishes no tool list at all" is the single most common state in
 * the fleet and a census that silently dropped those rows would report a
 * hundred-percent defect rate over the handful of endpoints that do.
 */
export function compareCard(read, server) {
  const base = {
    id: server?.id ?? read?.id ?? null,
    cardUrl: read?.cardUrl ?? null,
    cardStatus: read?.status ?? "absent",
    cardSchema: read?.card?.schema ?? null,
    // A card conforming to the official registry schema is a locator, not a
    // catalogue. Saying "it advertises nothing" would be true and misleading.
    official: read?.card?.schema === OFFICIAL_SCHEMA,
    divergences: [],
  };

  if (!read) {
    // No reading at all — a record written before this axis existed. Same
    // discipline as provenance: unknown is its own state and must not be
    // reported as "this endpoint publishes no card", which is a claim about
    // somebody else's server made on no evidence.
    return { ...base, state: "card_unknown", comparable: false, vouched: false };
  }
  if (read.status !== "ok" || !read.card) {
    // "It answered 404" is a fact about the endpoint. "We could not read it" is
    // a fact about us. Only the first one belongs in a sentence about a vendor.
    return { ...base, state: read.status === "absent" ? "no_card" : "card_unreadable", comparable: false, vouched: false };
  }
  if (!server || server.status !== "ok") {
    return { ...base, state: "server_unreadable", comparable: false, vouched: false };
  }
  if (read.card.tools === null) {
    return { ...base, state: "no_tools_advertised", comparable: false, vouched: false, cardName: read.card.name ?? null };
  }

  // Both halves must have been read over a path we vouch for. A card fetched
  // from one host and a contract read from another are not two views of the
  // same endpoint, and their disagreement would be an artefact of our own
  // plumbing rather than a finding about anybody's software.
  const vouched = isCardObservation(read.provenance) && isObservation(server.provenance);

  const advertised = new Map(read.card.tools.map((t) => [t.name, t]));
  const served = new Map((server.tools ?? []).map((t) => [t.name, t]));
  const divergences = [];

  for (const name of served.keys()) {
    if (!advertised.has(name)) divergences.push({ kind: "served_not_advertised", tool: name });
  }
  for (const name of advertised.keys()) {
    if (!served.has(name)) divergences.push({ kind: "advertised_not_served", tool: name });
  }

  for (const [name, card] of advertised) {
    const live = served.get(name);
    if (!live) continue;

    if ((card.description ?? "") !== (live.description ?? "")) {
      divergences.push({ kind: "description_mismatch", tool: name });
    }

    // `inputSchema: null` in a card means the card declined to describe the
    // input, which is not the same as describing it as `{}` — comparing the two
    // would manufacture a mismatch out of an omission.
    if (card.inputSchema === null) continue;
    const changes = deepDiff(card.inputSchema, live.inputSchema ?? {}).map((c) => ({ ...c, ...classifyChange(c) }));
    if (changes.length === 0) continue;
    divergences.push({
      kind: "schema_mismatch",
      tool: name,
      // The paths are kept because the direction of a mismatch is the finding,
      // and because assuming its consequence is how the last cycle nearly went
      // wrong. `additionalProperties: false` present live and absent in the card
      // reads like "a client trusting the card gets rejected" — it was tested on
      // six tenants and no rejection happens: unknown arguments are accepted
      // despite the declared strictness. So this records that two documents
      // disagree, which is checkable, and says nothing about what a server will
      // do, which is not.
      changes: changes.slice(0, 20).map((c) => ({
        kind: c.kind,
        severity: c.severity,
        path: formatPath(c.path),
        advertised: truncate(c.from),
        served: truncate(c.to),
      })),
    });
  }

  // Does the card point at the endpoint we read it beside? A card served by
  // docs.example.com that names a different host is either a stale deployment
  // or a different server entirely, and either way the tool comparison above is
  // comparing two things that were never claimed to match.
  const endpoints = read.card.endpoints ?? [];
  if (endpoints.length && server.url && !endpoints.includes(server.url)) {
    divergences.push({ kind: "endpoint_mismatch", advertised: endpoints, served: server.url });
  }

  return {
    ...base,
    cardName: read.card.name ?? null,
    state: divergences.length ? "diverges" : "agrees",
    comparable: true,
    vouched,
    advertisedCount: advertised.size,
    servedCount: served.size,
    divergences,
  };
}

/**
 * The fleet-wide census.
 *
 * Written to be readable as a single sentence: of N endpoints, C publish a tool
 * list, and of those C, D disagree with what they serve. Every other number on
 * the page is a breakdown of those three.
 */
export function advertisedCensus(servers, at = null) {
  // The card is read from the server record, not passed in beside it. That is
  // what makes this page reproducible from a clone with the network unplugged:
  // whatever the site claims about a card, the committed state contains the
  // card it claims it about.
  const rows = (servers ?? []).map((s) => compareCard(s.card, s)).sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const comparable = rows.filter((r) => r.comparable);
  const diverging = comparable.filter((r) => r.state === "diverges");

  const byKind = {};
  for (const kind of KINDS) byKind[kind] = diverging.filter((r) => r.divergences.some((d) => d.kind === kind)).length;

  return {
    at,
    total: rows.length,
    states: tallyBy(rows, (r) => r.state),
    // The headline. Deliberately two numbers and not a percentage of the fleet:
    // a rate over endpoints that publish nothing to compare would be a rate
    // about our sample, not about anybody's software.
    comparable: comparable.length,
    diverging: diverging.length,
    byKind,
    // A card can be wrong about a platform only if the platform generated it.
    byPlatform: tallyBy(diverging, (r) => platformOf(servers, r.id) ?? "(unlabelled)"),
    official: rows.filter((r) => r.official).length,
    unvouched: comparable.filter((r) => !r.vouched).map((r) => r.id),
    rows,
  };
}

function platformOf(servers, id) {
  return (servers ?? []).find((s) => s.id === id)?.platform ?? null;
}

function tallyBy(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function truncate(value) {
  if (value === undefined) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}
