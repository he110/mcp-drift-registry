import { esc } from "./html.js";
import { SIGNATURE } from "./note.js";
import { describeProvenance, isObservation, summarizeProvenance } from "../lib/provenance.js";
import { sanitize } from "../lib/store.js";

/**
 * Note № 02 — the fleet census: every tenant of one hosting template, and the
 * exact schema variant that tenant is serving right now.
 *
 * Note № 01 says *how many* variants exist. That is the interesting number and
 * it is also the useless one: an integrator does not integrate with a
 * distribution, they integrate with a named endpoint, and the only question
 * they have is "which variant will I get from this one". So this page is the
 * lookup table, one row per tenant, regenerated from `state/` on every pulse
 * exactly like the ledger.
 *
 * The same discipline as Note № 01 applies and is the reason both pages exist:
 * nothing here is written down. Counts, buckets, the cross-product check, the
 * words "four" and "complete" — all derived. If a tenant flips variant
 * overnight, this page says so tomorrow without anybody editing prose.
 */

export function fleetCensus(servers, { signature = SIGNATURE } = {}) {
  const members = (servers ?? []).filter((s) => (s.tools ?? []).some((t) => String(t.name ?? "").startsWith(signature)));

  const anomalies = { noSearchTool: [], multipleSearchTools: [] };
  const tenants = [];

  for (const s of members) {
    const search = (s.tools ?? []).filter((t) => String(t.name ?? "").startsWith("search_"));
    if (search.length === 0) {
      anomalies.noSearchTool.push(s.id);
      continue;
    }
    // Two search tools on one endpoint would mean "the tenant → variant map is
    // not a function", and the whole page would be a category error. Recorded
    // rather than silently resolved by taking the first one.
    if (search.length > 1) anomalies.multipleSearchTools.push(s.id);

    const tool = search[0];
    const schema = tool.inputSchema ?? {};
    const properties = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    tenants.push({
      id: s.id,
      name: s.name ?? s.id,
      host: hostOf(s.url),
      url: s.url ?? null,
      tool: tool.name,
      fingerprint: tool.schemaFingerprint ?? null,
      properties,
      required,
      optional: properties.filter((p) => !required.includes(p)),
      additionalProperties: schema.additionalProperties ?? null,
      provenance: s.provenance ?? null,
    });
  }

  tenants.sort((a, b) => a.id.localeCompare(b.id));

  const variants = groupVariants(tenants);
  const optionalUnion = [...new Set(variants.flatMap((v) => v.optional))].sort();

  return {
    signature,
    // The label is read off the members, not asserted about them: whatever the
    // ledger calls the majority of this fleet is what this page calls it.
    platform: modal(members.map((s) => s.platform).filter(Boolean)),
    total: tenants.length,
    tenants,
    variants,
    optionalUnion,
    crossProduct: crossProduct(variants, optionalUnion),
    invariants: invariants(variants),
    anomalies,
    provenance: summarizeProvenance(members),
    // A tenant whose row was not read over a path we vouch for has no business
    // being quoted as that tenant's contract.
    unvouched: tenants.filter((t) => t.provenance && !isObservation(t.provenance)).map((t) => t.id),
  };
}

function groupVariants(tenants) {
  const byFp = new Map();
  for (const t of tenants) {
    const key = t.fingerprint ?? `noprint:${t.properties.join(",")}`;
    const v = byFp.get(key) ?? {
      fingerprint: t.fingerprint,
      tenants: 0,
      ids: [],
      properties: t.properties,
      required: t.required,
      optional: t.optional,
      additionalProperties: t.additionalProperties,
    };
    v.tenants += 1;
    v.ids.push(t.id);
    byFp.set(key, v);
  }
  return [...byFp.values()].sort((a, b) => b.tenants - a.tenants || String(a.fingerprint).localeCompare(String(b.fingerprint)));
}

