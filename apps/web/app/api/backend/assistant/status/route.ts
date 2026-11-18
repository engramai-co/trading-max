import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return proxyToBackend("/v1/assistant/status", { signal: request.signal });
}
