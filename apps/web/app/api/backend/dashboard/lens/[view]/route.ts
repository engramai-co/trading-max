import { NextResponse } from "next/server";

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
  const account = new URL(request.url).searchParams.get("account");
  if (account && !new Set(["A", "B", "C"]).has(account)) {
    return NextResponse.json({ detail: "unknown account" }, { status: 400 });
  }
  const query = account ? `?account=${encodeURIComponent(account)}` : "";
  return proxyToBackend(
    `/v1/dashboard/lens/${view}${query}`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
