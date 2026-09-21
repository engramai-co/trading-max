// Pi owns model transport. Trading Max owns prompts, credentials and validation.
import { contentText, createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";

const providers = {
  deepseek: deepseekProvider(),
  opencode: opencodeGoProvider(),
  openai: openaiProvider(),
  "openai-codex": openaiCodexProvider(),
  anthropic: anthropicProvider(),
  google: googleProvider(),
};
const models = createModels({
  authContext: { env: async () => undefined, fileExists: async () => false },
});
for (const provider of Object.values(providers)) models.setProvider(provider);

function errorCode(status) {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 400 && status < 500) return "provider_model_rejected";
  return "provider_unavailable";
}

export async function complete(request, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const provider = providers[request.provider];
  if (!provider || !request.apiKey?.trim()) return { error: "provider_not_configured" };
  let status;
  const originalFetch = globalThis.fetch;
  const guardedFetch = async (input, init) => {
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    status = response.status;
    return response;
  };
  try {
    const url = new URL(request.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return { error: "provider_model_rejected" };
    }
    // Keep saved model IDs even when Pi's live catalog has renamed an alias.
    const template = models.getModel(provider.id, request.model)
      ?? (["deepseek", "opencode"].includes(request.provider)
        ? provider.getModels().find((model) => model.api === "openai-completions") : undefined);
    if (!template) return { error: "provider_model_rejected" };
    const model = { ...template, id: request.model, name: request.model, baseUrl: request.baseUrl };
    const signal = AbortSignal.timeout(request.timeoutMs ?? 180_000);
    // Google's SDK uses global fetch. Each bridge process handles exactly one
    // request, so the same no-redirect boundary can be scoped to that call.
    if (request.provider === "google") globalThis.fetch = guardedFetch;
    const options = {
      apiKey: request.apiKey,
      signal,
      timeoutMs: request.timeoutMs ?? 180_000,
      maxRetries: request.maxRetries ?? 2,
      maxRetryDelayMs: 10_000,
      maxTokens: request.maxTokens ?? 12_000,
      temperature: request.temperature ?? 0.1,
      toolChoice: request.toolChoice ?? undefined,
      cacheRetention: "none",
      transport: "sse",
      // Preserve the existing no-redirect credential boundary and inject fixtures in tests.
      fetch: guardedFetch,
      onPayload: (payload) => {
        if (model.api === "openai-responses") {
          payload.store = false;
          if (request.schema) payload.text = { format: {
            type: "json_schema", name: "trading_max_synthesis", strict: true, schema: request.schema,
          } };
        } else if (model.api === "openai-completions" && request.json) {
          payload.response_format = { type: "json_object" };
        } else if (model.api === "google-generative-ai" && request.json) {
          // Tool execution and JSON response mode cannot be combined on Gemini.
          delete payload.config.tools;
          delete payload.config.toolConfig;
          payload.config.responseMimeType = "application/json";
        }
      },
    };
    // OAuth was resolved by Pi under the host's cross-process keychain lock.
    // Dispatch through the provider so Models does not try a second credential lookup.
    const message = request.provider === "openai-codex"
      ? await provider.streamSimple(model, request.context, options).result()
      : await models.completeSimple(model, request.context, options);
    if (signal.aborted || ["error", "aborted"].includes(message.stopReason)) {
      return { error: errorCode(status) };
    }
    if (!["stop", "toolUse"].includes(message.stopReason)) {
      return { error: "provider_invalid_output" };
    }
    if (message.stopReason === "toolUse" && (
      !request.context.tools?.length || request.toolChoice === "none"
    )) return { error: "provider_invalid_output" };
    return { message, text: contentText(message.content), usage: message.usage };
  } catch {
    // Upstream errors can contain keys, URLs or user context. Never print them.
    return { error: errorCode(status) };
  } finally {
    if (request.provider === "google") globalThis.fetch = originalFetch;
  }
}
