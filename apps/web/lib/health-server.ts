import "server-only";

import { backendFetch, backendUrl } from "@/lib/backend";
import type {
  HealthDetails,
  HealthProbeError,
  HealthResponse,
  JobListResponse,
  ReadinessResponse,
  RefreshState,
} from "@/lib/types";

type Probe<T> =
  | { ok: true; data: T }
  | { ok: false; error: HealthProbeError };

function errorDetail(scope: HealthProbeError["scope"], status: number | null) {
  const label = scope === "backend" ? "backend" : `${scope} probe`;
  return status === null ? `${label} unavailable` : `${label} returned HTTP ${status}`;
}

async function probe<T>(
  scope: Exclude<HealthProbeError["scope"], "backend">,
  pathname: string,
): Promise<Probe<T>> {
  try {
    const response = await backendFetch(pathname);
    const text = await response.text();
    if (!response.ok) {
      let detail = errorDetail(scope, response.status);
      try {
        const payload = JSON.parse(text) as { detail?: unknown };
        if (typeof payload.detail === "string" && payload.detail.length <= 240) {
          detail = payload.detail;
        }
      } catch {
        // Preserve the bounded endpoint-level error instead of exposing a raw body.
      }
      return { ok: false, error: { scope, status: response.status, detail } };
    }
    if (!text) {
      return {
        ok: false,
        error: { scope, status: response.status, detail: `${scope} returned an empty response` },
      };
    }
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      error: { scope, status: null, detail: errorDetail(scope, null) },
    };
  }
}

function unavailableDetails(checkedAt: string): HealthDetails {
  return {
    checkedAt,
    health: null,
    readiness: null,
    refresh: null,
    jobs: [],
    errors: [{ scope: "backend", status: null, detail: "Portfolio backend is not configured" }],
  };
}

export async function loadHealthDetails(): Promise<HealthDetails> {
  const checkedAt = new Date().toISOString();
  if (!backendUrl()) return unavailableDetails(checkedAt);

  const [health, readiness, refresh, jobs] = await Promise.all([
    probe<HealthResponse>("health", "/health"),
    probe<ReadinessResponse>("readiness", "/ready"),
    probe<RefreshState>("refresh", "/v1/refresh-state"),
    probe<JobListResponse>("jobs", "/v1/jobs?limit=12"),
  ]);
  const errors = [health, readiness, refresh, jobs]
    .filter((result): result is { ok: false; error: HealthProbeError } => !result.ok)
    .map((result) => result.error);
  const jobPayload = jobs.ok ? jobs.data.jobs : [];
  return {
    checkedAt,
    health: health.ok ? health.data : null,
    readiness: readiness.ok ? readiness.data : null,
    refresh: refresh.ok ? refresh.data : null,
    jobs: Array.isArray(jobPayload) ? jobPayload : [],
    errors,
  };
}
