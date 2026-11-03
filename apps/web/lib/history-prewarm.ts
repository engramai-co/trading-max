import "server-only";
import { backendFetch, backendUrl } from "./backend";
import { readPreparedHistory } from "./history-server";
import type { HistorySelection } from "./portfolio/prepared";

/** What the overview and performance pages open on before the reader picks a range. */
const DEFAULTS: Array<Omit<HistorySelection, "runId">> = [
  { range: "3M", scope: "total" },
  { range: "1D", scope: "total" },
];

let started = false;

/**
 * Live collection publishes a new snapshot every few minutes, and prepared history
 * is keyed by snapshot. Preparing the default views as soon as a run appears means
 * the first reader after each run does not wait for them.
 */
export function startHistoryPrewarm(intervalMs = 5_000) {
  if (started || !backendUrl()) return;
  started = true;
  let warmed: string | null = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await backendFetch("/health");
      if (!response.ok) return;
      const runId = (await response.json() as { latestRunId?: string | null }).latestRunId;
      if (!runId || runId === warmed) return;
      for (const selection of DEFAULTS) await readPreparedHistory({ runId, ...selection });
      warmed = runId;
    } catch {
      // The next tick retries; readers still prepare on demand.
    } finally {
      busy = false;
    }
  };
  setInterval(tick, intervalMs).unref();
  void tick();
}
