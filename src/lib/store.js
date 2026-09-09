import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * State lives in the repository, not in a database and not in the runner.
 *
 * GitHub Actions cron is best-effort: a scheduled run may be delayed or skipped
 * entirely. A pipeline that derives its state from "how many times did I run"
 * silently corrupts itself the first time the scheduler misses. Everything here
 * is derived from the last committed snapshot, so a missed run costs a delay
 * and nothing else — the next run diffs against the same baseline.
 */
export class Store {
  constructor(root) {
    this.root = root;
    this.serversDir = join(root, "servers");
    this.historyPath = join(root, "history.jsonl");
    this.metaPath = join(root, "meta.json");
    this.candidatesPath = join(root, "candidates.json");
  }

  /**
   * The trial ledger for servers that have not been admitted yet, keyed by id.
   *
   * Deliberately a separate file from `servers/`: a candidate is not a row in
   * the registry and must not be readable as one. Admitted candidates stay here
   * with their `admittedAt` and their probe counts, because "this server earned
   * its place over N probes and M hours" is the evidence for the claim the
   * registry makes, and throwing it away the moment it becomes true is how a
   * gate quietly turns back into a rubber stamp.
   */
  readCandidates() {
    const raw = readJson(this.candidatesPath, {});
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  writeCandidates(ledger) {
    writeJson(this.candidatesPath, ledger);
  }

  readServer(id) {
    return readJson(join(this.serversDir, `${sanitize(id)}.json`), null);
  }

  writeServer(record) {
    writeJson(join(this.serversDir, `${sanitize(record.id)}.json`), record);
  }

  listServers() {
    if (!existsSync(this.serversDir)) return [];
    return readdirSync(this.serversDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(join(this.serversDir, f), null))
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  appendEvents(events) {
    if (events.length === 0) return;
    mkdirSync(dirname(this.historyPath), { recursive: true });
    appendFileSync(
      this.historyPath,
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  readHistory(limit = Infinity) {
    if (!existsSync(this.historyPath)) return [];
    const lines = readFileSync(this.historyPath, "utf8").split("\n").filter(Boolean);
    const slice = limit === Infinity ? lines : lines.slice(-limit);
    return slice.map((l) => JSON.parse(l));
  }

  readMeta() {
    return readJson(this.metaPath, {
      firstRunAt: null,
      lastRunAt: null,
      runs: 0,
      canary: { lastChangeAt: null, lastCheckAt: null, consecutiveNoChange: 0, healthy: null },
    });
  }

  writeMeta(meta) {
    writeJson(this.metaPath, meta);
  }
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Source ids become filenames and URL slugs; keep them boring. */
export function sanitize(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
