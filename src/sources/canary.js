import { httpJson } from "../lib/http.js";
import { fingerprint } from "../lib/canonical.js";

/**
 * Heartbeat canary.
 *
 * "Nothing drifted this week" and "the collector has been throwing since
 * Tuesday" produce byte-identical output. A monitoring product that cannot tell
 * those apart is worse than no product, because it is confidently silent — this
 * is the failure the pre-mortem flagged (docs/critic, §3.3).
 *
 * The canary is a source whose value is guaranteed to move. Every run fetches
 * it through the same HTTP path the collector uses. Two independent signals:
 *   - fetch failed        -> the network path is broken;
 *   - value never moves   -> the diff path is broken (or we are not running).
 */
const CANARY_URL = "https://api.github.com/zen";
const STALE_AFTER_RUNS = 6;

export async function checkCanary(previous, at) {
  const state = {
    url: CANARY_URL,
    lastCheckAt: at,
    lastChangeAt: previous?.lastChangeAt ?? null,
    consecutiveNoChange: previous?.consecutiveNoChange ?? 0,
    healthy: null,
    error: null,
    fingerprint: previous?.fingerprint ?? null,
  };

  try {
    const res = await httpJson(CANARY_URL, {
      // `accept: text/plain` makes api.github.com answer 415; it wants */*.
      headers: { accept: "*/*", "user-agent": "mcp-drift-registry/0.1" },
      retries: 1,
      timeoutMs: 10000,
    });
    const fp = fingerprint(res.text.trim());
    if (fp !== state.fingerprint) {
      state.fingerprint = fp;
      state.lastChangeAt = at;
      state.consecutiveNoChange = 0;
    } else {
      state.consecutiveNoChange += 1;
    }
    state.healthy = state.consecutiveNoChange < STALE_AFTER_RUNS;
    if (!state.healthy) {
      state.error = `canary value unchanged across ${state.consecutiveNoChange} consecutive runs — the diff path is suspect`;
    }
  } catch (err) {
    state.healthy = false;
    state.error = `canary fetch failed: ${String(err?.message ?? err).slice(0, 160)}`;
  }

  return state;
}
