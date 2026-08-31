import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export async function GET() {
  return proxyToBackend("/v1/settings/automation");
}

export async function PUT(request: Request) {
  return proxyJsonRequest("/v1/settings/automation", request, "PUT");
}
