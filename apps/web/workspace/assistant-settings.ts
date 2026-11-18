import type { AssistantSettings } from "@/lib/types";

export const ASSISTANT_NAME = "MaxAI";
export const assistantSettingsChange = "trading_max-assistant-settings-revision";
export const assistantSettingsKey = ["workspace-assistant-settings"] as const;
// This UI can only grant consent to the disclosure it actually displays.
export const DISCLOSURE_REVISION = 2;

export function connectedAssistantModels(settings: AssistantSettings) {
  return settings.providers.flatMap((provider) => {
    const connection = settings.integrations.find((item) => item.provider === provider.provider);
    if (!connection?.configured || !connection.enabled || connection.needsSecret) return [];
    if (provider.freeformModels && connection.lastTestStatus !== "succeeded") return [];

    const models = new Set(provider.freeformModels ? [] : provider.models);
    if (connection.model) models.add(connection.model);
    // A saved curated route can predate today's picker.
    const prefix = provider.provider + "/";
    if (!provider.freeformModels && settings.route?.startsWith(prefix)) models.add(settings.route.slice(prefix.length));
    return [...models].map((model) => ({
      value: prefix + model,
      label: provider.label + " · " + model,
      provider: provider.provider,
      recipient: provider.label,
      destination: provider.local ? (connection.baseUrl ?? provider.baseUrl) : provider.baseUrl,
      local: provider.local,
      model,
    }));
  });
}
