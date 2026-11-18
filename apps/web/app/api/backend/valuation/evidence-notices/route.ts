import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

/** Local notices of new evidence for saved valuation versions; off unless chosen in Settings. */
export async function GET(request: Request) {
  return proxyToBackend("/v1/valuation/evidence-notices", { signal: request.signal });
}
