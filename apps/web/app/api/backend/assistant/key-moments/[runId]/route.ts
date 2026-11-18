import { proxyToBackend } from "@/lib/backend-proxy";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) return Response.json({ detail: "Invalid snapshot" }, { status: 400 });
  const search = new URL(request.url).searchParams;
  return proxyToBackend(`/v1/snapshots/${runId}/insights/key-moments?${search}`, { signal: request.signal });
}
