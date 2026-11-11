import { proxyToBackend } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
/** The dated analyst-estimate archive for one listing, oldest first. */
export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  const limit = new URL(request.url).searchParams.get("limit");
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/estimate-history` +
      (limit && /^\d{1,4}$/.test(limit) ? `?limit=${limit}` : ""),
    undefined,
    request.headers.get("accept-encoding"),
  );
}
