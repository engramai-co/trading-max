import { proxyJsonRequest } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

// A pure comparison: it neither saves a model nor contacts MaxAI.
export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyJsonRequest(
    `/v2/research/${encodeURIComponent(ticker)}/valuation-maintenance`,
    request,
    "POST",
  );
}
