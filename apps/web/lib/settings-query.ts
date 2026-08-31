import type {
  AutomationSettings,
  CfdImportStatus,
  IntegrationOverview,
} from "@/lib/types";

export type SettingsBundle = {
  automation: AutomationSettings | null;
  cfdStatus: CfdImportStatus | null;
  integrations: IntegrationOverview;
  partial: boolean;
};

export const settingsBundleQueryKey = ["settings-integrations"] as const;
