/**
 * HTTP with a timeout and bounded retries. Deliberately thin: the pipeline must
 * survive a flaky source without a dependency tree.
 */
export async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 20000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await follow(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status}`, res.status, text.slice(0, 300));
      }
      return { status: res.status, text, headers: res.headers };
    } catch (err) {
      lastError = err;
      // A 4xx is an answer, not a hiccup, and so is a redirect. Retrying either
      // just wastes the budget.
      if (err instanceof HttpError && err.status >= 300 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const MAX_HOPS = 3;

/**
 * Redirects, resolved by hand.
 *
 * `redirect: "follow"` looks like the safe default and is not. Per the fetch
 * standard a 301, 302 or 303 rewrites a POST into a GET and drops the body, so
 * a probe aimed at an MCP endpoint arrives as a plain page request and comes
 * back with whatever that host serves to a browser. The pipeline then diffs a
 * document that was never a `tools/list` response and cannot tell.
 *
 * That is not hypothetical: it put one endpoint's static discovery manifest
 * into the registry as if it were a tool contract, and produced the one
 * anomaly we were about to publish.
 *
 * So: 307 and 308 preserve the method and the body and are followed. Anything
 * else with a non-idempotent method is refused loudly, naming the target — the
 * fix is to correct the declared URL, not to probe a different resource and
 * hope it is the same one.
 */
async function follow(url, init) {
  let target = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) throw new HttpError(`HTTP ${res.status} without a Location header`, res.status, target);

    const preservesMethod = res.status === 307 || res.status === 308;
    const idempotent = init.method === "GET" || init.method === "HEAD" || init.method === undefined;
    if (!preservesMethod && !idempotent) {
      throw new HttpError(
        `HTTP ${res.status} redirect would change ${init.method} to GET`,
        res.status,
        `declared ${target} redirects to ${location}; declare the target directly`,
      );
    }
    if (hop >= MAX_HOPS) throw new HttpError(`more than ${MAX_HOPS} redirects`, res.status, target);
    target = new URL(location, target).toString();
  }
}

export class HttpError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded-concurrency map. Sources are independent; failures stay local. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
