"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  dashboardLensLatestKey,
  dashboardLensSnapshotKey,
} from "@/lib/dashboard-query";
import type { AccountCode, DashboardLens, DashboardLensName } from "@/lib/types";

async function fetchDashboardLens(
  view: DashboardLensName,
  account?: AccountCode,
): Promise<DashboardLens> {
  const query = account ? `?account=${encodeURIComponent(account)}` : "";
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
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    enabled,
    queryFn: () => fetchDashboardLens(view, account),
    queryKey: dashboardLensLatestKey(view, account),
    retry: 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!query.data) return;
    queryClient.setQueryData(
      dashboardLensSnapshotKey(query.data.runId, view, account),
      query.data,
    );
  }, [account, query.data, queryClient, view]);

  return query;
}
