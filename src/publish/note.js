import { esc } from "./html.js";

/**
 * Note № 01 — what is actually behind the row count.
 *
 * The whole point of this page is that it argues from the sample rather than
 * about it, so nothing here is written down as prose. Every number, every
 * bucket and every threshold-dependent word is derived from the same state the
 * ledger renders from, on the same pulse. If the sample stops supporting a
 * sentence, the sentence changes by itself — which is the one editorial
 * standard a registry that publishes other people's drift has no excuse to
 * miss on its own page.
 */

/** Headline copy reads badly with a bare numeral; the ledger keeps the digits. */
/**
 * A one-line JSON object folded to the width of the code block. The page is set
 * to a reading measure, and a `pre` that scrolls sideways is a claim the reader
 * cannot check at a glance — which is the only thing these blocks are for.
 */
function commentedJson(object, width = 58) {
  const entries = Object.entries(object ?? {}).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  const lines = [];
  for (const entry of entries) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + entry.length + 1 <= width) lines[last] += `,${entry}`;
    else lines.push(entry);
  }
  if (!lines.length) return "# {}";
  return lines.map((line, i) => `# ${i === 0 ? "{" : " "}${line}${i === lines.length - 1 ? "}" : ","}`).join("\n");
}

function cap(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function spell(n) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
}

/** The tool-name signature of the large hosted docs template. */
const SIGNATURE = "query_docs_filesystem_";

export function noteFacts(servers) {
  const total = servers.length;
  const templated = servers.filter((s) => hasSignature(s));
  const share = total ? templated.length / total : 0;

  return {
    total,
    templated: templated.length,
    sharePct: Math.round(share * 100),
    // Threshold-dependent wording, resolved from the data rather than asserted.
    shareWord: share >= 0.5 ? "most of the registry" : "a large minority of the registry",
    strata: tally(templated.map((s) => fingerprintOf(s, (n) => n.startsWith("search_")))),
    feedback: tally(templated.map((s) => fingerprintOf(s, (n) => n === "submit_feedback"))),
    // Endpoints are not deployments: two paths on one host are one thing.
    sharedHosts: sharedHosts(servers),
  };
}

function hasSignature(s) {
  return (s.tools ?? []).some((t) => String(t.name ?? "").startsWith(SIGNATURE));
}

function fingerprintOf(server, match) {
  const tool = (server.tools ?? []).find((t) => match(String(t.name ?? "")));
  return tool?.schemaFingerprint ?? null;
}

/** Counts of each distinct value, most common first, nulls dropped. */
function tally(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, servers]) => ({ value, servers }))
    .sort((a, b) => b.servers - a.servers || a.value.localeCompare(b.value));
}

