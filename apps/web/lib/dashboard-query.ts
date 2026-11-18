import type { HistorySelection } from "@/lib/portfolio/prepared";
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

export function portfolioHistoryKey(selection: HistorySelection, openings: readonly string[]) {
  return openings.length ? ["portfolio-history", selection, openings] as const : ["portfolio-history", selection] as const;
}

export const researchShellKey = ["workspace-research-shell"] as const;
export function researchLensKey(ticker: string, view: string, detail: string, revision?: string | null) {
  return ["workspace-research", ticker, view, detail, revision || null] as const;
}
