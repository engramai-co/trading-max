import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export async function GET() {
  return proxyToBackend("/v1/settings/assistant");
}

export async function PUT(request: Request) {
  return proxyJsonRequest("/v1/settings/assistant", request, "PUT");
}
