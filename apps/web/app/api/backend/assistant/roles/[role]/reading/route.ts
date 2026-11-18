import { proxyAssistantChat } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ role: string }> }) {
  const { role } = await context.params;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(role)) return new Response(null, { status: 404 });
  return proxyAssistantChat(request, "/v1/assistant/roles/" + role + "/reading");
}
