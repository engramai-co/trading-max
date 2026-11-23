import { proxyDeleteRequest, proxyToBackend } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return proxyToBackend(
    "/v1/assistant/conversations",
    { signal: request.signal },
  );
}

export async function DELETE(request: Request) {
  return proxyDeleteRequest("/v1/assistant/conversations", request);
}
