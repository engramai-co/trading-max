import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

const MARKETS = new Set(["us", "uk", "hk", "kr", "jp"]);

export async function GET(request: Request) {
  const market = new URL(request.url).searchParams.get("market");
  if (market != null && !MARKETS.has(market)) {
    return privateJsonResponse(request, { detail: "Unknown market" }, { status: 400 });
  }
  return proxyToBackend(
    "/v1/sectors" + (market ? "?market=" + market : ""),
    undefined,
    request.headers.get("accept-encoding"),
  );
}
