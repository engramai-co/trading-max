import { proxyJsonRequest } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyJsonRequest(
    `/v1/research/${encodeURIComponent(ticker)}/models`,
    request,
    "POST",
  );
}
