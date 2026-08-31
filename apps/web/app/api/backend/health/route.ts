import { backendUrl } from "@/lib/backend";
import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!backendUrl()) {
    return Response.json(
      {
        status: "local-fallback",
        service: "trading-max-web",
      },
      { status: 200 },
    );
  }
  return proxyToBackend("/health");
}
