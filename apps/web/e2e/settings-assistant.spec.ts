import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { AssistantSettings, AssistantUpdate } from "../lib/types";
import { ASSISTANT_NAME, DISCLOSURE_REVISION } from "../workspace/assistant-settings";

async function open(page: Page, locale: "en" | "zh" = "en", connected = true) {
  const writes: AssistantUpdate[] = [];
  const tools: string[] = [];
  let erasures = 0;
  let settings: AssistantSettings = {
    enabled: false, route: null, acceptedConsentRevision: null, acceptedAt: null, reasoning: null,
    backgroundBriefsEnabled: true, shareValuationAssumptions: true, consentRevision: DISCLOSURE_REVISION,
    revision: 1, updatedAt: "2026-01-01T00:00:00Z",
    providers: [
      { provider: "openai", label: "OpenAI", baseUrl: "", models: ["model-a"], defaultModel: "model-a", freeformModels: false, local: false, authMethod: "api_key" },
      { provider: "ollama", label: "Ollama", baseUrl: "", models: [], defaultModel: null, freeformModels: true, local: true, authMethod: "optional_api_key" },
    ],
    integrations: connected ? [
      { provider: "openai", integrationId: "openai:default", revision: 1, lastTestStatus: "succeeded", configured: true, enabled: true, needsSecret: false, updatedAt: "" },
      { provider: "ollama", integrationId: "ollama:default", revision: 1, configured: true, enabled: true, needsSecret: false, lastTestStatus: "succeeded", model: "local/model", updatedAt: "" },
    ] : [],
  };
  await page.addInitScript((language) => localStorage.setItem("trading_max-locale", language), locale);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/backend/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/backend", "");
    if (path === "/settings/assistant") {
      if (request.method() === "PUT") {
        const change: AssistantUpdate = request.postDataJSON();
        expect(change.expectedRevision).toBe(settings.revision);
        writes.push(change);
        settings = { ...settings, ...change, revision: settings.revision + 1 } as AssistantSettings;
      }
      return route.fulfill({ json: settings });
    }
    if (path.endsWith("/assistant/test") && request.method() === "POST") {
      tools.push(path);
      expect(request.postDataJSON()).toEqual({ model: "model-a" });
      return route.fulfill({ json: { status: "succeeded" } });
    }
    if (path === "/assistant/conversations" && request.method() === "DELETE") {
      erasures++;
      return route.fulfill({ status: 204 });
    }
    expect(request.method()).toBe("GET");
    return route.fulfill({ json: path === "/settings/integrations" ? {
      profile: { accountLabels: {} }, integrations: [], llmProviders: [], llmRoutePolicy: null,
    } : {} });
  });
  await page.goto("/settings?tab=assistant");
  await expect(page.getByRole("heading", { name: ASSISTANT_NAME })).toBeVisible();
  return { writes, tools, erasures: () => erasures };
}

test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Use an isolated local web build.");

test("consent, enablement, provider choice and conversation deletion are independent", async ({ page }) => {
  const { writes, tools, erasures } = await open(page);
  const enable = page.getByRole("switch", { name: "Enable " + ASSISTANT_NAME });
  const background = page.getByRole("switch", { name: "Write briefs in the background" });
  const assumptions = page.getByRole("switch", { name: "Share saved valuation assumptions" });
  const withdraw = page.getByRole("button", { name: "Withdraw consent" });
  const dialog = page.getByRole("dialog");
  await expect(enable).not.toBeChecked();
  await expect(background).toBeChecked();
  await expect(assumptions).toBeChecked();
  await enable.focus();
  await enable.press("Space");
  await expect(dialog).toContainText("OpenAI (model-a)");
  await expect(dialog).toContainText("holdings and amounts");
  await expect(dialog).toContainText("daily run cap");
  await expect(dialog).toContainText("growth and discount rates");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(writes).toHaveLength(0);
  await assumptions.click();
  await expect(assumptions).not.toBeChecked();
  await enable.click();
  await dialog.getByRole("button", { name: "Agree and enable" }).click();
  await expect(enable).toBeChecked();
  await background.click();
  await expect(background).not.toBeChecked();
  await enable.click();
  await expect(enable).not.toBeChecked();
  await expect(withdraw).toBeEnabled();
  await enable.click();
  await expect(enable).toBeChecked();
  await page.getByRole("button", { name: "Test tool calls" }).click();
  await expect(page.getByText("Tool call succeeded.")).toBeVisible();
  expect(tools).toEqual(["/settings/llm/providers/openai/assistant/test"]);
  await page.getByRole("combobox", { name: "Model" }).selectOption("ollama/local/model");
  await expect(dialog).toContainText("Ollama (local/model)");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("openai/model-a");
  await page.getByRole("button", { name: "Delete conversations" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(erasures()).toBe(0);
  await page.getByRole("button", { name: "Delete conversations" }).click();
  await dialog.getByRole("button", { name: "Delete all conversations" }).click();
  await expect(page.getByText("Conversations deleted from this workspace.")).toBeVisible();
  await expect(enable).toBeChecked();
  await withdraw.click();
  await expect(enable).not.toBeChecked();
  await expect(withdraw).toBeDisabled();
  expect(writes.at(-1)).toMatchObject({ enabled: false, acceptedConsentRevision: null });
  expect(erasures()).toBe(1);
});

test("a workspace without connected models can reach model connections and erase its history", async ({ page }) => {
  await open(page, "en", false);
  await expect(page.getByRole("switch", { name: "Enable " + ASSISTANT_NAME })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete conversations" })).toBeEnabled();
  await page.getByRole("button", { name: "Connect a model" }).click();
  await expect(page.getByRole("tab", { name: "Model connections" })).toHaveAttribute("aria-selected", "true");
});

for (const locale of ["en", "zh"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`controls and consent fit in ${locale} and ${colorScheme}`, async ({ page, isMobile }, testInfo) => {
      if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await open(page, locale);
      await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", colorScheme);
      const shotDir = process.env.SETTINGS_SCREENSHOT_DIR;
      const prefix = [testInfo.project.name, locale, colorScheme].join("-");
      const panel = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: ASSISTANT_NAME }) });
      expect(await new AxeBuilder({ page }).include(".mx-panel").analyze().then((r) => r.violations)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shotDir) await page.screenshot({ path: `${shotDir}/${prefix}-settings.png` });
      await panel.getByRole("switch").first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: locale === "en" ? "Agree and enable" : "同意并启用" })).toBeInViewport();
      expect(await new AxeBuilder({ page }).include('[role="dialog"]').analyze().then((r) => r.violations)).toEqual([]);
      if (shotDir) await page.screenshot({ path: `${shotDir}/${prefix}-consent.png` });
    });
  }
}
