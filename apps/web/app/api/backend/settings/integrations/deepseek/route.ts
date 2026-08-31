import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export async function PUT(request: Request) {
  return proxyJsonRequest("/v1/settings/integrations/deepseek", request, "PUT");
}

export async function DELETE() {
  return proxyToBackend("/v1/settings/integrations/deepseek", {
    method: "DELETE",
  });
}
