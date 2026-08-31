import { privateJsonResponse } from "@/lib/backend-proxy";
import { loadHealthDetails } from "@/lib/health-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return privateJsonResponse(request, await loadHealthDetails(), { status: 200 });
}
