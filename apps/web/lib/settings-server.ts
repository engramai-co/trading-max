import "server-only";

import { backendFetch } from "@/lib/backend";
import type { SettingsBundle } from "@/lib/settings-query";
import type {
  AutomationSettings,
  CfdImportStatus,
  IntegrationOverview,
} from "@/lib/types";

async function loadBackendJson<T>(pathname: string): Promise<T> {
  const response = await backendFetch(pathname);
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return (await response.json()) as T;
}

export async function loadSettingsBundle(): Promise<SettingsBundle> {
  const [integrations, cfdStatus, automation] = await Promise.allSettled([
    loadBackendJson<IntegrationOverview>("/v1/settings/integrations"),
    loadBackendJson<CfdImportStatus>("/v1/imports/trading212/cfd"),
    loadBackendJson<AutomationSettings>("/v1/settings/automation"),
  ]);
  if (integrations.status === "rejected") throw integrations.reason;
  return {
    integrations: integrations.value,
    cfdStatus: cfdStatus.status === "fulfilled" ? cfdStatus.value : null,
    automation: automation.status === "fulfilled" ? automation.value : null,
    partial: cfdStatus.status === "rejected" || automation.status === "rejected",
  };
}
