import { describe, expect, it } from "vitest";

import {
  deriveHealthTone,
  durationBetween,
  formatDuration,
  formatInterval,
  latestFullAccountJob,
  latestStage,
} from "@/lib/health";
import type {
  HealthDetails,
  RefreshJob,
  RefreshState,
} from "@/lib/types";

const worker = {
  worker_id: "worker-test",
  status: "idle",
  started_at: "2026-08-11T08:00:00.000Z",
  last_seen_at: "2026-08-11T08:00:02.000Z",
  current_job_id: null,
  worker_version: "test",
  pid: 42,
  host: "test-host",
  age_seconds: 2,
  healthy: true,
};

const queue = {
  queued: 0,
  running: 0,
  succeeded: 12,
  failed: 0,
  interrupted: 0,
  last_success_at: "2026-08-11T07:59:00.000Z",
};

function job(overrides: Partial<RefreshJob> = {}): RefreshJob {
  return {
    jobId: "job-1",
    scope: "accounts",
    skipSync: false,
    trigger: "on_demand",
    scheduledFor: null,
    status: "succeeded",
    createdAt: "2026-08-11T07:58:00.000Z",
    startedAt: "2026-08-11T07:58:01.000Z",
    finishedAt: "2026-08-11T07:58:30.000Z",
    snapshotRunId: "run-1",
    returnCode: 0,
    error: null,
    tickers: [],
    stages: [
      {
        name: "snapshot",
        label: "Publish snapshot",
        status: "succeeded",
        startedAt: "2026-08-11T07:58:02.000Z",
        finishedAt: "2026-08-11T07:58:29.000Z",
        returnCode: 0,
        error: null,
      },
    ],
    ...overrides,
  };
}

function refresh(overrides: Partial<RefreshState> = {}): RefreshState {
  return {
    activeJobId: null,
    latestJob: job(),
    latestFullJob: job(),
    latestIntradayJob: null,
    nightly: {
      enabled: true,
      timezone: "Europe/London",
      localTime: "06:30 · 12:00 · 17:30 · 22:30",
      localTimes: ["06:30", "12:00", "17:30", "22:30"],
      nextRunAt: "2026-08-12T05:30:00.000Z",
      lastJob: null,
    },
    intraday: {
      enabled: true,
      timezone: "Europe/London",
      intervalSeconds: 600,
      windowStart: "00:00",
      windowEnd: "00:00",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      nextRunAt: "2026-08-11T08:10:00.000Z",
      lastJob: null,
      consecutiveFailures: 0,
      submittedCount: 10,
      succeededCount: 10,
      failedCount: 0,
      flowUnverifiedCount: 0,
      skippedBusyCount: 0,
      lastError: null,
    },
    alerts: {
      enabled: true,
      phase: "running",
      heldIntervalSeconds: 300,
      watchlistIntervalSeconds: 900,
      lastAttemptAt: null,
      lastSuccessAt: null,
      heldUpdatedAt: null,
      watchlistUpdatedAt: null,
      quoteCount: 0,
      activeAlertCount: 0,
      lastError: null,
    },
    ...overrides,
  };
}

function details(overrides: Partial<HealthDetails> = {}): HealthDetails {
  return {
    checkedAt: "2026-08-11T08:00:05.000Z",
    health: {
      status: "ok",
      service: "trading_max-api",
      latestRunId: "run-1",
      bootstrapError: null,
      activeJobId: null,
      writeAuthEnabled: true,
      queue,
      worker,
      artifactAgeSeconds: 5,
    },
    readiness: {
      status: "ready",
      service: "trading_max-api",
      latestRunId: "run-1",
      bootstrapError: null,
      worker,
      queue,
    },
    refresh: refresh(),
    jobs: [job()],
    errors: [],
    ...overrides,
  };
}

describe("health status model", () => {
  it("reports a healthy backend as ready", () => {
    expect(deriveHealthTone(details())).toBe("ready");
  });

  it("reports an active full account job as running", () => {
    const active = job({ jobId: "job-active", status: "running", finishedAt: null });
    expect(
      deriveHealthTone(
        details({
          health: { ...details().health!, activeJobId: "job-active" },
          refresh: refresh({
            activeJobId: "job-active",
            latestJob: active,
            latestFullJob: active,
          }),
          jobs: [active],
        }),
      ),
    ).toBe("running");
  });

  it("degrades on an account failure but ignores research-only failures", () => {
    const failedAccount = job({ status: "failed", error: "failed" });
    expect(
      deriveHealthTone(
        details({
          refresh: refresh({ latestJob: failedAccount, latestFullJob: failedAccount }),
          jobs: [failedAccount],
        }),
      ),
    ).toBe("degraded");

    const researchFailure = job({
      jobId: "research-1",
      scope: "research",
      status: "failed",
      error: "research failed",
    });
    expect(deriveHealthTone(details({ jobs: [researchFailure] }))).toBe("ready");
  });

  it("preserves a degraded signal for partial probe failure", () => {
    expect(
      deriveHealthTone(
        details({
          errors: [{ scope: "jobs", status: 503, detail: "jobs probe unavailable" }],
        }),
      ),
    ).toBe("degraded");
  });

  it("distinguishes an entirely unavailable backend", () => {
    expect(
      deriveHealthTone({
        checkedAt: "2026-08-11T08:00:05.000Z",
        health: null,
        readiness: null,
        refresh: null,
        jobs: [],
        errors: [{ scope: "backend", status: null, detail: "unavailable" }],
      }),
    ).toBe("unavailable");
  });
});

describe("health formatting and selection", () => {
  it("formats intervals and durations in both locales", () => {
    expect(formatInterval(600)).toBe("10 min");
    expect(formatInterval(600, "zh")).toBe("10 分钟");
    expect(formatDuration(65)).toBe("1m 5s");
    expect(formatDuration(65, "zh")).toBe("1 分 5 秒");
    expect(durationBetween("2026-08-11T08:00:00.000Z", "2026-08-11T08:01:05.000Z")).toBe("1m 5s");
  });

  it("selects the newest full account job and active/failed stages", () => {
    const older = job({ jobId: "old", createdAt: "2026-08-10T08:00:00.000Z" });
    const newer = job({
      jobId: "new",
      createdAt: "2026-08-11T08:00:00.000Z",
      stages: [
        {
          name: "sync",
          label: "Sync",
          status: "running",
          startedAt: "2026-08-11T08:00:01.000Z",
          finishedAt: null,
          returnCode: null,
          error: null,
        },
      ],
    });
    const chosen = latestFullAccountJob(
      details({ refresh: null, jobs: [older, newer] }),
    );
    expect(chosen?.jobId).toBe("new");
    expect(latestStage(newer)?.status).toBe("running");

    const failedStageJob = job({
      stages: [
        { ...job().stages[0], status: "failed", error: "boom" },
      ],
    });
    expect(latestStage(failedStageJob)?.status).toBe("failed");
  });
});