/** Hosts serving more than one tracked endpoint — one deployment, many rows. */
function sharedHosts(servers) {
  const byHost = new Map();
  for (const s of servers) {
    const host = hostOf(s.url);
    if (!host) continue;
    byHost.set(host, [...(byHost.get(host) ?? []), s.id]);
  }
  return [...byHost.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([host, ids]) => ({ host, ids: ids.sort() }))
    .sort((a, b) => b.ids.length - a.ids.length || a.host.localeCompare(b.host));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// --- page -------------------------------------------------------------------

export function noteBody(ctx, counts) {
  const f = noteFacts(ctx.servers);
  const base = ctx.base;
  const api = `${base}/api/registry.json`;
  const dominant = f.feedback[0];
  const feedbackShare = dominant ? `${dominant.servers} of the ${f.templated}` : "";
  const odd = dominant ? f.templated - dominant.servers : 0;

  return `
<header class="note__head">
  <div class="wrap wrap--text">
    <div class="note__kicker">
      <span>MCP Drift Registry</span>
      <span>Note № 01</span>
      <span>Sample composition</span>
    </div>
    <h1 class="note__title">${f.total} servers is not<br><em>${f.total} observations</em></h1>
    <p class="note__standfirst">
      The ledger tracks ${f.total} public endpoints that answer <code>tools/list</code> without credentials.
      Before that number does any work for anyone, here is what is behind it — measured, not estimated.
    </p>
    <div class="note__meta">
      <span class="stamp">Figures regenerated each pulse</span>
      <span>Every number on this page is read out of the same state the ledger renders from. Nothing is transcribed by hand.</span>
    </div>
  </div>
</header>

<div class="wrap wrap--text note">

  <section>
    <h2><span class="num">01</span>One template, ${f.sharePct}% of the rows</h2>
    <p><strong>${f.templated} of the ${f.total} endpoints — ${f.sharePct}% — are the same hosted docs template.</strong>
    One generator, ${f.templated} vendors, ${f.templated} domains. The tool names are vendor-specific, so every
    contract fingerprint differs and a naive count sees ${f.templated} separate servers with ${f.templated} separate
    contracts. There is one thing behind them: if that generator ships a change, ${f.shareWord}
    moves on the same day, and the ledger would read like an ecosystem-wide event instead of one deploy.</p>
    <p>No label of ours is involved in that count. It is the tool-name signature:</p>
    <pre>curl -s ${esc(api)} | jq '
  [ .servers[]
    | select([.tools[].name] | any(startswith("${SIGNATURE}")))
  ] | length'
# ${f.templated}</pre>
    ${
      dominant
        ? `<p>The shared <code>submit_feedback</code> tool has a byte-identical schema fingerprint
    (<code>${esc(dominant.value)}</code>) on ${esc(feedbackShare)}. ${
      f.feedback.length > 1
        ? `The ${odd === 1 ? "one that differs does so" : `remaining ${odd} differ, and they do so`} by template version skew, not by being a different template.`
        : `All of them agree exactly.`
    }</p>`
        : ""
    }
  </section>

  <section>
    <h2><span class="num">02</span>Endpoint ≠ deployment</h2>
    ${
      f.sharedHosts.length
        ? `<p>${f.sharedHosts.length === 1 ? "One host in the registry serves" : `${f.sharedHosts.length} hosts in the registry serve`}
    more than one tracked endpoint — separate paths, one deployment behind them:</p>
    <ul class="note__list">${f.sharedHosts
      .map(
        (h) =>
          `<li><code>${esc(h.host)}</code><span>${h.ids.map((id) => esc(id)).join(", ")} — ${h.ids.length} rows, one deployment</span></li>`,
      )
      .join("")}</ul>
    <p>The registry counts endpoints because an endpoint is what it can actually probe. If you are counting
    MCP servers yourself, the two units are not the same, and nothing in a <code>tools/list</code> response
    tells you which one you have.</p>`
        : `<p>No host in the registry currently serves more than one tracked endpoint, so on this pulse the
    endpoint count and the deployment count agree. They are still different units, and the check is
    re-run every pulse rather than assumed.</p>`
    }
  </section>

  <section>
    <h2><span class="num">03</span>${counts.platformFamilies} families, and that is a ceiling</h2>
    <p>Each identified platform collapses to one family. Each endpoint with no identified platform counts
    as its own — because <em>we could not identify a shared generator</em> is not evidence of independence,
    and rounding it the other way would flatter the number.</p>
    <pre>curl -s ${esc(api)} \\
| jq '.counts.platformFamilies, .counts.platforms, .counts.unlabelledPlatform'
# ${counts.platformFamilies}
${esc(commentedJson(counts.platforms))}
# ${counts.unlabelledPlatform}</pre>
    <p>Two of those labels almost certainly belong to one vendor in two different shapes. The counter does
    not merge them, because the two shapes share no tool at all — merging them on the strength of a common
    prefix in a string we wrote ourselves is a guess, and a guess does not belong in a counter.
    <strong>So ${counts.platformFamilies} is an upper bound on independence, not a floor.</strong>
    The ${counts.unlabelledPlatform} unlabelled endpoints are unproven, not proven separate.</p>
    <p>The practical consequence is the only reason this page exists: any per-server drift rate computed
    from this sample would be badly inflated, because ${f.templated} correlated observations would be counted
    as ${f.templated} independent ones. No rate gets published here without the family count beside it.</p>
  </section>

  ${strataSection(f)}

  <section>
    <h2><span class="num">05</span>What the registry does about it</h2>
    <p>Nothing, deliberately. It publishes the platform label and the family count, and then
    de-duplicates nothing, weights nothing and corrects no statistic. The sample is marked and you decide
    what it is worth. A correction applied inside the pipeline would be one more thing you would have to
    trust; a label is something you can check with the command above.</p>
    <p>The gap in the sample is also the standing request: <strong>a server from outside that template is
    worth several from inside it.</strong> The only requirement is that <code>tools/list</code> answers
    without credentials.</p>
    <div class="actions">
      <a class="btn" href="../">The ledger</a>
      <a class="btn" href="../api/registry.json">registry.json</a>
      <a class="btn btn--accent" href="https://github.com/${esc(ctx.site.repo)}/issues/new?title=Add+server%3A+&amp;body=Endpoint+URL%3A%0AWhy+it+belongs+in+the+registry%3A">Submit a server</a>
      <a class="btn" href="https://github.com/${esc(ctx.site.repo)}/discussions/1">Report drift you have seen</a>
    </div>
  </section>

  <a class="crumb" href="../">← Back to the ledger</a>
</div>`;
}

/**
 * The figure. One measure across a handful of opaque buckets, so: one series,
 * one ink, sorted by magnitude, values direct-labelled, no legend and no hue
 * carrying meaning. It is marked up as a table because the table *is* the
 * accessible view — the bars are a second reading of cells that already exist.
 */
function strataSection(f) {
  if (f.strata.length < 2) {
    return `
  <section>
    <h2><span class="num">04</span>Inside the template</h2>
    <p>On this pulse the template's <code>search_*</code> tool has a single schema fingerprint across all
    ${f.templated} endpoints: the template is internally uniform right now. When that stops being true, the
    strata appear here.</p>
  </section>`;
  }

  const max = f.strata[0].servers;
  const rows = f.strata
    .map(
      (s) => `      <tr>
        <th scope="row"><code>${esc(s.value)}</code></th>
        <td class="strata__cell"><span class="strata__bar" style="width:${((s.servers / max) * 100).toFixed(1)}%"></span></td>
        <td class="strata__value">${s.servers}</td>
      </tr>`,
    )
    .join("\n");

  return `
  <section>
    <h2><span class="num">04</span>${cap(spell(f.strata.length))} strata inside one template</h2>
    <p>The <code>search_*</code> tool is nominally one template tool. Across the ${f.templated} endpoints it has
    <strong>${spell(f.strata.length)} distinct schema fingerprints</strong>.</p>

    <figure class="figure">
      <table class="strata">
        <caption class="figure__cap">Endpoints per distinct <code>search_*</code> schema fingerprint,
        ${f.templated} templated endpoints, this pulse.</caption>
        <tbody>
${rows}
        </tbody>
      </table>
    </figure>

    <p>We do not know what that is. It could be a template rollout caught mid-flight, or permanent
    per-tenant divergence that will look identical next year. <strong>A single snapshot structurally cannot
    distinguish those two.</strong> That is the entire argument for keeping the series instead of recounting:
    in a few weeks the strata either converge or they do not, and then it is a fact rather than a shape.</p>
    <p>If you integrate against one vendor's docs MCP and assume the next one behaves the same because the
    tool has the same name, you are already wrong today — and a census taken today will not tell you that.</p>
  </section>`;
}
