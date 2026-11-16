import { privateJsonResponse } from "@/lib/backend-proxy";
import { loadHealthDetails } from "@/lib/health-server";

import { webBuildId } from "@/lib/web-build";

export const dynamic = "force-dynamic";

export async function GET() {
  return privateJsonResponse({ ...await loadHealthDetails(), buildId: webBuildId || undefined }, { status: 200 });
}
