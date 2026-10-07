import type { RefreshJob } from "@/lib/types";

export type JobHistoryRow = { job: RefreshJob; repeats: number };

/**
 * Routine successes repeat every few minutes and bury the runs that need
 * attention. Keep every unfinished or failed run, and only the latest success
 * per scope with a count of the earlier ones. Input is newest first.
 */
export function collapseRoutineRuns(jobs: RefreshJob[]): JobHistoryRow[] {
  const rows: JobHistoryRow[] = [];
  const latestSuccess = new Map<string, JobHistoryRow>();
  for (const job of jobs) {
    if (job.status !== "succeeded") {
      rows.push({ job, repeats: 0 });
      continue;
    }
    const kept = latestSuccess.get(job.scope);
    if (kept) {
      kept.repeats += 1;
      continue;
    }
    const row = { job, repeats: 0 };
    latestSuccess.set(job.scope, row);
    rows.push(row);
  }
  return rows;
}
