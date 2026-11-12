import { researchShellKey } from "@/lib/dashboard-query";
import { rememberDesktopSnapshotResponse } from "@/lib/snapshot-cache-server";
import { proxyToBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyToBackend(
    "/v1/research/shell",
    { signal: request.signal },
    request.headers.get("accept-encoding"),
    (response) => rememberDesktopSnapshotResponse(researchShellKey, response),
  );
}
