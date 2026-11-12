import { privateJsonResponse, proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const overview = path.length === 1 && (path[0] === "catalog" || path[0] === "global-contribution");
  const detail = path.length === 2 && /^[a-z0-9-]{1,60}$/.test(path[0])
    && (path[1] === "history" || path[1] === "context");
  if ((path.length && !overview && !detail) || process.env.TRADING_MAX_ENV === "desktop-preview") {
    return privateJsonResponse(request, { detail: "Indices unavailable" }, { status: 404 });
  }
  const input = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of path.length === 0 ? ["scope"] : path[1] === "history" ? ["range", "currency"] : []) {
    const value = input.get(key);
    if (value != null) query.set(key, value);
  }
  const tail = path.length ? "/" + path.join("/") : "";
  return proxyToBackend(
    "/v1/indices" + tail + (query.size ? "?" + query.toString() : ""),
    { signal: request.signal },
    request.headers.get("accept-encoding"),
  );
}
