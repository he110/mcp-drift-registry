import { createHash } from "node:crypto";
import { diffTool, formatPath, worstSeverity } from "./diff.js";

/**
 * Turns "previous snapshot" + "current snapshot" into the event stream that the
 * site, the JSON API and the Atom feed all render. One function, so those three
 * surfaces can never disagree about what happened.
 */
export function buildEvents(prev, next, at) {
  const events = [];
  const push = (e) => events.push({ ...e, id: eventId(e), at, server: next.id, serverName: next.name });

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
    push({ type: "server_unreachable", severity: "breaking", summary: `${next.name} became unreachable: ${next.error}` });
    return events; // never diff tools against a failed fetch
  }
  if (!isOk) return events;
  if (!wasOk) {
    // Recovery from a failed fetch is a re-baseline, not a hundred additions:
    // the previous snapshot holds no contract to diff against.
    push({
      type: "server_recovered",
      severity: "additive",
      summary: `${next.name} is reachable again — baseline re-established with ${plural(next.tools.length, "tool")}`,
    });
    return events;
  }

  // --- protocol / identity --------------------------------------------------
  if (prev.protocolVersion && next.protocolVersion && prev.protocolVersion !== next.protocolVersion) {
    push({
      type: "protocol_version_changed",
      severity: "breaking",
      summary: `protocol version ${prev.protocolVersion} → ${next.protocolVersion}`,
    });
  }

  // --- tools ----------------------------------------------------------------
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

  return events;
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
