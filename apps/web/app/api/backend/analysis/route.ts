import { NextResponse } from "next/server";

import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();
  const lens = incoming.searchParams.get("lens");
  const ticker = incoming.searchParams.get("ticker");
  if (!lens) {
    return NextResponse.json({ detail: "lens is required" }, { status: 400 });
  }
  query.set("lens", lens);
  if (ticker) query.set("ticker", ticker);
  return proxyToBackend(`/v1/analysis/latest?${query}`);
}

export async function POST(request: Request) {
  return proxyJsonRequest("/v1/analysis/runs", request, "POST");
}
