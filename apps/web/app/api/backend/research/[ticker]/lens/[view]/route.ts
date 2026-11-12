import { NextResponse } from "next/server";

import { researchLensKey } from "@/lib/dashboard-query";
import { rememberDesktopSnapshotResponse } from "@/lib/snapshot-cache-server";
import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

const views = new Set([
  "overview",
  "technical",
  "valuation",
  "fundamentals",
  "analyst",
  "options",
  "ledger",
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string; view: string }> },
) {
  const { ticker, view } = await context.params;
  if (!views.has(view)) {
    return NextResponse.json({ detail: "unknown research lens" }, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const requested = Number(params.get("limit") ?? 30);
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    return NextResponse.json(
      { detail: "limit must be an integer between 1 and 100" },
      { status: 400 },
    );
  }
  const detail = params.get("detail") ?? "full";
  const revision = params.get("revision");
  if (!["full", "summary", "seasonality", "documents"].includes(detail))
    return NextResponse.json({ detail: "Unsupported detail" }, { status: 400 });
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/lens/${view}?limit=${requested}&detail=${detail}`,
    { signal: request.signal },
    request.headers.get("accept-encoding"),
    requested === 30 ? (response) => rememberDesktopSnapshotResponse(researchLensKey(ticker, view, detail, revision), response) : undefined,
  );
}
