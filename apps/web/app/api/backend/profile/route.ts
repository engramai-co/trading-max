import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export async function GET() {
  return proxyToBackend("/v1/profile");
}

export async function PATCH(request: Request) {
  return proxyJsonRequest("/v1/profile", request, "PATCH");
}
