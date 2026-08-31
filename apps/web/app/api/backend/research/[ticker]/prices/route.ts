import { NextResponse } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  const requested = Number(new URL(request.url).searchParams.get("limit") ?? 504);
  if (!Number.isInteger(requested) || requested < 2 || requested > 2_000) {
    return NextResponse.json(
      { detail: "limit must be an integer between 2 and 2000" },
      { status: 400 },
    );
  }
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/prices?limit=${requested}`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
