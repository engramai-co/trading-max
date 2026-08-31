import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyToBackend(
    "/v1/research/shell",
    undefined,
    request.headers.get("accept-encoding"),
  );
}
