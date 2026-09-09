import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { STYLESHEET } from "./theme.js";
import { esc, inlineCode } from "./html.js";
import { noteBody } from "./note.js";
import { fleetBody, fleetCensus } from "./fleet.js";
import { describeProvenance, isObservation, summarizeProvenance } from "../lib/provenance.js";
import { sanitize } from "../lib/store.js";

export { esc, inlineCode };

/**
 * Publishes the whole surface area from one state directory: the site, the
 * Atom feed and the static JSON API.
 *
 * All three read the same event stream, so they cannot disagree. That matters
 * more than it sounds: the previous product line died partly because a
 * monitoring product that contradicts itself is unrecoverable — a subscriber
 * who sees an alert with no matching entry in the history stops trusting every
 * other alert too.
 */
export function publish({ store, outDir, config, at }) {
  const site = config.site ?? {};
  const base = (site.url ?? "").replace(/\/$/, "");
  const history = store.readHistory();
  const meta = store.readMeta();
  const declared = new Map((config.servers ?? []).map((s) => [s.id, s]));
  // Records written before `platform` existed do not carry it; fall back to the
  // declaration so `--publish-only` tells the truth without waiting for a pulse.
  const servers = store
    .listServers()
    .map((s) => ({ ...s, platform: s.platform ?? declared.get(s.id)?.platform ?? null }));

  const events = [...history].reverse();
  const ctx = { site, base, servers, events, meta, declared, at };

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  write(join(outDir, ".nojekyll"), "");
  write(join(outDir, "assets/style.css"), STYLESHEET);
  write(join(outDir, "index.html"), renderIndex(ctx));
  write(join(outDir, "notes/one-template.html"), renderNote(ctx));
  write(join(outDir, "notes/fleet.html"), renderFleet(ctx));
  write(join(outDir, "events.atom"), renderAtom(ctx));
  write(join(outDir, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  write(join(outDir, "sitemap.xml"), renderSitemap(ctx));

  for (const server of servers) {
    write(join(outDir, "servers", `${sanitize(server.id)}.html`), renderServer(server, ctx));
  }

  // Static JSON API. No CORS config needed: GitHub Pages serves `*`.
  writeJson(join(outDir, "api/registry.json"), {
    generatedAt: at,
    site: base,
    counts: counts(ctx),
    provenance: summarizeProvenance(servers),
    servers: servers.map(summarize),
  });
  writeJson(join(outDir, "api/events.json"), { generatedAt: at, count: events.length, events: events.slice(0, 500) });
  writeJson(join(outDir, "api/fleet.json"), { generatedAt: at, ...fleetCensus(servers) });
  writeJson(join(outDir, "api/meta.json"), { generatedAt: at, ...meta });
  for (const server of servers) {
    writeJson(join(outDir, "api/servers", `${sanitize(server.id)}.json`), {
      generatedAt: at,
      ...server,
      // Always explicit in the API even though the state file omits the default,
      // so a consumer never has to know that a missing key means "stable".
      stability: stability(server),
      flapCount: (server.reachability ?? []).length,
      platform: server.platform ?? null,
      provenance: server.provenance ?? null,
      // The one-line reading of the object above, so a consumer does not have
      // to reimplement the interpretation to know what it is holding.
      provenanceSummary: describeProvenance(server.provenance),
      observed: server.provenance ? isObservation(server.provenance) : null,
      events: events.filter((e) => e.server === server.id).slice(0, 200),
    });
  }
}

// --- pages ------------------------------------------------------------------

function renderIndex(ctx) {
  const { site, base, servers, events, meta } = ctx;
  const c = counts(ctx);
  const recent = events.slice(0, 40);
  const issueUrl = `https://github.com/${site.repo}/issues/new`;

  const body = `
<header class="masthead">
  <div class="wrap">
    <div class="masthead__kicker">
      <span>Model Context Protocol</span>
      <span>Bulletin № ${String(meta.runs ?? 0).padStart(4, "0")}</span>
      <span>${esc(shortDate(meta.lastRunAt ?? ctx.at))}</span>
      <span>${meta.canary?.healthy === false ? "Instrument fault" : "Instrument nominal"}</span>
    </div>
    <div class="masthead__grid">
      <h1 class="masthead__title">MCP Drift<br><em>Registry</em></h1>
      <div>
        <p class="masthead__lede">
          Public MCP servers publish a tool contract and change it without notice: no versions,
          no deprecation policy, no changelog feed. This registry reads
          <code>tools/list</code> from ${c.servers} of them on a schedule, canonicalises every
          schema and records the difference. <strong>Deterministic, no model in the loop.</strong>
        </p>
        <p class="masthead__caveat">
          Read the row count with its caveat: those ${c.servers} endpoints resolve to
          <strong>${c.platformFamilies} independent contract families</strong>${
            c.largestPlatform
              ? `, because ${c.largestPlatform.servers} of them are served by a single hosted platform (<code>${esc(c.largestPlatform.platform)}</code>)`
              : ""
          }. One template change there moves dozens of rows on the same day, and that is one event, not dozens.
          <a href="notes/one-template.html">How that was measured &rarr;</a>
          <a href="notes/fleet.html">Which contract each of them serves &rarr;</a>
        </p>
        <div class="key">
          <div class="key__row"><span class="sev sev--breaking">breaking</span><span>a parameter or enum value disappeared, a type changed, or a field became required</span></div>
          <div class="key__row"><span class="sev sev--additive">additive</span><span>something was added that existing callers can ignore</span></div>
          <div class="key__row"><span class="sev sev--cosmetic">cosmetic</span><span>wording, titles, examples — no change to the wire contract</span></div>
          <div class="key__row"><span class="sev sev--operational">unstable</span><span>the <em>host</em> went up and down four times in seven days. Says nothing about its contract, which is still diffed and reported</span></div>
        </div>
      </div>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="readout">
    <div class="readout__cell"><span class="readout__value">${c.servers}</span><span class="readout__label">Servers tracked</span></div>
    <div class="readout__cell readout__cell--aside"><span class="readout__value">${c.platformFamilies}</span><span class="readout__label">Independent families</span></div>
    <div class="readout__cell"><span class="readout__value">${c.tools}</span><span class="readout__label">Tools observed</span></div>
    <div class="readout__cell${c.breaking ? " readout__cell--alarm" : ""}"><span class="readout__value">${c.breaking}</span><span class="readout__label">Breaking changes</span></div>
    <div class="readout__cell${c.silent ? " readout__cell--alarm" : ""}"><span class="readout__value">${c.silent}</span><span class="readout__label">Silent drifts</span></div>
    <div class="readout__cell readout__cell--aside"><span class="readout__value">${c.unstable}</span><span class="readout__label">Quarantined hosts</span></div>
    <div class="readout__cell"><span class="readout__value">${meta.runs ?? 0}</span><span class="readout__label">Pulses recorded</span></div>
  </div>

  <section>
    <div class="section__head">
      <h2><span class="num">01</span>Latest drift</h2>
      <p class="section__note">Newest first. A <em>silent drift</em> is a schema change shipped while the
      human-readable description stayed byte-identical — the case no changelog and no RSS feed can report.</p>
    </div>
    ${recent.length ? recent.map(renderEvent).join("\n") : `<p class="empty">Baseline recorded, no drift observed yet. The first pulse establishes the reference snapshot; changes appear from the next one onward.</p>`}
  </section>

  <section>
    <div class="section__head">
      <h2><span class="num">02</span>The ledger</h2>
      <p class="section__note">Fingerprint is a SHA-256 over the canonicalised tool set. Identical fingerprint, identical contract.
      Rows sharing a <em>platform</em> are not independent observations. Rows marked <span class="flag">unstable</span> are under
      reachability quarantine: their up/down events are withheld, their contract is still diffed.</p>
    </div>
    <table class="ledger">
      <thead>
        <tr>
          <th>Server</th>
          <th class="ledger__hide">Vendor</th>
          <th class="ledger__hide">Platform</th>
          <th class="ledger__num">Tools</th>
          <th class="ledger__num">Changes</th>
          <th class="ledger__hide">Last change</th>
          <th class="ledger__hide">Fingerprint</th>
        </tr>
      </thead>
      <tbody>
        ${servers.map((s) => renderLedgerRow(s, ctx)).join("\n")}
      </tbody>
    </table>
  </section>

  <section>
    <div class="section__head"><h2><span class="num">03</span>Read it by machine</h2></div>
    <div class="cols">
      <div class="panel">
        <div class="panel__title">Atom</div>
        <p>Every recorded change, oldest to newest, with severity in the title. Point a feed reader or a CI job at it.</p>
        <pre>${esc(base)}/events.atom</pre>
      </div>
      <div class="panel">
        <div class="panel__title">JSON API</div>
        <p>Static, versionless, CORS-open. No key, no rate limit, no account.</p>
        <pre>GET ${esc(base)}/api/registry.json
GET ${esc(base)}/api/events.json
GET ${esc(base)}/api/servers/&lt;id&gt;.json</pre>
      </div>
      <div class="panel">
        <div class="panel__title">Method</div>
        <p><strong>No language model decides anything here.</strong> Schemas are canonicalised — keys sorted, whitespace dropped — then compared structurally. A change is <span class="sev sev--breaking">breaking</span> when a parameter or enum value disappears, a type changes, or a field becomes required.</p>
        <p>A heartbeat canary runs every pulse against a source guaranteed to move, because &ldquo;nothing changed&rdquo; and &ldquo;the collector is broken&rdquo; otherwise look identical.</p>
      </div>
    </div>
    <div class="actions">
      <a class="btn" href="notes/one-template.html">Note № 01: the sample</a>
      <a class="btn" href="notes/fleet.html">Note № 02: the fleet census</a>
      <a class="btn" href="events.atom">Atom feed</a>
      <a class="btn" href="api/registry.json">registry.json</a>
      <a class="btn btn--accent" href="${esc(issueUrl)}?title=Add+server%3A+&amp;body=Endpoint+URL%3A%0AWhy+it+belongs+in+the+registry%3A">Submit a server</a>
      <a class="btn" href="https://github.com/${esc(site.repo)}">Source</a>
    </div>
  </section>

  <section>
    <div class="section__head"><h2><span class="num">04</span>Instrument status</h2></div>
    <div class="cols">
      <div class="panel">
        <div class="panel__title">Canary</div>
        <p>${meta.canary?.healthy === false
          ? `<strong style="color:var(--breaking)">Fault.</strong> ${esc(meta.canary.error ?? "unknown")}`
          : `<strong>Healthy.</strong> Reference source last moved ${esc(shortDate(meta.canary?.lastChangeAt))}; the collector and the diff path are both confirmed live.`}</p>
      </div>
      <div class="panel">
        <div class="panel__title">Coverage</div>
        <p>${c.servers} endpoints checked on the last pulse: ${c.ok} counted healthy, ${c.unstable} in reachability
        quarantine, ${c.unreachable} unreachable${c.unreachable ? " — recorded as an event, not swallowed" : ""}.</p>
        <p>${
          c.unstable
            ? `${c.unstable === 1 ? "One host has" : `${c.unstable} hosts have`} gone up and down four or more times in seven days, so ${c.unstable === 1 ? "its" : "their"} availability events are withheld as noise and ${c.unstable === 1 ? "it does" : "they do"} not count toward the healthy total. ${c.unstable === 1 ? "Its contract is" : "Their contracts are"} still read and still diffed — an unreliable host is not a broken contract.`
            : "No host is flapping; the quarantine is empty. It fills at four up/down transitions in seven days and empties on its own."
        }</p>
      </div>
      <div class="panel">
        <div class="panel__title">Sample concentration</div>
        <p>${c.servers} endpoints, ${c.platformFamilies} independent contract families. Each declared platform counts once; each
        endpoint with no identified platform counts as its own, since an unlabelled server is unproven, not proven independent.</p>
        ${
          Object.keys(c.platforms).length
            ? `<ul class="tool__params">${Object.entries(c.platforms)
                .map(([p, n]) => `<li><span class="tool__param"><code>${esc(p)}</code></span><span class="tool__type">${n} endpoints</span></li>`)
                .join("")}<li><span class="tool__param">unlabelled</span><span class="tool__type">${c.unlabelledPlatform} endpoints</span></li></ul>`
            : ""
        }
      </div>
      <div class="panel">
        <div class="panel__title">How the rows were read</div>
        ${
          c.provenance.recorded
            ? `<p>${c.provenance.direct} of ${c.provenance.recorded} contracts came back from a direct <code>POST</code>;
        ${c.provenance.handshake} needed a full <code>initialize</code> handshake. ${
          c.provenance.sse ? `${c.provenance.sse} arrived as an SSE stream rather than a plain body. ` : ""
        }${
          c.provenance.redirected
            ? `${c.provenance.redirected} went through a method-preserving redirect`
            : "None went through a redirect"
        }, and ${
          c.provenance.offDeclared
            ? `<strong>${c.provenance.offDeclared} ${c.provenance.offDeclared === 1 ? "was" : "were"} read from a URL other than the declared one</strong>`
            : "every one was read from the URL declared here"
        }.</p>
        <p>${
          c.provenance.refused
            ? `<strong>${c.provenance.refused} endpoint${c.provenance.refused === 1 ? "" : "s"} answered with a redirect that would have turned the probe into a page request.</strong> Refused rather than followed: the record says so and carries no contract.`
            : "A redirect that would change the method is refused, not followed — a page fetched instead of an endpoint is not an observation, and every record says which of the two it is."
        }</p>`
            : `<p>Provenance is recorded from the pulse that introduced it onward. Records written earlier carry
        none, and say so rather than implying a method they never had.</p>`
        }
      </div>
      <div class="panel">
        <div class="panel__title">Schedule</div>
        <p>Pulses are idempotent against the last committed snapshot, so a delayed or skipped run costs latency and nothing else. First pulse ${esc(shortDate(meta.firstRunAt))}.</p>
      </div>
    </div>
  </section>
</div>`;

  return page({
    ctx,
    title: site.title ?? "MCP Drift Registry",
    description: site.tagline ?? "",
    canonical: `${base}/`,
    assets: "",
    body,
  });
}

/**
 * The note is a page of the bulletin, not a blog: it argues about the sample
 * the ledger is drawn from, so it is rendered from the same `ctx` on the same
 * pulse and cannot fall out of step with the numbers it is arguing about.
 */
function renderNote(ctx) {
  const c = counts(ctx);
  return page({
    ctx,
    title: `${c.servers} servers is not ${c.servers} observations — MCP Drift Registry`,
    description: `${c.servers} public MCP endpoints resolve to ${c.platformFamilies} independent contract families. What is actually behind the row count, measured every pulse.`,
    canonical: `${ctx.base}/notes/one-template.html`,
    assets: "../",
    body: noteBody(ctx, c),
  });
}

/**
 * The census is the same page discipline as the note: rendered from `ctx` on
 * the pulse that produced the state, so the table and the ledger are the same
 * measurement rendered twice rather than two measurements that agree today.
 */
function renderFleet(ctx) {
  const f = fleetCensus(ctx.servers);
  return page({
    ctx,
    title: `${f.total} tenants of one MCP template, ${f.variants.length} contracts — MCP Drift Registry`,
    description: `Which schema variant each of the ${f.total} tenants of the ${f.platform ?? "shared"} MCP docs template is serving, by name, regenerated every pulse.`,
    canonical: `${ctx.base}/notes/fleet.html`,
    assets: "../",
    body: fleetBody(ctx),
  });
}

function renderServer(server, ctx) {
  const { site, base } = ctx;
  const declared = ctx.declared.get(server.id) ?? {};
  const own = ctx.events.filter((e) => e.server === server.id);
  const tools = server.tools ?? [];

  const body = `
<div class="wrap">
  <a class="crumb" href="../index.html">&larr; MCP Drift Registry</a>
</div>
<header class="masthead">
  <div class="wrap">
    <div class="masthead__kicker">
      <span>${esc(declared.vendor ?? "Unknown vendor")}</span>
      <span>${esc(server.status)}${isUnstable(server) ? " · unstable" : ""}</span>
      <span>${server.platform ? esc(server.platform) : "platform unidentified"}</span>
      <span>${tools.length} tools</span>
      <span>${own.length} recorded changes</span>
    </div>
    <h1 class="masthead__title">${esc(server.name)}</h1>
    <p class="masthead__lede">
      <code>${esc(server.url)}</code><br>
      Fingerprint <strong>${esc(server.fingerprint ?? "—")}</strong> · first seen ${esc(shortDate(server.firstSeenAt))} ·
      last checked ${esc(shortDate(server.lastCheckedAt))}${server.lastChangedAt ? ` · last change ${esc(shortDate(server.lastChangedAt))}` : ""}.
      ${declared.homepage ? `<a href="${esc(declared.homepage)}">Vendor documentation</a>.` : ""}
    </p>
    ${
      isUnstable(server)
        ? `<p class="notice"><span class="flag">unstable</span> This host recorded
          ${(server.reachability ?? []).length} up/down transitions in the last seven days, so it is under reachability
          quarantine: its <em>unreachable</em> and <em>recovered</em> events are withheld from the feed and it is not counted
          as a healthy endpoint. <strong>This is a statement about the host, not about its contract.</strong> Tool additions,
          removals and schema changes below are recorded exactly as for any other server. Quarantine lifts on its own once
          the transitions age out of the window.</p>`
        : ""
    }
    ${
      server.platform
        ? `<p class="notice">Contract generated by the <code>${esc(server.platform)}</code> platform, which also serves other
          endpoints in this registry. A change here is likely to appear on all of them at once — count it as one event.</p>`
        : ""
    }
    ${renderProvenance(server)}
  </div>
</header>

<div class="wrap">
  <section>
    <div class="section__head">
      <h2><span class="num">01</span>Change history</h2>
      <p class="section__note">Everything this registry has observed for this endpoint.</p>
    </div>
    ${own.length ? own.map(renderEvent).join("\n") : `<p class="empty">No changes since the baseline snapshot.</p>`}
  </section>

  <section>
    <div class="section__head">
      <h2><span class="num">02</span>Current contract</h2>
      <p class="section__note">As returned by <code>tools/list</code> on the last successful pulse.
      ${esc(describeProvenance(server.provenance))}</p>
    </div>
    ${server.status !== "ok"
      ? `<p class="empty">Endpoint did not answer: ${esc(server.error ?? "unknown error")}</p>`
      : tools.map(renderTool).join("\n")}
  </section>

  <section>
    <div class="section__head"><h2><span class="num">03</span>Machine access</h2></div>
    <pre>GET ${esc(base)}/api/servers/${esc(sanitize(server.id))}.json</pre>
    <div class="actions">
      <a class="btn" href="../api/servers/${esc(sanitize(server.id))}.json">JSON</a>
      <a class="btn" href="../events.atom">Atom feed</a>
      <a class="btn" href="https://github.com/${esc(site.repo)}">Source</a>
    </div>
  </section>
</div>`;

  return page({
    ctx,
    title: `${server.name} — MCP Drift Registry`,
    description: `Tool contract and change history for the ${server.name} MCP server.`,
    canonical: `${base}/servers/${sanitize(server.id)}.html`,
    assets: "../",
    body,
  });
}

// --- fragments --------------------------------------------------------------

function renderEvent(e) {
  const changes = (e.changes ?? []).slice(0, 8);
  return `<article class="event reveal">
  <div class="event__when">${esc(shortDateTime(e.at))}</div>
  <div class="event__body">
    <div class="event__line">
      <span class="sev sev--${esc(e.severity)}">${esc(e.severity)}</span>
      <span class="event__server">${esc(e.serverName ?? e.server)}</span>
      ${e.silent ? `<span class="stamp">Silent drift</span>` : ""}
    </div>
    <div class="event__summary">${inlineCode(e.summary)}</div>
    ${changes.length
      ? `<ul class="changes">${changes
          .map(
            (c) =>
              `<li><span class="changes__kind">${esc(c.kind)}</span><span class="changes__path">${esc(c.path)}</span>${
                c.to !== undefined && c.from !== undefined ? `<span class="tool__type">${esc(String(c.from))} &rarr; ${esc(String(c.to))}</span>` : ""
              }</li>`,
          )
          .join("")}${(e.changes ?? []).length > changes.length ? `<li><span class="changes__kind">…</span><span class="changes__path">${(e.changes ?? []).length - changes.length} more</span></li>` : ""}</ul>`
      : ""}
  </div>
</article>`;
}

/**
 * How this record was obtained, on the page rather than in a log.
 *
 * The failure this answers to was not that the pipeline lacked a check. It was
 * that a record which had come back from the wrong resource, over a redirect
 * that silently turned the POST into a GET, looked exactly like every other
 * record on the site. A human caught it an hour before it would have been used
 * to name a vendor in public. The fix is not a better check — it is that the
 * method is published beside the result, so the next instance of "we read
 * something other than what we think we read" is visible to any reader rather
 * than to whoever happens to audit it.
 */
function renderProvenance(server) {
  const p = server.provenance;
  if (!p) {
    return `<p class="notice notice--method"><span class="stamp">Provenance</span> Not recorded for this
      record. It predates the field and will carry one from the next pulse.</p>`;
  }
  const suspect = !isObservation(p);
  return `<p class="notice${suspect ? " notice--suspect" : " notice--method"}">
    <span class="stamp">${suspect ? "Not an observation" : "Provenance"}</span>
    ${esc(describeProvenance(p))}
    ${
      p.urlMatchesDeclared === false
        ? ` <strong>The URL read is not the URL declared</strong>, so anything below describes
          <code>${esc(p.observedUrl ?? "")}</code> and not necessarily <code>${esc(p.declaredUrl ?? "")}</code>.`
        : ""
    }</p>`;
}

function renderLedgerRow(s, ctx) {
  const declared = ctx.declared.get(s.id) ?? {};
  const unstable = isUnstable(s);
  return `<tr${unstable ? ' class="ledger__row--quarantined"' : ""}>
  <td class="ledger__name"><span class="dot dot--${unstable ? "unstable" : esc(s.status)}"></span><a href="servers/${esc(sanitize(s.id))}.html">${esc(s.name)}</a>${
    unstable ? ` <span class="flag" title="Reachability quarantine: ${(s.reachability ?? []).length} up/down transitions in the last 7 days">unstable</span>` : ""
  }</td>
  <td class="ledger__vendor ledger__hide">${esc(declared.vendor ?? "—")}</td>
  <td class="ledger__vendor ledger__hide">${s.platform ? `<code>${esc(s.platform)}</code>` : "—"}</td>
  <td class="ledger__num">${s.toolCount ?? 0}</td>
  <td class="ledger__num">${s.changeCount ?? 0}</td>
  <td class="ledger__hide">${esc(s.lastChangedAt ? shortDate(s.lastChangedAt) : "—")}</td>
  <td class="ledger__fp ledger__hide">${esc(s.fingerprint ?? "—")}</td>
</tr>`;
}

function renderTool(tool) {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(props).sort();
  return `<article class="tool">
  <div class="tool__head">
    <span class="tool__name">${esc(tool.name)}</span>
    <span class="tool__fp">schema ${esc(tool.schemaFingerprint ?? "—")}</span>
  </div>
  ${tool.description ? `<p class="tool__desc">${esc(firstSentences(tool.description))}</p>` : ""}
  ${names.length
    ? `<ul class="tool__params">${names
        .map((n) => {
          const p = props[n] ?? {};
          const type = Array.isArray(p.type) ? p.type.join("|") : (p.type ?? (p.anyOf ? "anyOf" : "any"));
          return `<li><span class="tool__param">${esc(n)}</span><span class="tool__type">${esc(String(type))}</span>${
            required.has(n) ? `<span class="req">required</span>` : ""
          }</li>`;
        })
        .join("")}</ul>`
    : `<p class="tool__desc">No parameters.</p>`}
</article>`;
}

function page({ ctx, title, description, canonical, assets, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#ece6d8">
<link rel="alternate" type="application/atom+xml" title="MCP Drift Registry" href="${assets}events.atom">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${assets}assets/style.css">
</head>
<body>
${body}
<div class="wrap">
  <footer>
    <span>Generated ${esc(shortDateTime(ctx.at))} · deterministic pipeline, no model in the loop</span>
    <span><a href="https://github.com/${esc(ctx.site.repo)}">${esc(ctx.site.repo ?? "")}</a></span>
  </footer>
</div>
</body>
</html>
`;
}

// --- feeds ------------------------------------------------------------------

function renderAtom(ctx) {
  const { site, base, events, at } = ctx;
  const entries = events.slice(0, 200);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(site.title ?? "MCP Drift Registry")}</title>
  <subtitle>${esc(site.tagline ?? "")}</subtitle>
  <link href="${esc(base)}/events.atom" rel="self"/>
  <link href="${esc(base)}/"/>
  <id>${esc(base)}/</id>
  <updated>${esc(entries[0]?.at ?? at)}</updated>
  <author><name>MCP Drift Registry</name></author>
${entries
  .map(
    (e) => `  <entry>
    <title>[${esc(e.severity)}${e.silent ? " · silent" : ""}] ${esc(e.serverName ?? e.server)}: ${esc(stripCode(e.summary))}</title>
    <link href="${esc(base)}/servers/${esc(sanitize(e.server))}.html"/>
    <id>tag:${esc(hostOf(base))},2026:${esc(sanitize(e.server))}/${esc(e.at)}/${esc(e.id)}</id>
    <updated>${esc(e.at)}</updated>
    <category term="${esc(e.severity)}"/>
    <content type="html">${esc(atomContent(e))}</content>
  </entry>`,
  )
  .join("\n")}
</feed>
`;
}

function atomContent(e) {
  const changes = (e.changes ?? [])
    .map((c) => `<li><code>${esc(c.path)}</code> — ${esc(c.kind)} (${esc(c.severity)})</li>`)
    .join("");
  return `<p>${inlineCode(e.summary)}</p>${
    e.silent ? "<p><strong>Silent drift:</strong> the input schema changed while the tool description stayed byte-identical.</p>" : ""
  }${changes ? `<ul>${changes}</ul>` : ""}`;
}

function renderSitemap(ctx) {
  const urls = [
    `${ctx.base}/`,
    `${ctx.base}/notes/one-template.html`,
    `${ctx.base}/notes/fleet.html`,
    ...ctx.servers.map((s) => `${ctx.base}/servers/${sanitize(s.id)}.html`),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${esc(ctx.at.slice(0, 10))}</lastmod></url>`).join("\n")}
</urlset>
`;
}

// --- helpers ----------------------------------------------------------------

/**
 * `ok`, `unstable` and `unreachable` partition the registry — every server
 * lands in exactly one. A quarantined host is deliberately not counted as ok
 * even on the pulses where it answers: "78 of 79 healthy" is a lie when one of
 * those 78 has bounced four times this week.
 */
function counts(ctx) {
  const { servers, events } = ctx;
  const unstable = servers.filter(isUnstable);
  const families = platformFamilies(servers);
  return {
    servers: servers.length,
    provenance: summarizeProvenance(servers),
    ...families,
    ok: servers.filter((s) => s.status === "ok" && !isUnstable(s)).length,
    unstable: unstable.length,
    unreachable: servers.filter((s) => s.status !== "ok" && !isUnstable(s)).length,
    answered: servers.filter((s) => s.status === "ok").length,
    tools: servers.reduce((n, s) => n + (s.toolCount ?? 0), 0),
    events: events.length,
    // Reachability events are operational noise about a host, not contract
    // drift; counting them here would make the headline number unreadable.
    breaking: events.filter((e) => e.severity === "breaking").length,
    silent: events.filter((e) => e.silent).length,
  };
}

/**
 * Quarantine state, defaulting for every record written before it existed.
 *
 * `status` stays what it always was — the outcome of the last fetch — because
 * half the pipeline keys off it. Stability is a separate axis: `status` answers
 * "did it answer just now", `stability` answers "can you rely on it answering".
 */
/**
 * How many genuinely independent contract sources are behind the row count.
 *
 * 79 endpoints is not 79 observations. A hosted docs platform serving fifty
 * vendor domains ships one template change and fifty "servers" move on the same
 * day; a headline that reads fifty breaking changes would be describing one
 * event. So: every declared platform collapses to a single family, and every
 * unlabelled server counts as its own — because "we have not identified a
 * shared generator" is not evidence of independence, and rounding it the other
 * way would flatter the number.
 */
export function platformFamilies(servers) {
  const platforms = {};
  let unlabelled = 0;
  for (const s of servers) {
    if (s?.platform) platforms[s.platform] = (platforms[s.platform] ?? 0) + 1;
    else unlabelled += 1;
  }
  const sorted = Object.entries(platforms).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    platformFamilies: sorted.length + unlabelled,
    platforms: Object.fromEntries(sorted),
    unlabelledPlatform: unlabelled,
    largestPlatform: sorted.length ? { platform: sorted[0][0], servers: sorted[0][1] } : null,
  };
}

export function isUnstable(s) {
  return s?.stability === "unstable";
}

function stability(s) {
  return isUnstable(s) ? "unstable" : "stable";
}

function summarize(s) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    status: s.status,
    stability: stability(s),
    flapCount: (s.reachability ?? []).length,
    platform: s.platform ?? null,
    toolCount: s.toolCount,
    fingerprint: s.fingerprint,
    firstSeenAt: s.firstSeenAt,
    lastCheckedAt: s.lastCheckedAt,
    lastChangedAt: s.lastChangedAt,
    changeCount: s.changeCount ?? 0,
    // How this row was obtained, beside the row itself. A consumer that wants
    // to filter out anything read over a redirect can do it without a second
    // request, and one that does not can at least see that we know.
    provenance: s.provenance ?? null,
    observed: s.provenance ? isObservation(s.provenance) : null,
    tools: (s.tools ?? []).map((t) => ({ name: t.name, schemaFingerprint: t.schemaFingerprint })),
  };
}

function stripCode(text) {
  return String(text ?? "").replace(/`/g, "");
}

function firstSentences(text, max = 240) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).replace(/\s\S*$/, "") + "…" : flat;
}

function shortDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function shortDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return "mcp-drift-registry";
  }
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  write(path, JSON.stringify(value, null, 2) + "\n");
}
