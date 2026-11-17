import { describe, expect, it } from "vitest";
import type { AssistantSettings } from "@/lib/types";
import { connectedAssistantModels } from "./assistant-settings";

const settings: AssistantSettings = {
  enabled: false, acceptedConsentRevision: null, acceptedAt: null, consentRevision: 2, revision: 1, updatedAt: "",
  route: "openai/legacy", reasoning: null, shareValuationAssumptions: true, backgroundBriefsEnabled: true,
  providers: [
    { provider: "openai", label: "OpenAI", models: ["current"], defaultModel: "current", freeformModels: false, local: false, authMethod: "api_key", baseUrl: "" },
    { provider: "ollama", label: "Ollama", models: [], defaultModel: null, freeformModels: true, local: true, authMethod: "optional_api_key", baseUrl: "" },
  ],
  integrations: [
    { provider: "openai", integrationId: "openai:default", revision: 1, lastTestStatus: "succeeded", configured: true, enabled: true, model: "current", needsSecret: false, updatedAt: "" },
    { provider: "ollama", integrationId: "ollama:default", revision: 1, configured: true, enabled: true, model: "local/model", needsSecret: false, lastTestStatus: "succeeded", updatedAt: "" },
  ],
};

describe("connected assistant models", () => {
  it("keeps a saved legacy model and preserves free-form model IDs with slashes", () => {
    expect(connectedAssistantModels(settings).map((option) => option.value)).toEqual(["openai/current", "openai/legacy", "ollama/local/model"]);
  });
  it("omits disconnected, disabled, missing-key and untested free-form connections", () => {
    for (const override of [{ enabled: false }, { configured: false }, { needsSecret: true }]) {
      expect(connectedAssistantModels({ ...settings, integrations: settings.integrations.map((item) => ({ ...item, ...override })) })).toEqual([]);
    }
    expect(connectedAssistantModels({ ...settings, integrations: [{ ...settings.integrations[1], lastTestStatus: "failed" }] })).toEqual([]);
  });
});