/**
 * Is the set of live variants exactly the power set of the optional parameters?
 *
 * If it is, the fleet is a feature matrix: every combination of switches is
 * somebody's production contract and there is no residue to explain. If it is
 * not, the difference is the finding — either a combination nobody runs, or two
 * variants that accept identical parameters and still fingerprint apart, which
 * means they diverge somewhere a parameter list cannot reach.
 */
function crossProduct(variants, optionalUnion) {
  const expected = 2 ** optionalUnion.length;
  const present = new Map();
  for (const v of variants) {
    const key = v.optional.join(",");
    present.set(key, [...(present.get(key) ?? []), v]);
  }
  const missing = subsets(optionalUnion)
    .map((s) => s.join(","))
    .filter((k) => !present.has(k));
  const collisions = [...present.entries()].filter(([, vs]) => vs.length > 1).map(([key, vs]) => ({
    optional: key ? key.split(",") : [],
    fingerprints: vs.map((v) => v.fingerprint),
  }));
  return {
    expected,
    observed: variants.length,
    missing,
    collisions,
    complete: missing.length === 0 && collisions.length === 0 && variants.length === expected,
  };
}

function subsets(items) {
  return items.reduce((acc, item) => [...acc, ...acc.map((s) => [...s, item])], [[]]).map((s) => [...s].sort());
}

/** What every variant agrees on. `null` where they do not agree at all. */
function invariants(variants) {
  const required = uniform(variants.map((v) => v.required.join(",")));
  const closed = uniform(variants.map((v) => JSON.stringify(v.additionalProperties)));
  return {
    required: required === null ? null : required ? required.split(",") : [],
    additionalProperties: closed === null ? null : JSON.parse(closed),
  };
}

