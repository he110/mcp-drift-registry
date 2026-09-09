/**
 * Admission gate for new servers.
 *
 * Until now a candidate entered the registry on the strength of one successful
 * probe. One probe proves that an endpoint was up at one instant, which is not
 * the claim the registry makes about its rows. A free-tier demo that answers
 * once and then bounces for a week is admitted on that single lucky moment, and
 * from then on it is a permanent row that flaps, drags its contract family into
 * the "changed this month" bucket on the strength of an outage, and costs a
 * request every pulse forever. The headline number this registry exists to
 * publish — how many contract families actually moved — is exactly the number
 * that noise corrupts.
 *
 * So a candidate now has to earn the row:
 *
 *   8 consecutive successful probes, and the streak itself must span >= 48h.
 *
 * Two clauses, and both bind. The pulse runs every 6 hours, so eight probes
 * cover 42 hours of wall clock, not 48 — in practice admission takes nine. That
 * is deliberate. The probe count alone would be satisfiable inside an afternoon
 * if the cron were ever tightened, and the elapsed-time clause is the one that
 * actually forces a candidate to survive a nightly deploy window.
 *
 * The span is measured across the *streak*, not from the first time we ever saw
 * the host. Measuring from first sighting is the version that looks equivalent
 * and is not: a host that failed for three days and then answered eight times in
 * one hour would clear it, and that host is precisely the one being excluded. A
 * failed probe resets the streak to zero and the clock with it.
 *
 * Nothing here touches servers already in the registry. The gate reads
 * `config.candidates` and writes `config.servers`; it never inspects, reorders
 * or removes an existing row. A config with no `candidates` key is a no-op down
 * to object identity — see `applyAdmissions`.
 */

/** Consecutive successful probes required before a candidate is admitted. */
export const ADMISSION_PROBES = 8;

/** The successful streak must span at least this much wall clock. */
export const ADMISSION_SPAN_MS = 48 * 60 * 60 * 1000;

/**
 * A candidate that has been on trial this long without being admitted has
 * answered us once, at nomination, and never convincingly again. Stop paying a
 * request per pulse for it. The record stays on disk with the reason.
 */
export const CANDIDATE_TRIAL_MAX_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Fold one probe result into a candidate's ledger record.
 *
 * `result` is whatever `collectMcpServer` returned — the same collector the
 * pipeline uses, so "it probed fine" and "it collects fine" cannot diverge.
 * An empty tool list counts as a failure: a server with no tools has no
 * contract to track, and tracking it would add a row that can never drift.
 */
export function foldProbe(prev, declared, result, at) {
  const succeeded = result?.status === "ok" && (result.toolCount ?? 0) > 0;

  const base = prev ?? {
    id: declared.id,
    name: declared.name ?? declared.id,
    url: declared.url,
    firstProbeAt: at,
    probes: 0,
    failures: 0,
    consecutiveOk: 0,
    streakStartedAt: null,
    lastProbeAt: null,
    lastError: null,
    lastToolCount: null,
    admittedAt: null,
  };

  const consecutiveOk = succeeded ? base.consecutiveOk + 1 : 0;

  const next = {
    ...base,
    name: declared.name ?? base.name,
    url: declared.url ?? base.url,
    probes: base.probes + 1,
    failures: base.failures + (succeeded ? 0 : 1),
    consecutiveOk,
    // A streak that has been broken starts again from this probe, not from the
    // first time the host was ever seen.
    streakStartedAt: succeeded ? (base.streakStartedAt ?? at) : null,
    lastProbeAt: at,
    lastError: succeeded ? null : describe(result),
    lastToolCount: succeeded ? result.toolCount : base.lastToolCount,
  };

  if (!next.admittedAt && admits(next, at)) next.admittedAt = at;
  return next;
}

/** Has this candidate cleared both clauses of the gate as of `at`? */
export function admits(candidate, at) {
  if (!candidate?.streakStartedAt) return false;
  if ((candidate.consecutiveOk ?? 0) < ADMISSION_PROBES) return false;
  return Date.parse(at) - Date.parse(candidate.streakStartedAt) >= ADMISSION_SPAN_MS;
}

/** On trial too long with nothing to show for it. Stop probing; keep the record. */
export function abandoned(candidate, at) {
  if (!candidate || candidate.admittedAt) return false;
  return Date.parse(at) - Date.parse(candidate.firstProbeAt) >= CANDIDATE_TRIAL_MAX_MS;
}

/** One line for the pulse log: where a candidate stands and what is still owed. */
export function describeProgress(candidate, at) {
  if (candidate.admittedAt) return "admitted";
  if (abandoned(candidate, at)) return "abandoned";
  const hours = candidate.streakStartedAt
    ? Math.floor((Date.parse(at) - Date.parse(candidate.streakStartedAt)) / 3600000)
    : 0;
  return `${candidate.consecutiveOk}/${ADMISSION_PROBES} ok, ${hours}h/${ADMISSION_SPAN_MS / 3600000}h`;
}

/**
 * Move admitted candidates into the tracked server list.
 *
 * Pure, and deliberately identity-preserving: with nothing to admit it returns
 * the very object it was handed, so the caller can skip the write and the 79
 * rows already in `servers.json` cannot be reordered, reserialised or dropped by
 * a pulse that had no business touching them at all.
 *
 * An admitted candidate is appended, not spliced in by sort order, and it is
 * only *declared* here. Its baseline snapshot and its `server_added` event are
 * produced by the next pulse through the ordinary collection path, so there is
 * still exactly one way a server gets a first contract on the record.
 */
export function applyAdmissions(config, admittedIds) {
  const ids = new Set(admittedIds);
  if (ids.size === 0) return config;

  const candidates = config.candidates ?? [];
  const promoted = candidates.filter((c) => ids.has(c.id));
  if (promoted.length === 0) return config;

  const known = new Set((config.servers ?? []).map((s) => s.id));
  const additions = promoted
    .filter((c) => !known.has(c.id))
    .map(({ id, name, vendor, url, homepage, platform }) => ({
      id,
      name: name ?? id,
      ...(vendor ? { vendor } : {}),
      url,
      ...(homepage ? { homepage } : {}),
      ...(platform ? { platform } : {}),
    }));

  return {
    ...config,
    servers: [...(config.servers ?? []), ...additions],
    candidates: candidates.filter((c) => !ids.has(c.id)),
  };
}

function describe(result) {
  if (!result) return "no result";
  if (result.error) return String(result.error).slice(0, 200);
  if (result.status === "ok") return "answered with no tools";
  return String(result.status ?? "unknown");
}
