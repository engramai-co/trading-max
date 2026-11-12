import { privateJsonResponse } from "@/lib/backend-proxy";
import { loadHealthDetails } from "@/lib/health-server";

import { webBuildId } from "@/lib/web-build";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return privateJsonResponse(request, { ...await loadHealthDetails(), buildId: webBuildId || undefined }, { status: 200 });
}
