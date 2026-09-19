import type { AccountCode, DashboardLensName } from "@/lib/types";

export type DashboardSelection = { range?: string; scope?: string; detail?: "summary" | "full" };

export function dashboardLensLatestKey(
  view: DashboardLensName,
  account?: AccountCode,
  selection?: DashboardSelection,
) {
  return ["dashboard-lens", "latest", view, account ?? null, selection ?? null] as const;
}

export function dashboardLensSnapshotKey(
  runId: string,
  view: DashboardLensName,
  account?: AccountCode,
  selection?: DashboardSelection,
) {
  return ["dashboard-lens", "snapshot", runId, view, account ?? null, selection ?? null] as const;
}
