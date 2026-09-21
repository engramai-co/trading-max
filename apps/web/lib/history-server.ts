import "server-only";
import { backendFetch } from "./backend";
import { prepareHistory, type HistoryInput, type HistorySelection } from "@/lib/portfolio/prepared";

type Prepared = ReturnType<typeof prepareHistory>;
const cache = new Map<string, { value: Prepared; bytes: number; expires: number }>();
const pending = new Map<string, Promise<Prepared>>();
const BUDGET = 32 * 1024 * 1024;

export class HistoryRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Bounded process cache only; a miss reopens the same immutable snapshot. */
export async function readPreparedHistory(selection: HistorySelection): Promise<Prepared> {
  const key = JSON.stringify(selection);
  for (const [id, entry] of cache) if (entry.expires <= Date.now()) cache.delete(id);
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing.value; }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (pending.size >= 4) throw new HistoryRequestError("History is busy. Please retry shortly.", 503);
  const promise = (async () => {
    const params = new URLSearchParams({ run_id: selection.runId, range: selection.range, scope: selection.scope });
    const response = await backendFetch(`/v1/dashboard/history?${params}`);
    if (!response.ok) throw new HistoryRequestError("History snapshot is unavailable", response.status);
    const input = await response.json() as HistoryInput;
    if (input.runId !== selection.runId) throw new HistoryRequestError("History snapshot changed unexpectedly", 502);
    const result = prepareHistory(input, selection);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes <= BUDGET) {
      const used = () => [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (cache.size && (cache.size >= 2 || used() + bytes > BUDGET)) cache.delete(cache.keys().next().value!);
      cache.set(key, { value: result, bytes, expires: Date.now() + 10 * 60_000 });
    }
    return result;
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}
