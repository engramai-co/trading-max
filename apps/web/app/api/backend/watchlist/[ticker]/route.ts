import { JSON_MEDIA_TYPES, proxyToBackend, validateWriteRequest } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

const actions = new Set(["move", "remove", "refresh"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const rejected = validateWriteRequest(request, { allowedMediaTypes: JSON_MEDIA_TYPES });
  if (rejected) return rejected;
  const { ticker } = await context.params;
  const payload: unknown = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ detail: "A JSON object is required" }, { status: 400 });
  }
  const { action = "refresh", categoryId } = payload as Record<string, unknown>;
  if (typeof action !== "string" || !actions.has(action)) {
    return Response.json({ detail: "Unsupported watchlist action" }, { status: 400 });
  }
  return proxyToBackend(
    `/v1/watchlist/${encodeURIComponent(ticker)}/${action}`,
    {
      method: "POST",
      body:
        action === "move"
          ? JSON.stringify({ categoryId })
          : undefined,
      headers:
        action === "move"
          ? { "Content-Type": "application/json" }
          : undefined,
    },
  );
}
