import { privateJsonResponse } from "@/lib/backend-proxy";
import { probeHealthOutcomes } from "@/lib/health-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const result = await probeHealthOutcomes(request.signal);
  if (result.ok) return privateJsonResponse(result.data);
  const status = result.error.status;
  return privateJsonResponse({ detail: "Update outcomes unavailable" }, {
    status: status !== null && status >= 400 && status < 600 ? status : 503,
  });
}
