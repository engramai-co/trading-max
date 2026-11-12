import { hashKey, type QueryKey } from "@tanstack/react-query";

export const snapshotCacheVersion = 1;
export const snapshotCacheStorageKey = "trading_max-snapshot-cache";
export const snapshotCacheMaxAge = 24 * 60 * 60_000;
export const snapshotCacheMaxSize = 768 * 1024;
const maxEntries = 32;
const dashboardViews = ["overview", "holdings-positions", "holdings-lookthrough", "analytics", "review", "account-analysis"];
const researchViews = ["overview", "technical", "valuation", "fundamentals", "analyst", "options", "ledger"];
const run = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type SnapshotCacheEntry = { key: QueryKey; data: unknown; updatedAt: number };

/** Only the exact successful GET contracts below may cross the persistence boundary. */
export function isSnapshotEntry(value: unknown, now: number): value is SnapshotCacheEntry {
  if (!record(value) || !Array.isArray(value.key) || !record(value.data) ||
      typeof value.updatedAt !== "number" || value.updatedAt <= now - snapshotCacheMaxAge ||
      value.updatedAt > now || !Number.isFinite(value.updatedAt)) return false;
  const { key, data } = value;
  const [kind, group, view, detail, revision] = key;
  if (kind === "dashboard-lens" && key.length === 5 && group === "latest") {
    return dashboardViews.includes(view) && run(data.runId) && date(data.brokerAsOf);
  }
  if (kind === "workspace-research-shell" && key.length === 1) {
    return record(data.status) && run(data.status.runId) && Array.isArray(data.instruments);
  }
  if (kind === "workspace-research" && key.length === 5) {
    return researchViews.includes(view) && ["full", "summary", "seasonality", "documents"].includes(detail) &&
      (revision == null || run(revision)) && typeof group === "string" && group === data.ticker &&
      view === data.view && run(data.runId) && date(data.generatedAt);
  }
  if (kind === "portfolio-history" && (key.length === 2 || key.length === 3)) {
    return record(group) && run(group.runId) && group.runId === data.runId &&
      record(data.history) && record(data.history.timeline) && Array.isArray(data.history.timeline.segments) &&
      Array.isArray(data.history.timeline.rows) && record(data.money);
  }
  return false;
}

export function readSnapshotCache(raw: string | null, scope: string, now = Date.now()): SnapshotCacheEntry[] {
  if (!raw || raw.length > snapshotCacheMaxSize) return [];
  try {
    const cached: unknown = JSON.parse(raw);
    if (record(cached) && cached.version === snapshotCacheVersion && cached.scope === scope &&
        Array.isArray(cached.entries) && cached.entries.length <= maxEntries) {
      return cached.entries.filter((entry) => isSnapshotEntry(entry, now));
    }
  } catch {
    // Old, partial or corrupted storage is a cold start.
  }
  return [];
}

export function packSnapshotCache(entries: Iterable<SnapshotCacheEntry>, scope: string, now = Date.now()) {
  const header = JSON.stringify({ version: snapshotCacheVersion, scope });
  const prefix = header.slice(0, -1) + ',"entries":[';
  const saved: string[] = [];
  let bytes = prefix.length + 2;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!isSnapshotEntry(entry, now) || saved.length === maxEntries) continue;
    const hash = hashKey(entry.key);
    if (seen.has(hash)) continue;
    const json = JSON.stringify(entry);
    const size = encoder.encode(json).byteLength + 1;
    if (bytes + size > snapshotCacheMaxSize) continue;
    bytes += size;
    seen.add(hash);
    saved.push(json);
  }
  return prefix + saved.join(",") + "]}";
}
