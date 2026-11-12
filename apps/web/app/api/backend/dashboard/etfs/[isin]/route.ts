import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ isin: string }> }) {
  const { isin } = await context.params;
  const runId = new URL(request.url).searchParams.get("runId") ?? "";
  return proxyToBackend(
    `/v1/dashboard/etfs/${encodeURIComponent(isin)}?run_id=${encodeURIComponent(runId)}`,
    undefined,
    request.headers.get("accept-encoding"),
  );
}
