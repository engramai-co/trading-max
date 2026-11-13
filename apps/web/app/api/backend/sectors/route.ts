import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";
import type { SectorMarketCode } from "@/lib/types";

export const dynamic = "force-dynamic";

const MARKETS: ReadonlySet<string> = new Set<SectorMarketCode>(["us", "eu", "uk", "hk", "kr", "jp"]);

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
