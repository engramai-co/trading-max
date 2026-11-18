import { proxyAssistantStream } from "@/lib/assistant-proxy";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await context.params;
  return proxyAssistantStream(request, `/v1/research/${encodeURIComponent(ticker)}/valuation-draft`, "application/x-ndjson");
}
