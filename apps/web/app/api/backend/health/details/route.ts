import { privateJsonResponse } from "@/lib/backend-proxy";
import { loadHealthDetails } from "@/lib/health-server";

import { webBuildId } from "@/lib/web-build";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const details = await loadHealthDetails({
    signal: request.signal,
    includeOutcomes: request.headers.get("x-health-outcomes") !== "omit",
  });
  return privateJsonResponse({ ...details, buildId: webBuildId || undefined }, { status: 200 });
}
