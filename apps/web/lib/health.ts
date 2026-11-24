import type { HealthDetails, RefreshJob, RefreshState } from "@/lib/types";

export type HealthTone =
  | "setup"
  | "ready"
  | "running"
  | "degraded"
  | "unavailable"
  | "unknown";

export type HealthLocale = "zh" | "en";

export function flowVerificationText(
  schedule: RefreshState["live"] | null,
  locale: HealthLocale = "en",
): string {
  if (schedule?.flowVerificationStatus === "no_snapshot") {
    return locale === "zh" ? "尚无快照" : "No snapshot yet";
  }
  const count = schedule?.flowUnverifiedCount;
  const total = schedule?.flowAnchorCount;
  if (
    schedule?.flowVerificationStatus !== "available" ||
    count == null || total == null ||
    !Number.isInteger(count) || !Number.isInteger(total) ||
    count < 0 || total < count
  ) {
    return locale === "zh" ? "验证状态不可用" : "Verification unavailable";
  }
  if (total === 0) return locale === "zh" ? "暂无保留估值点" : "No retained valuations";
  const format = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-GB");
  return locale === "zh"
    ? `${format.format(count)} / ${format.format(total)} 个估值点待验证`
    : `${format.format(count)} of ${format.format(total)} ${total === 1 ? "valuation" : "valuations"} unverified`;
}

const ZH_SECOND = "\u79d2";
const ZH_MINUTE = "\u5206\u949f";
const ZH_MINUTE_SHORT = "\u5206";
const ZH_HOUR = "\u5c0f\u65f6";
const ZH_DAY = "\u5929";

function isFullAccountJob(job: RefreshJob | null | undefined): job is RefreshJob {
  return Boolean(
    job &&
      (job.scope === "all" || job.scope === "accounts") &&
      (job.trigger === "on_demand" || job.trigger === "nightly"),
  );
}

function byNewest(left: RefreshJob, right: RefreshJob) {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.createdAt.localeCompare(left.createdAt);
}

function byJobTimestamp(left: string, right: string) {
  // Date.parse truncates the queue's microsecond timestamps to milliseconds.
  const fraction = (value: string) => Number(value.match(/\.\d+/)?.[0] ?? 0);
  return Date.parse(right) - Date.parse(left) || fraction(right) - fraction(left);
}

function byLatestOutcome(left: RefreshJob, right: RefreshJob) {
  const leftAt = left.finishedAt ?? left.startedAt ?? left.createdAt;
  const rightAt = right.finishedAt ?? right.startedAt ?? right.createdAt;
  const byTime = byJobTimestamp(leftAt, rightAt) || byJobTimestamp(left.createdAt, right.createdAt);
  if (byTime || left.jobId === right.jobId) return byTime;
  return left.jobId < right.jobId ? 1 : -1;
}

export function latestFullAccountJob(
  details: HealthDetails | null,
): RefreshJob | null {
  if (!details) return null;
  if (isFullAccountJob(details.refresh?.latestFullJob)) {
    return details.refresh.latestFullJob;
  }
  return (
    details.jobs.filter(isFullAccountJob).sort(byNewest)[0] ?? null
  );
}

function activeAccountJob(
  details: HealthDetails | null,
): RefreshJob | null {
  if (!details) return null;
  const activeJobId =
    details.refresh?.activeJobId ?? details.health?.activeJobId ?? null;
  if (!activeJobId) return null;
  const candidate = [
    details.refresh?.latestJob,
    details.refresh?.latestFullJob,
    ...details.jobs,
  ].find((job) => job?.jobId === activeJobId);
  return isFullAccountJob(candidate) &&
    (candidate.status === "queued" || candidate.status === "running")
    ? candidate
    : null;
}

export function latestStage(job: RefreshJob | null): RefreshJob["stages"][number] | null {
  if (!job || job.stages.length === 0) return null;
  return (
    job.stages.find((stage) => stage.status === "running") ??
    job.stages.find((stage) => stage.status === "failed") ??
    job.stages.find((stage) => stage.status === "interrupted") ??
    [...job.stages].reverse().find((stage) => stage.status !== "queued") ??
    job.stages[0]
  );
}

