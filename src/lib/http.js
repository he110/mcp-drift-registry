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
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "follow",
      });
      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status}`, res.status, text.slice(0, 300));
      }
      return { status: res.status, text, headers: res.headers };
    } catch (err) {
      lastError = err;
      // A 4xx is an answer, not a hiccup. Retrying it just wastes the budget.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
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
