import { proxyToBackend } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/fund`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
