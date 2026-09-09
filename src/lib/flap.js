/**
 * Flap quarantine.
 *
 * A registry that reports every reachability blip is a registry nobody reads.
 * At 79 endpoints, two free-tier demos that bounce every other pulse are enough
 * to bury the one real breaking change under a wall of "unreachable" /
 * "reachable again" pairs, and to make the headline counters meaningless.
 *
 * So: count ok<->error transitions over a trailing 7-day window. Four or more
 * and the host is quarantined — its availability events stop being published
 * and it stops counting as a healthy endpoint. It is not deleted and it is not
 * silenced: contract drift on a flapping host is still recorded, because
 * instability of the *host* says nothing about the stability of the *contract*,
 * and the contract is what this registry is for.
 *
 * Quarantine lifts by itself. Nothing to reset by hand: once the old
 * transitions age out of the window, the count drops and the server is normal
 * again.
 */

export const FLAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FLAP_THRESHOLD = 4;

/**
 * Fold this pulse into the server's reachability history and decide quarantine.
 *
 * Only transitions are recorded, never steady state — a server that answers
 * every pulse for a year accumulates nothing. Records written before this
 * existed have no `reachability` key at all; a missing history is an empty
 * history, not a flap.
 *
 * The transition that crosses the threshold is itself quarantined. Publishing
 * the fourth flap and suppressing the fifth would be an off-by-one nobody could
 * explain in the docs.
 */
export function trackReachability(prev, next, at) {
  const now = Date.parse(at);
  const transitions = normalize(prev?.reachability).filter(
    (t) => now - Date.parse(t.at) < FLAP_WINDOW_MS,
  );

  // No previous record means a baseline, and a baseline is not a transition.
  if (prev) {
    const wasOk = prev.status === "ok";
    const isOk = next.status === "ok";
    if (wasOk !== isOk) transitions.push({ at, to: isOk ? "ok" : "error" });
  }

  return { transitions, unstable: transitions.length >= FLAP_THRESHOLD };
}

/** Tolerate anything on disk: a missing, truncated or hand-edited history. */
function normalize(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && typeof t.at === "string" && !Number.isNaN(Date.parse(t.at)))
    .map((t) => ({ at: t.at, to: t.to === "ok" ? "ok" : "error" }));
}
