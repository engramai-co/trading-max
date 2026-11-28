import { backendFetch } from "@/lib/backend";
import { privateJsonResponse } from "@/lib/backend-proxy";
import type { RefreshJob } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("job");
  const missing = () => privateJsonResponse({ detail: "Update task not found" }, { status: 404 });
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return missing();
  try {
    const response = await backendFetch(`/v1/job-history/${id}`, {
      signal: request.signal,
      redirect: "error",
    });
    if (response.status === 404) {
      // Older backends return a generic 404 for this endpoint. Only a history
      // lookup result can identify a missing or private task.
      const payload = await response.json() as { detail?: { code?: string } };
      if (payload?.detail?.code === "job_history_not_found") return missing();
    } else if (response.ok) {
      const job = await response.json() as RefreshJob;
      if (job?.jobId === id && Array.isArray(job.stages)) return privateJsonResponse(job);
    }
  } catch {
    // Use a bounded local message. Backend failures may include infrastructure details.
  }
  return privateJsonResponse({ detail: "Update task unavailable" }, { status: 503 });
}