export function formatInterval(
  seconds: number | null | undefined,
  locale: HealthLocale = "en",
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return locale === "zh" ? `${value} ${ZH_SECOND}` : `${value}s`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return locale === "zh" ? `${minutes} ${ZH_MINUTE}` : `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale === "zh" ? `${hours} ${ZH_HOUR}` : `${hours}h`;
  const days = Math.round(hours / 24);
  return locale === "zh" ? `${days} ${ZH_DAY}` : `${days}d`;
}

export function formatDuration(
  seconds: number | null | undefined,
  locale: HealthLocale = "en",
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return locale === "zh" ? `${value} ${ZH_SECOND}` : `${value}s`;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  if (locale === "zh") {
    return remainder
      ? `${minutes} ${ZH_MINUTE_SHORT} ${remainder} ${ZH_SECOND}`
      : `${minutes} ${ZH_MINUTE}`;
  }
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function durationBetween(
  startedAt: string | null,
  finishedAt: string | null,
  locale: HealthLocale = "en",
): string {
  if (!startedAt) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "—";
  }
  return formatDuration((end - start) / 1000, locale);
}

export function formatAge(
  seconds: number | null | undefined,
  locale: HealthLocale = "en",
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  return formatInterval(seconds, locale);
}

export function shortRunId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** A newer queued or running retry leaves the last completed outcome in place. */
export function unresolvedScopeFailures(
  details: HealthDetails | null | undefined,
): RefreshJob[] {
  if (!details) return [];
  if (details.latestTerminalJobs) {
    return details.latestTerminalJobs.filter((job) => job.status === "failed" || job.status === "interrupted").sort(byNewest);
  }
  // Older services only provide the recent list and scheduler pointers.
  const { refresh } = details;
  const terminalJobs = [
    refresh?.latestJob,
    refresh?.latestFullJob,
    refresh?.latestIntradayJob,
    refresh?.nightly?.lastJob,
    refresh?.live?.lastJob,
    refresh?.intraday?.lastJob,
    refresh?.performance?.lastJob,
    refresh?.research?.lastJob,
    ...details.jobs,
  ].filter((job): job is RefreshJob =>
    job?.status === "succeeded" || job?.status === "failed" || job?.status === "interrupted",
  ).sort(byLatestOutcome);
  const latest = new Map<RefreshJob["scope"], RefreshJob>();
  for (const job of terminalJobs) {
    if (!latest.has(job.scope)) latest.set(job.scope, job);
  }
  return [...latest.values()].filter((job) => job.status !== "succeeded").sort(byNewest);
}

export function deriveHealthDecision(
  details: HealthDetails | null | undefined,
  { localWorkspace = false, readOnly = false } = {},
) {
  const health = details?.health;
  const readiness = details?.readiness;
  const queue = health?.queue ?? readiness?.queue;
  const worker = health?.worker ?? readiness?.worker;
  const queued = queue?.queued ?? 0;
  const running = queue?.running ?? 0;
  const failures = unresolvedScopeFailures(details);
  const eventFailures = health?.eventRefreshes?.filter((event) => event.failedSources > 0)
    .sort((left, right) => left.kind.localeCompare(right.kind)) ?? [];
  const errors = details?.errors ?? [];
  const backendUnavailable = errors.some((error) => error.scope === "backend");
  const latestRunId = health?.latestRunId ?? readiness?.latestRunId ?? null;
  const noSnapshotError = "FileNotFoundError: no typed snapshot has been published";
  const expectedEmpty = (error?: string | null) => !error || error === noSnapshotError;
  const bootstrapError = [health?.bootstrapError, readiness?.bootstrapError].find((error) => !expectedEmpty(error))
    ?? health?.bootstrapError ?? readiness?.bootstrapError;
  const emptySnapshot = health?.status === "degraded" && readiness?.status === "not_ready" &&
    health.latestRunId === null && readiness.latestRunId === null &&
    expectedEmpty(health.bootstrapError) && expectedEmpty(readiness.bootstrapError);
  const activeFullJob = activeAccountJob(details ?? null);
  const firstSync = emptySnapshot && Boolean(activeFullJob);
  const setup = emptySnapshot && localWorkspace && details?.jobs.length === 0 &&
    !details.refresh?.latestJob && !details.latestTerminalJobs?.length && !latestFullAccountJob(details) &&
    queue?.succeeded === 0 && queue.failed === 0 && queue.interrupted === 0 &&
    queued === 0 && running === 0;
  const apiReachable = health?.status === "ok" || setup || firstSync;
  const readinessIssue = Boolean(readiness && readiness.status !== "ready" && !setup && !firstSync);
  const bootstrapIssue = bootstrapError && !(
    bootstrapError === noSnapshotError && !latestRunId && (localWorkspace || firstSync)
  ) ? bootstrapError : null;
  const serviceHealthy = apiReachable && worker?.healthy === true && !bootstrapIssue &&
    (setup || firstSync || (readiness?.status === "ready" && latestRunId !== null));
  const tone: HealthTone = !details ? "unknown"
    : backendUnavailable && !health && !readiness && !details.refresh ? "unavailable"
    : !serviceHealthy || errors.length || failures.length || eventFailures.length ? "degraded"
    : setup ? "setup"
    : activeFullJob || queued > 0 || running > 0 ? "running"
    : "ready";
  const snapshot = latestRunId ? "published" : tone === "setup" ? "setup" : "unpublished";
  const age = health?.artifactAgeSeconds;
  const stale = !readOnly && snapshot === "published" && age != null && age > 86_400;
  const checkedTime = Date.parse(details?.checkedAt ?? "");
  const snapshotTime = snapshot === "published" && age != null && Number.isFinite(age) &&
    Number.isFinite(checkedTime)
    ? new Date(checkedTime - age * 1000).toISOString() : null;
  const scheduleUnavailable = !details?.refresh || backendUnavailable || errors.some((error) => error.scope === "refresh");
  const jobsUnavailable = backendUnavailable || errors.some((error) => error.scope === "jobs");
  const serviceErrors = errors.filter((error) => error.scope !== "refresh" && error.scope !== "jobs");
  const serviceIssue = !serviceHealthy || serviceErrors.length > 0;
  const semanticKey = details && JSON.stringify([
    tone, snapshot, stale, apiReachable, readinessIssue, worker?.healthy, Boolean(bootstrapIssue),
    failures.map((job) => job.scope + ":" + job.status).sort(),
    eventFailures.map((event) => [
      event.kind, event.failedSources, event.failures?.map((failure) => failure.source).sort(),
    ]),
    [...new Set(errors.map((error) => error.scope))].sort(), scheduleUnavailable, jobsUnavailable,
  ]);
  return {
    latestRunId, failures, tone, snapshot, stale, snapshotTime, queued, running, worker,
    apiReachable, readinessIssue, bootstrapIssue, serviceHealthy, serviceIssue, serviceErrors, eventFailures,
    scheduleUnavailable, jobsUnavailable, lastSuccess: queue?.last_success_at, semanticKey,
  };
}
