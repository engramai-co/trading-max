import { proxyToBackend } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ conversationId: string }> };
export async function GET(request: Request, context: Context) {
  const { conversationId } = await context.params;
  return proxyToBackend(
    `/v1/assistant/conversations/${encodeURIComponent(conversationId)}`,
    { signal: request.signal },
  );
}
export async function DELETE(_request: Request, context: Context) {
  const { conversationId } = await context.params;
  return proxyToBackend(
    `/v1/assistant/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE" },
  );
}
