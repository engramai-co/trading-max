import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: {params: Promise<{runId: string; recordId: string}>}) {
  const {runId, recordId} = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || !/^ev_[0-9a-f]{16}$/.test(recordId)) {
    return privateJsonResponse({detail:"Invalid publication or event"}, {status:400});
  }
  const ticker = new URL(request.url).searchParams.get("ticker") ?? "";
  return proxyToBackend(`/v1/snapshots/${runId}/events/recorded/${recordId}?ticker=${encodeURIComponent(ticker)}`, {signal:request.signal});
}
