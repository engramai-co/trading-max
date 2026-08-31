import type { AccountCode, DashboardLensName } from "@/lib/types";

export function dashboardLensLatestKey(
  view: DashboardLensName,
  account?: AccountCode,
) {
  return ["dashboard-lens", "latest", view, account ?? null] as const;
}

export function dashboardLensSnapshotKey(
  runId: string,
  view: DashboardLensName,
  account?: AccountCode,
) {
  return ["dashboard-lens", "snapshot", runId, view, account ?? null] as const;
}
