import { proxyJsonRequest } from "@/lib/backend-proxy";
export const dynamic = "force-dynamic";
export async function PUT(
  request: Request,
  context: { params: Promise<{ ticker: string; noteId: string }> },
) {
  const { ticker, noteId } = await context.params;
  return proxyJsonRequest(
    `/v1/research/${encodeURIComponent(ticker)}/journal/${encodeURIComponent(noteId)}`,
    request,
    "PUT",
  );
}
