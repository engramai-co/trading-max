import { backendUrl } from "@/lib/backend";
import { proxyToBackend } from "@/lib/backend-proxy";
import { webBuildHeader, webBuildId } from "@/lib/web-build";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const response = backendUrl()
    ? await proxyToBackend("/health", { signal: request.signal })
    : Response.json({ status: "local-fallback", service: "trading-max-web" });
  response.headers.set("Cache-Control", "private, no-store");
  if (webBuildId) response.headers.set(webBuildHeader, webBuildId);
  return response;
}
