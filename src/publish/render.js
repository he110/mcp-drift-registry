import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { STYLESHEET } from "./theme.js";
import { sanitize } from "../lib/store.js";

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
  const servers = store.listServers();
  const history = store.readHistory();
  const meta = store.readMeta();
  const declared = new Map((config.servers ?? []).map((s) => [s.id, s]));

  const events = [...history].reverse();
  const ctx = { site, base, servers, events, meta, declared, at };

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  write(join(outDir, ".nojekyll"), "");
  write(join(outDir, "assets/style.css"), STYLESHEET);
  write(join(outDir, "index.html"), renderIndex(ctx));
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
    servers: servers.map(summarize),
  });
  writeJson(join(outDir, "api/events.json"), { generatedAt: at, count: events.length, events: events.slice(0, 500) });
  writeJson(join(outDir, "api/meta.json"), { generatedAt: at, ...meta });
  for (const server of servers) {
    writeJson(join(outDir, "api/servers", `${sanitize(server.id)}.json`), {
      generatedAt: at,
      ...server,
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
        <div class="key">
          <div class="key__row"><span class="sev sev--breaking">breaking</span><span>a parameter or enum value disappeared, a type changed, or a field became required</span></div>
          <div class="key__row"><span class="sev sev--additive">additive</span><span>something was added that existing callers can ignore</span></div>
          <div class="key__row"><span class="sev sev--cosmetic">cosmetic</span><span>wording, titles, examples — no change to the wire contract</span></div>
        </div>
      </div>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="readout">
    <div class="readout__cell"><span class="readout__value">${c.servers}</span><span class="readout__label">Servers tracked</span></div>
    <div class="readout__cell"><span class="readout__value">${c.tools}</span><span class="readout__label">Tools observed</span></div>
    <div class="readout__cell${c.breaking ? " readout__cell--alarm" : ""}"><span class="readout__value">${c.breaking}</span><span class="readout__label">Breaking changes</span></div>
    <div class="readout__cell${c.silent ? " readout__cell--alarm" : ""}"><span class="readout__value">${c.silent}</span><span class="readout__label">Silent drifts</span></div>
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
      <p class="section__note">Fingerprint is a SHA-256 over the canonicalised tool set. Identical fingerprint, identical contract.</p>
    </div>
    <table class="ledger">
      <thead>
        <tr>
          <th>Server</th>
          <th class="ledger__hide">Vendor</th>
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
        <p>${c.ok} of ${c.servers} endpoints answered on the last pulse.${c.unreachable ? ` ${c.unreachable} did not — recorded as an event, not swallowed.` : ""}</p>
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
      <span>${esc(server.status)}</span>
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
      <p class="section__note">As returned by <code>tools/list</code> on the last successful pulse.</p>
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

function renderLedgerRow(s, ctx) {
  const declared = ctx.declared.get(s.id) ?? {};
  return `<tr>
  <td class="ledger__name"><span class="dot dot--${esc(s.status)}"></span><a href="servers/${esc(sanitize(s.id))}.html">${esc(s.name)}</a></td>
  <td class="ledger__vendor ledger__hide">${esc(declared.vendor ?? "—")}</td>
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
  const urls = [`${ctx.base}/`, ...ctx.servers.map((s) => `${ctx.base}/servers/${sanitize(s.id)}.html`)];
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${esc(ctx.at.slice(0, 10))}</lastmod></url>`).join("\n")}
</urlset>
`;
}

// --- helpers ----------------------------------------------------------------

function counts(ctx) {
  const { servers, events } = ctx;
  return {
    servers: servers.length,
    ok: servers.filter((s) => s.status === "ok").length,
    unreachable: servers.filter((s) => s.status !== "ok").length,
    tools: servers.reduce((n, s) => n + (s.toolCount ?? 0), 0),
    events: events.length,
    breaking: events.filter((e) => e.severity === "breaking").length,
    silent: events.filter((e) => e.silent).length,
  };
}

function summarize(s) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    status: s.status,
    toolCount: s.toolCount,
    fingerprint: s.fingerprint,
    firstSeenAt: s.firstSeenAt,
    lastCheckedAt: s.lastCheckedAt,
    lastChangedAt: s.lastChangedAt,
    changeCount: s.changeCount ?? 0,
    tools: (s.tools ?? []).map((t) => ({ name: t.name, schemaFingerprint: t.schemaFingerprint })),
  };
}

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Summaries are written with `backticks`; render them as code, escaped. */
export function inlineCode(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
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
