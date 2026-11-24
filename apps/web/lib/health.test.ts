import { describe, expect, it } from "vitest";
import { activityState } from "@/workspace/desktop-status";

import {
  deriveHealthDecision,
  durationBetween,
  formatDuration,
  formatInterval,
  flowVerificationText,
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
      flowAnchorCount: 25,
      flowSnapshotRunId: "run-1",
      flowVerificationStatus: "available",
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
  const tone = (data: HealthDetails, localWorkspace = false) =>
    deriveHealthDecision(data, { localWorkspace }).tone;

  function emptyLocal() {
    const emptyQueue = { ...queue, queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0, last_success_at: null };
    const emptyError = "FileNotFoundError: no typed snapshot has been published";
    return details({
      health: { ...details().health!, status: "degraded", latestRunId: null, queue: emptyQueue, bootstrapError: emptyError },
      readiness: { ...details().readiness!, status: "not_ready", latestRunId: null, queue: emptyQueue, bootstrapError: emptyError },
      refresh: refresh({ latestJob: null, latestFullJob: null }), jobs: [],
    });
  }

  it("treats a new local workspace as setup without declaring data ready", () => {
    expect(tone(emptyLocal(), true)).toBe("setup");
    expect(activityState(emptyLocal(), true).tone).toBe("setup");
    expect(activityState(emptyLocal()).tone).toBe("degraded");
    expect(tone(emptyLocal())).toBe("degraded");
  });

  it("never hides a failed worker, prior data loss, or a real bootstrap error behind setup", () => {
    const empty = emptyLocal();
    for (const change of [
      { worker: { ...worker, healthy: false } },
      { bootstrapError: "IntegrityError: damaged snapshot" },
      { queue: { ...empty.health!.queue, succeeded: 1 } },
      { queue: { ...empty.health!.queue, interrupted: 1 } },
    ]) expect(tone({ ...empty, health: { ...empty.health!, ...change } }, true)).toBe("degraded");
    expect(tone({ ...empty, errors: [{ scope: "jobs", status: 503, detail: "unavailable" }] }, true)).toBe("degraded");
  });

  it("reports a healthy backend as ready", () => {
    expect(tone(details())).toBe("ready");
  });

  it("reports an active full account job as running", () => {
    const active = job({ jobId: "job-active", status: "running", finishedAt: null });
    expect(
      tone(
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

  it("keeps a normal first sync running while giving confirmed failures precedence", () => {
    const empty = emptyLocal();
    const active = job({ status: "running", finishedAt: null });
    const firstSync = {
      ...empty,
      health: { ...empty.health!, activeJobId: active.jobId, queue: { ...empty.health!.queue, running: 1 } },
      jobs: [active],
    };
    expect(tone(firstSync, true)).toBe("running");
    expect(deriveHealthDecision({
      ...firstSync, readiness: { ...firstSync.readiness!, bootstrapError: "Damaged snapshot" },
    }, { localWorkspace: true })).toMatchObject({ tone: "degraded", bootstrapIssue: "Damaged snapshot" });

    const published = details({
      health: { ...details().health!, activeJobId: active.jobId, queue: { ...queue, queued: 1 } },
      jobs: [active],
    });
    expect(tone(published)).toBe("running");
    for (const change of [
      { readiness: { ...published.readiness!, status: "degraded" as const } },
      { health: { ...published.health!, bootstrapError: "Damaged snapshot" } },
      { errors: [{ scope: "jobs" as const, status: 503, detail: "unavailable" }] },
    ]) expect(tone({ ...published, ...change })).toBe("degraded");
  });

  it("announces event source failures, changes and recovery while ignoring check timestamps", () => {
    const base = details();
    const source = { kind: "news" as const, checkedAt: null, asOf: null, failedSources: 1 };
    const withFailure = details({ health: { ...base.health!, eventRefreshes: [
      { ...source, failures: [{ source: "Fixture news" }] },
    ] } });
    const failed = deriveHealthDecision(withFailure);
    expect(failed.tone).toBe("degraded");
    expect(deriveHealthDecision({ ...withFailure, checkedAt: "2026-08-11T09:00:00Z" }).semanticKey).toBe(failed.semanticKey);
    expect(deriveHealthDecision(details({
      health: { ...base.health!, eventRefreshes: [
        { ...source, failures: [{ source: "Another fixture" }] },
      ] },
    })).semanticKey).not.toBe(failed.semanticKey);
    expect(deriveHealthDecision(base).semanticKey).not.toBe(failed.semanticKey);
  });

  it("degrades on account and research failures", () => {
    const failedAccount = job({ status: "failed", error: "failed" });
    expect(
      tone(
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
    expect(tone(details({ jobs: [researchFailure] }))).toBe("degraded");
  });

  it("preserves a degraded signal for partial probe failure", () => {
    expect(
      tone(
        details({
          errors: [{ scope: "jobs", status: 503, detail: "jobs probe unavailable" }],
        }),
      ),
    ).toBe("degraded");
  });

  it("distinguishes an entirely unavailable backend", () => {
    expect(
      tone({
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

describe("current snapshot flow coverage", () => {
  it("shows anchor counts independently of successful refresh jobs", () => {
    const schedule = { ...refresh().intraday, succeededCount: 1200, flowUnverifiedCount: 2 };
    expect(flowVerificationText(schedule)).toBe("2 of 25 valuations unverified");
    expect(flowVerificationText(schedule, "zh")).toBe("2 / 25 个估值点待验证");
    expect(flowVerificationText({ ...schedule, flowUnverifiedCount: 0 }))
      .toBe("0 of 25 valuations unverified");
    expect(flowVerificationText({ ...schedule, flowAnchorCount: 1, flowUnverifiedCount: 1 }))
      .toBe("1 of 1 valuation unverified");
  });

  it("distinguishes missing snapshots, unreadable coverage and empty history from verified data", () => {
    const schedule = refresh().intraday;
    expect(flowVerificationText(undefined)).toBe("Verification unavailable");
    expect(flowVerificationText({ ...schedule, flowVerificationStatus: "no_snapshot", flowUnverifiedCount: null }))
      .toBe("No snapshot yet");
    expect(flowVerificationText({ ...schedule, flowVerificationStatus: "unavailable", flowUnverifiedCount: null }))
      .toBe("Verification unavailable");
    expect(flowVerificationText({ ...schedule, flowAnchorCount: 0, flowUnverifiedCount: 0 }))
      .toBe("No retained valuations");
    expect(flowVerificationText({ ...schedule, flowUnverifiedCount: 26 }))
      .toBe("Verification unavailable");
  });
});

describe("scope failures, probe availability, and stale snapshot independence", () => {
  it("keeps a later-finishing failure visible when older services return overlapping jobs", () => {
    const slowFailure = job({
      jobId: "slow-failure",
      scope: "cfd",
      status: "failed",
      createdAt: "2026-11-01T00:00:00+00:00",
      startedAt: null,
      finishedAt: "2026-11-03T00:00:00+00:00",
    });
    const quickSuccess = job({
      jobId: "quick-success",
      scope: "cfd",
      status: "succeeded",
      createdAt: "2026-11-02T00:00:00+00:00",
      startedAt: null,
      finishedAt: "2026-11-02T00:00:00+00:00",
    });
    const olderService = details({ jobs: [quickSuccess, slowFailure] });

    expect(deriveHealthDecision(olderService)).toMatchObject({ tone: "degraded", failures: [slowFailure] });
    expect(activityState(olderService)).toMatchObject({ tone: "degraded", failures: [slowFailure] });
  });

  it("uses start time, creation time and job ID to resolve legacy terminal outcomes", () => {
    const failure = job({
      jobId: "z-failure",
      status: "interrupted",
      finishedAt: null,
      startedAt: "2026-08-11T07:58:30.000001Z",
    });
    const success = job({ jobId: "a-success" });
    const failuresFor = (jobs: RefreshJob[]) => deriveHealthDecision(details({ refresh: null, jobs })).failures;

    expect(failuresFor([success, failure])).toEqual([failure]);
    const sameOutcomeTime = { ...success, finishedAt: failure.startedAt };
    expect(failuresFor([sameOutcomeTime, failure])).toEqual([failure]);
    expect(failuresFor([{ ...sameOutcomeTime, createdAt: "2026-08-11T07:58:01Z" }, failure])).toEqual([]);
  });

  it("tracks unresolved failures per scope across recent successes and clears on scope recovery", () => {
    const perfFailed = job({
      jobId: "perf-failed",
      scope: "performance",
      trigger: "performance",
      status: "failed",
      createdAt: "2026-08-11T07:50:00Z",
      error: "Performance build failed",
    });
    const liveSucceeded = job({
      jobId: "live-ok",
      scope: "live",
      trigger: "live",
      status: "succeeded",
      createdAt: "2026-08-11T07:55:00.500Z",
    });
    const perfSucceeded = job({
      jobId: "perf-ok",
      scope: "performance",
      trigger: "performance",
      status: "succeeded",
      createdAt: "2026-08-11T08:00:00.000Z",
    });
    const degraded = details({
      refresh: refresh({
        latestJob: liveSucceeded,
        performance: { ...refresh().intraday, lastJob: perfFailed },
      }),
      jobs: [liveSucceeded],
    });
    const decision = deriveHealthDecision(degraded);
    expect(decision.failures.map((item) => item.jobId)).toEqual(["perf-failed"]);
    expect(decision.tone).toBe("degraded");
    expect(decision.serviceHealthy).toBe(true);
    expect(decision.serviceIssue).toBe(false);
    expect(decision.snapshotTime).toBe("2026-08-11T08:00:00.000Z");

    for (const status of ["queued", "running"] as const) {
      const retry = { ...perfSucceeded, jobId: "perf-retry", status };
      const retrying = deriveHealthDecision({
        ...degraded,
        health: { ...degraded.health!, queue: { ...queue, [status]: 1 } },
        refresh: refresh({ latestJob: retry }),
        jobs: [retry, liveSucceeded, perfFailed],
      });
      expect(retrying.failures.map((item) => item.jobId)).toEqual(["perf-failed"]);
      expect(retrying.tone).toBe("degraded");
      expect(retrying[status]).toBe(1);
    }

    const recovered = details({
      refresh: refresh({
        latestJob: perfSucceeded,
        performance: { ...refresh().intraday, lastJob: perfSucceeded },
      }),
      jobs: [perfSucceeded, liveSucceeded, perfFailed],
    });
    const cleared = deriveHealthDecision(recovered);
    expect(cleared.failures).toEqual([]);
    expect(cleared.tone).toBe("ready");
  });

  it("keeps snapshot stale age independent of health tone and missing probes", () => {
    const agedHealth = { ...details().health!, artifactAgeSeconds: 432_000 };
    const partialProbeFailure = details({
      health: agedHealth,
      refresh: null,
      jobs: [],
      errors: [
        { scope: "refresh", status: 503, detail: "refresh probe returned HTTP 503" },
        { scope: "jobs", status: 503, detail: "jobs probe returned HTTP 503" },
      ],
    });
    const decision = deriveHealthDecision(partialProbeFailure);
    expect(decision.tone).toBe("degraded");
    expect(decision.stale).toBe(true);
    expect(decision.serviceHealthy).toBe(true);
    expect(decision.scheduleUnavailable).toBe(true);
    expect(decision.jobsUnavailable).toBe(true);
    expect(deriveHealthDecision(partialProbeFailure, { readOnly: true }).stale).toBe(false);
  });

  it("keeps an unhealthy worker's queue visible without declaring the update in progress", () => {
    const active = job({ status: "queued", finishedAt: null });
    const stalled = details({
      health: { ...details().health!, queue: { ...queue, queued: 1 }, worker: { ...worker, healthy: false } },
      refresh: refresh({ activeJobId: active.jobId, latestFullJob: active }),
      jobs: [active],
    });
    const state = deriveHealthDecision(stalled);
    expect(state.queued).toBe(1);
    expect(state.tone).toBe("degraded");
    expect(activityState(stalled).tone).toBe("degraded");

    const healthy = { ...stalled, health: { ...stalled.health!, worker } };
    expect(deriveHealthDecision(healthy).tone).toBe("running");
  });

  it("deduplicates repeated poll ticks while changing semantic key on material transitions", () => {
    const base = details();
    const poll1 = deriveHealthDecision(base);
    const poll2 = deriveHealthDecision({
      ...base,
      checkedAt: "2026-08-11T08:00:10.000Z",
      health: {
        ...base.health!,
        artifactAgeSeconds: 10,
        worker: { ...worker, age_seconds: 7, last_seen_at: "2026-08-11T08:00:07.000Z" },
      },
    });
    expect(poll1.semanticKey).toBe(poll2.semanticKey);

    const failed = deriveHealthDecision(
      details({
        jobs: [job({ jobId: "perf-1", scope: "performance", status: "failed", error: "boom" })],
      }),
    );
    expect(failed.semanticKey).not.toBe(poll1.semanticKey);

    const stale = deriveHealthDecision(
      details({ health: { ...base.health!, artifactAgeSeconds: 90_000 } }),
    );
    expect(stale.semanticKey).not.toBe(poll1.semanticKey);
    expect(deriveHealthDecision(
      details({ health: { ...base.health!, artifactAgeSeconds: 172_800 } }),
    ).semanticKey).toBe(stale.semanticKey);
  });
});
