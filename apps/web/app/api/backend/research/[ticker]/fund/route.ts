import { proxyToBackend } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  const params = new URL(request.url).searchParams;
  const upstream = new URLSearchParams();
  if (params.get("runId")) upstream.set("run_id", params.get("runId")!);
  if (params.get("detail")) upstream.set("detail", params.get("detail")!);
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/fund?${upstream}`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
