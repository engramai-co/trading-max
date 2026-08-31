import { proxyToBackend } from "@/lib/backend-proxy";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return proxyToBackend(`/v1/analysis/runs/${encodeURIComponent(runId)}`);
}
