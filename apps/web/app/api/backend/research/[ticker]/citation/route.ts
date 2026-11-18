import { proxyToBackend } from "@/lib/backend-proxy";

export async function GET(request: Request, context: {params: Promise<{ticker: string}>}) {
  const {ticker} = await context.params;
  return proxyToBackend("/v1/research/" + encodeURIComponent(ticker) + "/citation" + new URL(request.url).search,
    {signal:request.signal});
}
