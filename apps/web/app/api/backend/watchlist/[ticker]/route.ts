import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await context.params;
  const payload = (await request.json()) as {
    action?: "move" | "remove" | "refresh";
    categoryId?: string;
  };
  const action = payload.action ?? "refresh";
  return proxyToBackend(
    `/v1/watchlist/${encodeURIComponent(ticker)}/${action}`,
    {
      method: "POST",
      body:
        action === "move"
          ? JSON.stringify({ categoryId: payload.categoryId })
          : undefined,
      headers:
        action === "move"
          ? { "Content-Type": "application/json" }
          : undefined,
    },
  );
}
