import type { HealthDetails, RefreshJob } from "@/lib/types";

export type HealthTone =
  | "ready"
  | "running"
  | "degraded"
  | "unavailable"
  | "unknown";

export type HealthLocale = "zh" | "en";

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
  return right.createdAt.localeCompare(left.createdAt);
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

export function activeAccountJob(
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

export function deriveHealthTone(details: HealthDetails | null): HealthTone {
  if (!details) return "unknown";

  const hasBackendProbe = Boolean(
    details.health || details.readiness || details.refresh,
  );
  const hasBackendFailure = details.errors.some(
    (error) => error.scope === "backend",
  );
  if (!hasBackendProbe && hasBackendFailure) return "unavailable";

  if (activeAccountJob(details)) return "running";

  const latestFull = latestFullAccountJob(details);
  if (latestFull?.status === "failed" || latestFull?.status === "interrupted") {
    return "degraded";
  }

  const health = details.health;
  const readiness = details.readiness;
  const worker = health?.worker ?? readiness?.worker;
  const probeFailure = details.errors.length > 0;
  const unhealthy =
    health?.status !== "ok" ||
    readiness?.status !== "ready" ||
    worker?.healthy !== true ||
    Boolean(health?.bootstrapError || readiness?.bootstrapError) ||
    health?.latestRunId === null;

  return probeFailure || unhealthy ? "degraded" : "ready";
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
