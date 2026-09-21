// Pi owns OAuth endpoints, device polling and refresh. Credentials only cross
// the private parent/child pipe; the Python host stores them in the OS keychain.
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export async function oauth(request, notify = () => {}, {
  signal = AbortSignal.timeout(request.operation === "login" ? 900_000 : 25_000),
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => fetchImpl(input, { ...init, redirect: "error" });
  try {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider(openaiCodexProvider());
    if (request.operation === "login") {
      const credential = await models.login("openai-codex", "oauth", {
        signal,
        prompt: async (prompt) => {
          if (prompt.type === "select" && prompt.options.some((o) => o.id === "device_code")) {
            return "device_code";
          }
          throw new Error("Unsupported OAuth interaction");
        },
        notify: (event) => {
          if (event.type === "device_code") notify({
            type: "device_code", userCode: event.userCode,
            verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds,
          });
        },
      });
      return { credential };
    }
    if (request.operation !== "resolve" || request.credential?.type !== "oauth") {
      return { error: "provider_not_configured" };
    }
    await credentials.modify("openai-codex", async () => request.credential);
    const result = await models.getAuth("openai-codex", { signal });
    if (!result?.auth?.apiKey) return { error: "provider_auth_failed" };
    return { auth: result.auth, credential: await credentials.read("openai-codex") };
  } catch {
    return { error: signal.aborted ? "oauth_expired" : "provider_auth_failed" };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
