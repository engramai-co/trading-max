import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{runId: string}> }) {
  const {runId} = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) return privateJsonResponse({detail:"Invalid publication"}, {status:400});
  return proxyToBackend(`/v1/snapshots/${runId}/events/upcoming${new URL(request.url).search}`, {signal:request.signal});
}
