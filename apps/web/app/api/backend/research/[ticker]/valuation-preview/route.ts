import { proxyJsonRequest, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

function version(request: Request) {
  return request.headers.get("x-valuation-contract") === "2" ? "v2" : "v1";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyToBackend(
    `/${version(request)}/research/${encodeURIComponent(ticker)}/valuation-preview${new URL(request.url).search}`,
    { signal: request.signal },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  return proxyJsonRequest(
    `/${version(request)}/research/${encodeURIComponent(ticker)}/valuation-preview`,
    request,
    "POST",
  );
}
