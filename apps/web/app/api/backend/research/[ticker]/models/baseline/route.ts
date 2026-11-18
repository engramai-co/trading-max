import { proxyJsonRequest } from "@/lib/backend-proxy";

export async function PUT(request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await context.params;
  return proxyJsonRequest(`/v1/research/${encodeURIComponent(ticker)}/models/baseline`, request, "PUT");
}
