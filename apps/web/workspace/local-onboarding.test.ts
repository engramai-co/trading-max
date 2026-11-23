import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { dashboardLensLatestKey, dashboardLensSnapshotKey } from "@/lib/dashboard-query";
import { createQueryClient } from "@/ui/query-client";
import {
  applyLocalWorkspaceConfirmation,
  LOCAL_ONBOARDING_QUERY_KEY,
  type LocalWorkspaceStatus,
} from "./local-onboarding";

function confirmedStatus(): LocalWorkspaceStatus {
  return {
    name: "Local test workspace",
    path: "/tmp/synthetic-workspace",
    connectedAccounts: ["invest"],
    readiness: {
      status: "ready",
      service: "trading_max-api",
      latestRunId: "run-1",
      bootstrapError: null,
      worker: {
        worker_id: "worker-test",
        status: "idle",
        started_at: null,
        last_seen_at: null,
        current_job_id: null,
        worker_version: "test",
        pid: 1,
        host: "localhost",
        age_seconds: 1,
        healthy: true,
      },
      queue: {
        queued: 0,
        running: 0,
        succeeded: 1,
        failed: 0,
        interrupted: 0,
        last_success_at: null,
      },
    },
    latestFullJob: null,
    activeJobId: null,
    canConfirm: false,
    confirmed: true,
  };
}

describe("applyLocalWorkspaceConfirmation", () => {
  it("refreshes only the exact live overview summary key while keeping historical snapshots and other lenses", async () => {
    const client = createQueryClient();
    const overviewKey = dashboardLensLatestKey("overview", undefined, { detail: "summary" });
    const snapshotKey = dashboardLensSnapshotKey("run-0", "overview", undefined, { detail: "summary" });
    const analyticsKey = dashboardLensLatestKey("analytics");
    const bareOverviewKey = dashboardLensLatestKey("overview");

    client.setQueryData(snapshotKey, { runId: "run-0", totalValueGbp: 500 });
    client.setQueryData(analyticsKey, { runId: "run-0", analytics: true });
    client.setQueryData(bareOverviewKey, { runId: "run-0", totalValueGbp: 400 });

    const readOverview = vi
      .fn<() => Promise<{ runId: string; totalValueGbp: number }>>()
      .mockRejectedValueOnce(new Error("Workspace not confirmed"))
      .mockResolvedValueOnce({ runId: "run-1", totalValueGbp: 1200 });

    const observer = new QueryObserver(client, {
      queryKey: overviewKey,
      queryFn: readOverview,
      retry: false,
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      expect(readOverview).toHaveBeenCalledTimes(1);

      const confirmed = confirmedStatus();
      const resetPromise = applyLocalWorkspaceConfirmation(client, confirmed);
      expect(client.getQueryState(overviewKey)?.status).toBe("pending");
      await resetPromise;

      expect(client.getQueryData(LOCAL_ONBOARDING_QUERY_KEY)).toEqual(confirmed);
      expect(readOverview).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(overviewKey)).toEqual({ runId: "run-1", totalValueGbp: 1200 });
      expect(client.getQueryData(snapshotKey)).toEqual({ runId: "run-0", totalValueGbp: 500 });
      expect(client.getQueryData(analyticsKey)).toEqual({ runId: "run-0", analytics: true });
      expect(client.getQueryData(bareOverviewKey)).toEqual({ runId: "run-0", totalValueGbp: 400 });
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("clears an inactive overview summary error without erasing cached historical snapshots", async () => {
    const client = createQueryClient();
    const overviewKey = dashboardLensLatestKey("overview", undefined, { detail: "summary" });
    const snapshotKey = dashboardLensSnapshotKey("run-0", "overview", undefined, { detail: "summary" });

    client.setQueryData(snapshotKey, { runId: "run-0", totalValueGbp: 500 });
    await expect(
      client.fetchQuery({
        queryKey: overviewKey,
        queryFn: async () => {
          throw new Error("Workspace not confirmed");
        },
        retry: false,
      }),
    ).rejects.toThrow("Workspace not confirmed");

    await applyLocalWorkspaceConfirmation(client, confirmedStatus());

    expect(client.getQueryState(overviewKey)?.status).toBe("pending");
    expect(client.getQueryState(overviewKey)?.error).toBeNull();
    expect(client.getQueryData(snapshotKey)).toEqual({ runId: "run-0", totalValueGbp: 500 });
    client.clear();
  });
});
