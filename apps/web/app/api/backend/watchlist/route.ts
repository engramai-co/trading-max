import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyToBackend("/v1/watchlist");
}

export async function POST(request: Request) {
  return proxyJsonRequest("/v1/watchlist", request, "POST");
}