function uniform(values) {
  if (values.length === 0) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

function modal(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted.length ? sorted[0][0] : null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function spell(n) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
}

function cap(word) {
  return String(word).charAt(0).toUpperCase() + String(word).slice(1);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** "a", "a and b", "a, b and c" — the page is prose, not a serialised array. */
function list(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// --- page -------------------------------------------------------------------

export function fleetBody(ctx) {
  const f = fleetCensus(ctx.servers);
  const origin = (ctx.meta?.origins ?? []).find((o) => o.platform && o.platform === f.platform) ?? null;
  const api = `${ctx.base}/api/fleet.json`;

  return `
<header class="note__head">
  <div class="wrap wrap--text">
    <div class="note__kicker">
      <span>MCP Drift Registry</span>
      <span>Note № 02</span>
      <span>Fleet census</span>
    </div>
    <h1 class="note__title">${f.total} tenants,<br><em>${spell(f.variants.length)} contracts</em></h1>
    <p class="note__standfirst">
      ${f.total} public endpoints run the same hosted documentation template${f.platform ? ` (<code>${esc(f.platform)}</code>)` : ""}.
      They do not serve the same contract. Here is which one each of them serves, by name, as of this pulse.
    </p>
    <div class="note__meta">
      <span class="stamp">Regenerated each pulse</span>
      <span>Every row, every count and the completeness check below are computed from the same snapshots the
      ledger renders from. <code>bin/fleet.js</code> prints this table from <code>state/</code> and cannot
      disagree with it.</span>
    </div>
  </div>
</header>

<div class="wrap wrap--text note">

  <section>
    <h2><span class="num">01</span>Why a table and not a number</h2>
    <p>Note № 01 establishes that the <code>search_*</code> tool of this template has
    <strong>${spell(f.variants.length)} distinct schema fingerprints</strong> across ${f.total} tenants. That is the
    right number for judging the sample and the wrong one for doing anything. Nobody integrates with a
    distribution: they integrate with <em>one</em> named endpoint, and the only question they have is which of
    the ${spell(f.variants.length)} they are about to get.</p>
    <p>The template's tool names embed the tenant slug, so the fingerprints differ trivially for every tenant
    and cannot be compared directly. What is compared here is the <em>shape</em> of the
    <code>search_*</code> input schema${
      f.invariants.required?.length ? `: every variant requires ${list(f.invariants.required.map((r) => `<code>${esc(r)}</code>`))}` : ""
    }${f.invariants.additionalProperties === false ? " and every variant is closed to unknown properties" : ""}.
    The variation is entirely in which optional parameters exist.</p>
  </section>

  ${variantSection(f)}

  ${censusSection(f)}

  ${originSection(origin, f)}

  <section>
    <h2><span class="num">05</span>Read it by machine</h2>
    <p>Nothing above is asserted from a hash. Every variant is published with the properties it actually
    accepts, so the table can be re-derived rather than believed:</p>
    <pre>curl -s ${esc(api)} \\
| jq '.variants[] | {tenants, required, optional, additionalProperties}'

# and the full input schema of any single endpoint, as returned to us:
curl -s ${esc(ctx.base)}/api/servers/&lt;id&gt;.json \\
| jq '.tools[] | select(.name | startswith("search_")) | .inputSchema'</pre>
    <p>The census is also regenerable locally from the committed state, with no network call at all — the
    same function this page renders from, printed to a terminal:</p>
    <pre>git clone https://github.com/${esc(ctx.site.repo ?? "")} &amp;&amp; node bin/fleet.js
node bin/fleet.js --json | jq '.tenants[] | select(.optional | length &gt; 0)'</pre>
    <p>${
      f.provenance.recorded
        ? `Of the ${f.total} rows above, ${f.provenance.direct} ${plural(f.provenance.direct, "was", "were")} read by direct POST and
    ${f.provenance.handshake} required a full <code>initialize</code> handshake;
    ${f.provenance.redirected === 0 ? "none went through a redirect" : `${f.provenance.redirected} went through a method-preserving redirect`}, and
    ${
      f.provenance.offDeclared === 0
        ? "every one of them was read from the URL this registry declares"
        : `${f.provenance.offDeclared} ${plural(f.provenance.offDeclared, "was", "were")} read from a URL other than the one declared`
    }.
    ${f.unvouched.length ? `<strong>${f.unvouched.length} ${plural(f.unvouched.length, "row is", "rows are")} not vouched for and ${plural(f.unvouched.length, "is", "are")} marked as such above.</strong>` : "Every row on this page is a contract this registry actually read over a path it will vouch for."}`
        : `Provenance for these rows is recorded from the next pulse onward; rows collected before it existed carry none.`
    }</p>
    <div class="actions">
      <a class="btn" href="../">The ledger</a>
      <a class="btn" href="one-template.html">Note № 01: the sample</a>
      <a class="btn" href="../api/fleet.json">fleet.json</a>
      <a class="btn btn--accent" href="https://github.com/${esc(ctx.site.repo ?? "")}/issues/new?title=Fleet+census%3A+&amp;body=">Tell us what this misses</a>
    </div>
  </section>

  <a class="crumb" href="../">← Back to the ledger</a>
</div>`;
}

function variantSection(f) {
  if (f.variants.length < 2) {
    return `
  <section>
    <h2><span class="num">02</span>One contract, ${f.total} tenants</h2>
    <p>On this pulse every tenant of the template serves the same <code>search_*</code> schema. The fleet is
    uniform right now; the moment it stops being, the variants appear here and the table below splits.</p>
  </section>`;
  }

  const max = f.variants[0].tenants;
  const cp = f.crossProduct;
  const rows = f.variants
    .map(
      (v) => `      <tr>
        <th scope="row"><span class="strata__props">${
          v.optional.length ? v.optional.map((p) => `<code>${esc(p)}</code>`).join("") : "<em>required only</em>"
        }</span><span class="strata__fp">${esc(v.fingerprint ?? "—")}</span></th>
        <td class="strata__cell"><span class="strata__bar" style="width:${((v.tenants / max) * 100).toFixed(1)}%"></span></td>
        <td class="strata__value">${v.tenants}</td>
      </tr>`,
    )
    .join("\n");

  return `
  <section>
    <h2><span class="num">02</span>${cap(spell(f.variants.length))} variants, ${cp.complete ? "no remainder" : "and a remainder"}</h2>
    <figure class="figure">
      <table class="strata">
        <caption class="figure__cap">Tenants per distinct <code>search_*</code> schema, this pulse. Each row is
        labelled by the <em>optional</em> parameters that schema carries beyond the required
        ${f.invariants.required?.length ? f.invariants.required.map((r) => `<code>${esc(r)}</code>`).join(", ") : "core"},
        under its fingerprint.</caption>
        <tbody>
${rows}
        </tbody>
      </table>
    </figure>
    <p>${
      cp.complete
        ? `The ${spell(f.variants.length)} variants are <strong>exactly the ${cp.expected === f.variants.length ? "" : "expected "}power set of ${
            f.optionalUnion.length === 1 ? "one optional parameter" : `the ${spell(f.optionalUnion.length)} optional parameters`
          } ${list(f.optionalUnion.map((p) => `<code>${esc(p)}</code>`))}</strong> — 2<sup>${f.optionalUnion.length}</sup> is ${cp.expected}, ${cp.expected} is what is live, and there is no leftover.
    That is a feature matrix, not drift: each tenant has some subset of switches on, every combination is
    somebody's production contract, and no combination is unaccounted for.`
        : `The variants do <strong>not</strong> line up with the power set of the optional parameters
    ${f.optionalUnion.map((p) => `<code>${esc(p)}</code>`).join(", ")} — ${cp.expected} combinations are possible and ${cp.observed} fingerprints are live.
    ${cp.missing.length ? `${cp.missing.length} ${plural(cp.missing.length, "combination is", "combinations are")} unused. ` : ""}${
      cp.collisions.length
        ? `${cp.collisions.length} ${plural(cp.collisions.length, "pair of variants accepts", "sets of variants accept")} identical parameters and still fingerprint apart, which means they diverge somewhere a parameter list cannot reach — a description, a constraint.`
        : ""
    }`
    }</p>
    <p>None of this is negotiated with the caller. There is no user, no session and no credential anywhere in
    this sample; the same anonymous request gets a different contract depending only on which tenant answers it.
    A client written against one tenant's <code>search_*</code> is not portable to the next one, and nothing in a
    <code>tools/list</code> response says which of the ${spell(f.variants.length)} it just received.</p>
  </section>`;
}

function censusSection(f) {
  const byFp = new Map(f.variants.map((v, i) => [v.fingerprint, i + 1]));
  const rows = f.tenants
    .map((t) => {
      const p = t.provenance;
      const vouched = !p || isObservation(p);
      return `<tr${vouched ? "" : ' class="ledger__row--quarantined"'}>
  <td class="ledger__name"><a href="../servers/${esc(sanitize(t.id))}.html">${esc(t.name)}</a>${
    vouched ? "" : ` <span class="flag" title="${esc(describeProvenance(p))}">unvouched</span>`
  }</td>
  <td class="ledger__vendor ledger__hide">${esc(t.host ?? "—")}</td>
  <td class="census__variant">${
    t.optional.length ? t.optional.map((o) => `<code>${esc(o)}</code>`).join(" ") : "<span class=\"census__none\">—</span>"
  }</td>
  <td class="ledger__num">${byFp.get(t.fingerprint) ?? "?"}</td>
  <td class="ledger__fp ledger__hide">${esc(t.fingerprint ?? "—")}</td>
  <td class="ledger__vendor ledger__hide">${esc(readVia(t.provenance))}</td>
</tr>`;
    })
    .join("\n");

  return `
  <section>
    <h2><span class="num">03</span>Look up the endpoint you are calling</h2>
    <p>One row per endpoint, so the question "what will <em>this</em> URL accept" has an answer that does not
    require calling it. <em>Extra parameters</em> is what this endpoint's <code>search_*</code> accepts beyond
    the required ${f.invariants.required?.length ? list(f.invariants.required.map((r) => `<code>${esc(r)}</code>`)) : "core"};
    <em>V</em> is the variant number from the table above; <em>read via</em> is how this registry obtained the
    row on the last pulse, not how the endpoint is documented.</p>
    ${
      f.anomalies.multipleSearchTools.length || f.anomalies.noSearchTool.length
        ? `<p class="notice">${
            f.anomalies.noSearchTool.length
              ? `${f.anomalies.noSearchTool.length} template ${plural(f.anomalies.noSearchTool.length, "endpoint has", "endpoints have")} no <code>search_*</code> tool at all and ${plural(f.anomalies.noSearchTool.length, "is", "are")} therefore absent from this table: ${f.anomalies.noSearchTool.map((id) => `<code>${esc(id)}</code>`).join(", ")}. `
              : ""
          }${
            f.anomalies.multipleSearchTools.length
              ? `${f.anomalies.multipleSearchTools.length} ${plural(f.anomalies.multipleSearchTools.length, "endpoint serves", "endpoints serve")} more than one <code>search_*</code> tool, so "the tenant's variant" is not well defined for ${plural(f.anomalies.multipleSearchTools.length, "it", "them")}: ${f.anomalies.multipleSearchTools.map((id) => `<code>${esc(id)}</code>`).join(", ")}.`
              : ""
          }</p>`
        : ""
    }
    <div class="census__spread">
    <table class="ledger census">
      <thead>
        <tr>
          <th>Tenant</th>
          <th class="ledger__hide">Host</th>
          <th>Extra parameters</th>
          <th class="ledger__num">V</th>
          <th class="ledger__hide">Fingerprint</th>
          <th class="ledger__hide">Read via</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
    </div>
  </section>`;
}

function readVia(p) {
  if (!p?.via) return p?.refused ? "refused" : "—";
  const base = p.via === "initialize-handshake" ? "handshake" : "direct POST";
  return p.redirected ? `${base}, redirected` : base;
}

/**
 * One more endpoint a reader might call: the template's own documented MCP URL.
 *
 * Deliberately not a row in the registry — it is not one of the endpoints this
 * page is about, it enters no count, and it earns no place in the ledger. It is
 * here for one narrow reason: it is a URL an integrator reading this page is
 * likely to try next, and this registry probed it on the same pulse with the
 * same collector, so it can say what happened rather than leave the reader to
 * find out. Published as a timestamped observation with its own provenance,
 * which is the difference between a measurement and a verdict.
 */
function originSection(origin, f) {
  if (!origin) {
    return `
  <section>
    <h2><span class="num">04</span>The template's own endpoint</h2>
    <p>Not probed on this pulse. When it is, its result appears here — outside every count above, because it
    is not one of the endpoints this census is about.</p>
  </section>`;
  }

  const healthy = origin.status === "ok";
  return `
  <section>
    <h2><span class="num">04</span>The template's own endpoint</h2>
    <p>The template${f.platform ? ` (<code>${esc(f.platform)}</code>)` : ""} documents an MCP endpoint of its own,
    <code>${esc(origin.url)}</code>. It is not one of the ${f.total} endpoints above and enters none of their
    counts, but it is a URL a reader of this page may well call next, so the same collector probes it on the
    same pulse and the result is printed here rather than left to be discovered.</p>
    <p>${
      healthy
        ? `On this pulse it answered normally, and the contract it returns is its own — not any of the ${spell(f.variants.length)} above.`
        : `<strong>On this pulse it did not answer: ${esc(origin.error ?? "unknown error")}.</strong>
      That has been the outcome on ${origin.consecutive} consecutive ${plural(origin.consecutive, "pulse", "pulses")}, since
      ${esc(String(origin.since ?? origin.at).slice(0, 16).replace("T", " "))}Z. Plan for it the way you would
      plan for any endpoint that may not answer.`
    }</p>
    <p class="notice notice--method">${esc(describeProvenance(origin.provenance))}
    One endpoint's result on one pulse, with a timestamp — not a statement about anybody's reliability or about
    the ${f.total} endpoints above, which are served by different infrastructure and are measured separately on
    this same page.</p>
  </section>`;
}
