import { proxyDeleteRequest, proxyJsonRequest } from "@/lib/backend-proxy";

export async function PUT(request: Request) {
  return proxyJsonRequest("/v1/settings/integrations/deepseek", request, "PUT");
}

export async function DELETE(request: Request) {
  return proxyDeleteRequest("/v1/settings/integrations/deepseek", request);
}
