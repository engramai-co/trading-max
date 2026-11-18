import { proxyJsonRequest } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

/** Records the evidence the reader has opened; it saves no valuation version. */
export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyJsonRequest(
    `/v1/valuation/evidence-notices/${encodeURIComponent(ticker)}/seen`,
    request,
    "POST",
  );
}
