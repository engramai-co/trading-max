import "server-only";
import { backendFetch } from "./backend";
import { prepareHistory, type HistoryInput, type HistorySelection } from "@/lib/portfolio/prepared";

type Prepared = ReturnType<typeof prepareHistory>;
type ClassifiedHistory = { prepared: Prepared; archived: boolean };
type Entry = { value: Prepared; bytes: number; expires: number };

function historyCache() {
  return {
    entries: new Map<string, Entry>(),
    pending: new Map<string, Promise<ClassifiedHistory>>(),
  };
}
const liveCache = historyCache();
const retainedCache = historyCache();
const BUDGET = 32 * 1024 * 1024;
/** Enough for a reader moving between ranges and accounts, plus the prewarmed defaults. */
const ENTRIES = 8;

export class HistoryRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function remember(entries: Map<string, Entry>, key: string, entry: Entry) {
  if (entry.bytes > BUDGET) return;
  entries.delete(key);
  let used = [...entries.values()].reduce((sum, item) => sum + item.bytes, 0);
  for (const [oldKey, old] of entries) {
    if (entries.size < ENTRIES && used + entry.bytes <= BUDGET) break;
    entries.delete(oldKey);
    used -= old.bytes;
  }
  entries.set(key, entry);
}

function evictRun(runId: string) {
  for (const {entries} of [liveCache, retainedCache]) {
    for (const [key, entry] of entries) if (entry.value.chart.runId === runId) entries.delete(key);
  }
}

/** Cache immutable calculations. The publication can expire between any two requests. */
export async function readPreparedHistory(selection: HistorySelection, retained = false): Promise<ClassifiedHistory> {
  const key = JSON.stringify(selection);
  const cache = retainedCache.entries.has(key) ? retainedCache : liveCache;
  const existing = cache.entries.get(key);
  if (existing && existing.expires > Date.now()) {
    const check = await backendFetch(`/v1/dashboard/history?run_id=${encodeURIComponent(selection.runId)}`, {method:"HEAD"});
    if (!check.ok) {
      if (check.status === 404) evictRun(selection.runId);
      throw new HistoryRequestError("History snapshot is unavailable", check.status);
    }
    const archived = retained || cache === retainedCache || check.headers.get("X-History-Retained") === "1";
    if (cache.entries.get(key) === existing) {
      cache.entries.delete(key);
      remember((archived ? retainedCache : liveCache).entries, key, existing);
    }
    return { prepared:existing.value, archived };
  }
  if (existing) cache.entries.delete(key);
  const {pending} = retained || cache === retainedCache ? retainedCache : liveCache;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (pending.size >= 4) throw new HistoryRequestError("History is busy. Please retry shortly.", 503);
  const promise = (async () => {
    const params = new URLSearchParams({ run_id: selection.runId, range: selection.range, scope: selection.scope });
    const response = await backendFetch(`/v1/dashboard/history?${params}`);
    if (!response.ok) {
      if (response.status === 404) evictRun(selection.runId);
      throw new HistoryRequestError("History snapshot is unavailable", response.status);
    }
    const input = await response.json() as HistoryInput;
    if (input.runId !== selection.runId) throw new HistoryRequestError("History snapshot changed unexpectedly", 502);
    const prepared = prepareHistory(input, selection);
    const archived = retained || response.headers.get("X-History-Retained") === "1";
    remember((archived ? retainedCache : liveCache).entries, key, {
      value: prepared, bytes: Buffer.byteLength(JSON.stringify(prepared)), expires: Date.now() + 10 * 60_000,
    });
    return {prepared, archived};
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}
