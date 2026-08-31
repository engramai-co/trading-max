import { NextResponse } from "next/server";

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
  const requested = Number(new URL(request.url).searchParams.get("limit") ?? 30);
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    return NextResponse.json(
      { detail: "limit must be an integer between 1 and 100" },
      { status: 400 },
    );
  }
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/lens/${view}?limit=${requested}`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
