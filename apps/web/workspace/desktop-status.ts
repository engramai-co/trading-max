import { deriveHealthTone, latestFullAccountJob } from "@/lib/health";
import type { HealthDetails, RefreshJob } from "@/lib/types";

export function activityState(details: HealthDetails | null, localWorkspace = false) {
  // Judge each scope separately. A successful lightweight balance refresh
  // must not erase a failed history/performance refresh.
  const latest = new Map<string, RefreshJob>();
  const refresh = details?.refresh;
  const jobs = [refresh?.latestJob, latestFullAccountJob(details), refresh?.nightly?.lastJob,
    refresh?.live?.lastJob, refresh?.intraday?.lastJob, refresh?.performance?.lastJob,
    refresh?.research?.lastJob, ...(details?.jobs ?? [])]
    .filter((job): job is RefreshJob => Boolean(job))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const job of jobs) if (!latest.has(job.scope)) latest.set(job.scope, job);
  const failures = [...latest.values()].filter((job) => job.status === "failed" || job.status === "interrupted");
  const running = (details?.health?.queue.running ?? 0) + (details?.health?.queue.queued ?? 0) > 0;
  const tone = deriveHealthTone(details, localWorkspace);
  return { failures, running, tone: failures.length ? "degraded" as const : running ? "running" as const : tone };
}
