import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) {
    return Response.json({ query, source: "watchlist", results: [] });
  }
  const params = new URLSearchParams({ q: query, limit: "8" });
  return proxyToBackend(`/v1/securities/search?${params.toString()}`);
}
