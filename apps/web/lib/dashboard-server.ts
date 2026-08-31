import "server-only";

import type { QueryClient } from "@tanstack/react-query";

import { backendFetch } from "@/lib/backend";
import {
  dashboardLensLatestKey,
  dashboardLensSnapshotKey,
} from "@/lib/dashboard-query";
import type { AccountCode, DashboardLens, DashboardLensName } from "@/lib/types";

export async function loadDashboardLens(
  view: DashboardLensName,
  account?: AccountCode,
): Promise<DashboardLens> {
  const query = account ? `?account=${encodeURIComponent(account)}` : "";
  const response = await backendFetch(`/v1/dashboard/lens/${view}${query}`);
  if (!response.ok) {
    throw new Error(`dashboard lens returned ${response.status}`);
  }
  return (await response.json()) as DashboardLens;
}

export async function prefetchDashboardLens(
  queryClient: QueryClient,
  view: DashboardLensName,
  account?: AccountCode,
) {
  try {
    const data = await loadDashboardLens(view, account);
    queryClient.setQueryData(dashboardLensLatestKey(view, account), data);
    queryClient.setQueryData(
      dashboardLensSnapshotKey(data.runId, view, account),
      data,
    );
    return data;
  } catch {
    // The client query owns the visible error and retry state. A server-side
    // prefetch miss must not replace the page with a route-level failure.
    return null;
  }
}
