"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type DashboardSelection,
  dashboardLensLatestKey,
  dashboardLensSnapshotKey,
} from "@/lib/dashboard-query";
import type { AccountCode, DashboardLens, DashboardLensName } from "@/lib/types";
import { ApiError } from "@/workspace/data";

export async function fetchDashboardLens(
  view: DashboardLensName,
  account?: AccountCode,
  selection?: DashboardSelection,
  signal?: AbortSignal,
  runId?: string,
): Promise<DashboardLens> {
  const params = new URLSearchParams();
  if (runId) params.set("runId", runId);
  if (account) params.set("account", account);
  for (const [key, value] of Object.entries(selection ?? {})) if (value) params.set(key, value);
  const query = params.size ? `?${params}` : "";
  const response = await fetch(`/api/backend/dashboard/lens/${view}${query}`, {
    cache: "no-store", signal,
  });
  if (!response.ok) {
    throw new ApiError(`dashboard lens returned ${response.status}`, response.status);
  }
  const data = await response.json() as DashboardLens;
  if (runId && data.runId !== runId) throw new Error("Cited publication unavailable");
  return data;
}

export function useDashboardLens(
  view: DashboardLensName,
  account?: AccountCode,
  enabled = true,
  selection?: DashboardSelection,
  runId?: string,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    enabled,
    queryFn: ({ signal }) => fetchDashboardLens(view, account, selection, signal, runId),
    queryKey: runId ? dashboardLensSnapshotKey(runId, view, account, selection) : dashboardLensLatestKey(view, account, selection),
    retry: 1,
    staleTime: runId ? 0 : 30_000,
  });

  useEffect(() => {
    if (!query.data || runId) return;
    queryClient.setQueryData(
      dashboardLensSnapshotKey(query.data.runId, view, account, selection),
      query.data,
    );
  }, [account, query.data, queryClient, view, selection, runId]);

  return query;
}
