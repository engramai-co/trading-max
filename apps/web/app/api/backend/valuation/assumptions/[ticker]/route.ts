import { proxyJsonRequest } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyJsonRequest(
    `/v1/valuation/assumptions/${encodeURIComponent(ticker)}`,
    request,
    "PUT",
  );
}
