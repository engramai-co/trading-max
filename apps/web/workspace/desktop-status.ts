import { deriveHealthDecision } from "@/lib/health";
import type { HealthDetails } from "@/lib/types";

export function activityState(details: HealthDetails | null, localWorkspace = false) {
  const { failures, queued, running, tone } = deriveHealthDecision(details, { localWorkspace });
  return { failures, running: queued > 0 || running > 0, tone };
}
