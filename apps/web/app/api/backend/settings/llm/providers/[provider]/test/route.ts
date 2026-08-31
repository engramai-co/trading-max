import { proxyJsonRequest } from "@/lib/backend-proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  return proxyJsonRequest(
    `/v1/settings/llm/providers/${encodeURIComponent(provider)}/test`,
    request,
    "POST",
  );
}
