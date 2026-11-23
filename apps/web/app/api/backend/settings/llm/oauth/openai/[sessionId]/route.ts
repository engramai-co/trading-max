import { proxyDeleteRequest, proxyToBackend } from "@/lib/backend-proxy";

type Context = { params: Promise<{ sessionId: string }> };
export async function GET(_request: Request, context: Context) {
  const { sessionId } = await context.params;
  return proxyToBackend(`/v1/settings/llm/oauth/openai/${encodeURIComponent(sessionId)}`);
}
export async function DELETE(request: Request, context: Context) {
  const { sessionId } = await context.params;
  return proxyDeleteRequest(`/v1/settings/llm/oauth/openai/${encodeURIComponent(sessionId)}`, request);
}
