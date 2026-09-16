import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/journal`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyJsonRequest(
    `/v1/research/${encodeURIComponent(ticker)}/journal`,
    request,
    "POST",
  );
}
