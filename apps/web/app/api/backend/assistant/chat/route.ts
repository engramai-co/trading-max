import { proxyAssistantChat } from "@/lib/assistant-proxy";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return proxyAssistantChat(request);
}
