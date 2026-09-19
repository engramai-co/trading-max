"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type DashboardSelection,
  dashboardLensLatestKey,
  dashboardLensSnapshotKey,
} from "@/lib/dashboard-query";
import type { AccountCode, DashboardLens, DashboardLensName } from "@/lib/types";

async function fetchDashboardLens(
  view: DashboardLensName,
  account?: AccountCode,
  selection?: DashboardSelection,
): Promise<DashboardLens> {
  const params = new URLSearchParams();
  if (account) params.set("account", account);
  for (const [key, value] of Object.entries(selection ?? {})) if (value) params.set(key, value);
  const query = params.size ? `?${params}` : "";
  const response = await fetch(`/api/backend/dashboard/lens/${view}${query}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`dashboard lens returned ${response.status}`);
  }
  return (await response.json()) as DashboardLens;
}

export function useDashboardLens(
  view: DashboardLensName,
  account?: AccountCode,
  enabled = true,
  selection?: DashboardSelection,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    enabled,
    queryFn: () => fetchDashboardLens(view, account, selection),
    queryKey: dashboardLensLatestKey(view, account, selection),
    retry: 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!query.data) return;
    queryClient.setQueryData(
      dashboardLensSnapshotKey(query.data.runId, view, account, selection),
      query.data,
    );
  }, [account, query.data, queryClient, view, selection]);

  return query;
}
