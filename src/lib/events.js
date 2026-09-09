import { createHash } from "node:crypto";
import { diffTool, formatPath, worstSeverity } from "./diff.js";

/**
 * Turns "previous snapshot" + "current snapshot" into the event stream that the
 * site, the JSON API and the Atom feed all render. One function, so those three
 * surfaces can never disagree about what happened.
 */
export function buildEvents(prev, next, at, options = {}) {
  const events = [];
  const push = (e) => events.push({ ...e, id: eventId(e), at, server: next.id, serverName: next.name });

  // A quarantined host has already proven it cannot hold a connection. Its
  // up/down pairs are the noise this registry filters, not the signal it sells,
  // so they are dropped before they reach the feed. Everything below the
  // reachability section still runs: the quarantine is about availability, not
  // about the contract.
  const quarantined = options.quarantined === true;

  // --- reachability ---------------------------------------------------------
  //
  // A baseline is not drift. Enumerating every tool of a newly tracked server as
  // its own event would bury the one real breaking change under a hundred lines
  // of "tool observed" — the noise failure that makes a monitoring product
  // unreadable. The baseline is one event; the tools it established are on the
  // server's own page and in the JSON API.
  if (!prev) {
    push({
      type: "server_added",
      severity: "additive",
      summary: `${next.name} added to the registry — baseline recorded with ${plural(next.tools.length, "tool")}`,
    });
    return events;
  }

  const wasOk = prev.status === "ok";
  const isOk = next.status === "ok";
  if (wasOk && !isOk) {
    // Reachability is an operational fact about a host, not a change to a
    // contract. Filing it as `breaking` would let a sleeping free-tier demo
    // inflate the one number this registry exists to report.
    if (!quarantined) {
      push({
        type: "server_unreachable",
        severity: "operational",
        summary: `${next.name} became unreachable: ${next.error}`,
      });
    }
    return events; // never diff tools against a failed fetch
  }
  if (!isOk) return events;
  if (!wasOk) {
    if (!quarantined) {
      push({
        type: "server_recovered",
        severity: "operational",
        summary: `${next.name} is reachable again`,
      });
    }
    // Downtime must not launder a contract change. The naive version re-based
    // here and reported nothing, so a server that slept and woke up without a
    // tool erased the removal from the record permanently — the registry would
    // stay silent about exactly the event it exists to catch. Diff against the
    // last snapshot that actually carried a contract instead.
    const baseline = lastGoodContract(prev);
    if (!baseline) {
      // Also on the availability path, and it repeats for the nastiest case
      // there is: a host that flaps *and* answers with an empty tool list, so
      // no contract is ever banked. One such server would emit a baseline event
      // on every single recovery.
      if (!quarantined) {
        push({
          type: "server_baselined",
          severity: "operational",
          summary: `${next.name} baseline established with ${plural(next.tools.length, "tool")}`,
        });
      }
      return events;
    }
    pushContractEvents(baseline, next, push);
    return events;
  }

  pushContractEvents(prev, next, push);
  return events;
}

/**
 * The last snapshot that actually carried a contract.
 *
 * A failed fetch overwrites `tools` with an empty array, so `prev` alone is not
 * enough to diff against after any outage. Records written since this change
 * carry `lastGood`; older ones are handled by falling back to the record itself
 * when it was `ok`, so existing state stays readable without a migration.
 */
function lastGoodContract(prev) {
  if (prev?.lastGood?.tools?.length) return prev.lastGood;
  if (prev?.status === "ok" && prev.tools?.length) return prev;
  return null;
}

/** Contract diff proper: protocol identity plus the tool set. */
function pushContractEvents(prev, next, push) {
  if (prev.protocolVersion && next.protocolVersion && prev.protocolVersion !== next.protocolVersion) {
    push({
      type: "protocol_version_changed",
      severity: "breaking",
      summary: `protocol version ${prev.protocolVersion} → ${next.protocolVersion}`,
    });
  }

  const prevTools = new Map((prev.tools ?? []).map((t) => [t.name, t]));
  const nextTools = new Map((next.tools ?? []).map((t) => [t.name, t]));

  for (const [name, tool] of nextTools) {
    if (!prevTools.has(name)) {
      push({ type: "tool_added", severity: "additive", tool: name, summary: `tool \`${name}\` added` });
    }
  }
  for (const [name] of prevTools) {
    if (!nextTools.has(name)) {
      push({ type: "tool_removed", severity: "breaking", tool: name, summary: `tool \`${name}\` removed` });
    }
  }
  for (const [name, tool] of nextTools) {
    const before = prevTools.get(name);
    if (!before) continue;
    const d = diffTool(before, tool);
    if (!d.changed) continue;

    push({
      type: d.silent ? "tool_silent_schema_change" : "tool_changed",
      severity: d.severity,
      tool: name,
      silent: d.silent,
      summary: d.silent
        ? `tool \`${name}\`: input schema changed while the description stayed byte-identical`
        : `tool \`${name}\`: ${describeChanges(d)}`,
      changes: d.schemaChanges.slice(0, 40).map((c) => ({
        kind: c.kind,
        severity: c.severity,
        path: formatPath(c.path),
        from: truncate(c.from),
        to: truncate(c.to),
      })),
      descriptionChanged: d.descriptionChanged,
    });
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeChanges(d) {
  const parts = [];
  const kinds = new Map();
  for (const c of d.schemaChanges) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  for (const [kind, n] of kinds) parts.push(n > 1 ? `${kind} ×${n}` : kind);
  if (d.descriptionChanged) parts.push("description_changed");
  return parts.join(", ") || "changed";
}

function truncate(value) {
  if (value === undefined) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** Stable id so re-publishing never produces duplicate Atom entries. */
function eventId(e) {
  return createHash("sha256")
    .update([e.type, e.tool ?? "", e.summary].join("|"))
    .digest("hex")
    .slice(0, 12);
}

export { worstSeverity };
