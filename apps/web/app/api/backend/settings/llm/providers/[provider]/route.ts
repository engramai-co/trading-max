import { proxyDeleteRequest, proxyJsonRequest } from "@/lib/backend-proxy";

export async function PUT(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  return proxyJsonRequest(
    `/v1/settings/llm/providers/${encodeURIComponent(provider)}`,
    request,
    "PUT",
  );
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  return proxyDeleteRequest(
    `/v1/settings/llm/providers/${encodeURIComponent(provider)}`,
    request,
  );
}
