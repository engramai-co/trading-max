import { NextResponse } from "next/server";

import { dashboardLensLatestKey, dashboardLensSnapshotKey, type DashboardSelection } from "@/lib/dashboard-query";
import { rememberDesktopSnapshotResponse } from "@/lib/snapshot-cache-server";
import type { AccountCode, DashboardLensName } from "@/lib/types";
import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

const views = new Set([
  "overview",
  "holdings-positions",
  "holdings-lookthrough",
  "analytics",
  "review",
  "account-analysis",
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ view: string }> },
) {
  const { view } = await context.params;
  if (!views.has(view)) {
    return NextResponse.json({ detail: "unknown dashboard lens" }, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const account = params.get("account");
  if (account && !new Set(["A", "B", "C"]).has(account)) {
    return NextResponse.json({ detail: "unknown account" }, { status: 400 });
  }
  const forwarded = new URLSearchParams();
  if (account) forwarded.set("account", account);
  const allowed: Record<string, Set<string>> = {
    range: new Set(["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"]),
    scope: new Set(["invest", "isa", "total", "household", "cfd"]),
    detail: new Set(["full", "summary"]),
  };
  for (const [key, values] of Object.entries(allowed)) {
    const value = params.get(key);
    if (value && !values.has(value)) return NextResponse.json({ detail: `unknown ${key}` }, { status: 400 });
    if (value) forwarded.set(key, value);
  }
  const selection = Object.fromEntries([...forwarded].filter(([key]) => key !== "account")) as DashboardSelection;
  const runId = params.get("runId");
  if (runId !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) {
    return NextResponse.json({detail:"invalid snapshot"}, {status:400});
  }
  if (runId) forwarded.set("run_id", runId);
  const keyArgs = [view as DashboardLensName, (account || undefined) as AccountCode | undefined,
    Object.keys(selection).length ? selection : undefined] as const;
  const key = runId ? dashboardLensSnapshotKey(runId, ...keyArgs) : dashboardLensLatestKey(...keyArgs);
  const query = forwarded.size ? `?${forwarded}` : "";
  return proxyToBackend(
    `/v1/dashboard/lens/${view}${query}`,
    { signal: request.signal },
    (response) => rememberDesktopSnapshotResponse(key, response),
  );
}
