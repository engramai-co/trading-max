import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyToBackend("/v1/valuation/assumptions/history?limit=100");
}
