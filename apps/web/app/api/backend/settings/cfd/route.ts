import { proxyJsonRequest } from "@/lib/backend-proxy";

export async function PUT(request: Request) {
  return proxyJsonRequest("/v1/settings/cfd", request, "PUT");
}
