import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

/** The newest valuation version saved by the end of a decision's day. */
export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  const day = new URL(request.url).searchParams.get("day") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return privateJsonResponse({ detail: "day must be YYYY-MM-DD" }, { status: 422 });
  }
  return proxyToBackend(
    `/v1/research/${encodeURIComponent(ticker)}/models/as-of?day=${day}`,
    { signal: request.signal },
  );
}
