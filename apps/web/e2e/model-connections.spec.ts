import { expect, test } from "@playwright/test";
import type { IntegrationOverview } from "../lib/types";

test.describe("model connection setup", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated synthetic local deployment");

  test("first setup defaults to OpenAI, allows another provider, and saves that default", async ({ page, request }) => {
    const response = await request.get("/api/backend/settings/integrations");
    const overview = await response.json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    await page.goto("/settings?tab=models");
    await expect(page.getByRole("tabpanel", { name: /模型连接|Model connections/ })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /选择提供商|Choose a provider/ }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("combobox")).toHaveText("OpenAI");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "Anthropic", exact: true }).click();
    await dialog.getByRole("button", { name: /继续连接|Continue/ }).click();
    dialog = page.getByRole("dialog", { name: /连接 Anthropic|Connect Anthropic/ });
    await expect(dialog.getByRole("heading")).toContainText("Anthropic");
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    const key = dialog.getByLabel(/^API Key/);
    const save = dialog.getByRole("button", { name: /保存连接|Save connection/ });
    const prerequisite = dialog.getByText(/连接测试通过后即可保存。|Test the connection before saving\./);
    await expect(save).toBeDisabled();
    await expect(prerequisite).toBeVisible();
    await expect(save).toHaveAccessibleDescription(/连接测试通过后即可保存。|Test the connection before saving\./);
    await key.fill("synthetic-key");
    await expect(dialog.getByText(/^(Closing this form clears unsaved keys\.|关闭此表单会清除未保存的密钥。)$/)).toHaveCount(0);
    await page.route("**/api/backend/settings/llm/providers/anthropic/test", (route) => route.fulfill({ json: { status: "succeeded", validationToken: "synthetic-receipt" } }));
    await dialog.getByRole("button", { name: /测试连接|Test connection/ }).click();
    await expect(save).toBeEnabled();
    await expect(prerequisite).toHaveCount(0);
    await key.fill("changed-synthetic-key");
    await expect(save).toBeDisabled();
    await expect(prerequisite).toBeVisible();
    await dialog.getByRole("button", { name: /测试连接|Test connection/ }).click();
    await expect(save).toBeEnabled();
    await expect(prerequisite).toHaveCount(0);
    await page.route("**/api/backend/settings/llm/providers/anthropic", (route) => {
      const body = route.request().postDataJSON();
      expect(body.useAsDefault).toBe(true);
      expect(body.model).toBe("claude-haiku-4-5-20251001");
      expect(body.validationToken).toBe("synthetic-receipt");
      const item = overview.integrations.find((i) => i.provider === "anthropic")!;
      Object.assign(item, { enabled: true, configured: true, needsSecret: false, model: body.model });
      overview.llmRoutePolicy = { ...overview.llmRoutePolicy!, defaultRoute: "anthropic/claude-haiku-4-5-20251001", revision: overview.llmRoutePolicy!.revision + 1 };
      return route.fulfill({ json: item });
    });
    await save.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /默认模型|Default model/, exact: true })).toHaveValue("Anthropic · claude-haiku-4-5-20251001");
    await page.reload();
    await expect(page.getByRole("combobox", { name: /默认模型|Default model/, exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("setup can be dismissed without connecting or choosing a different provider", async ({ page, request }) => {
    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    await page.goto("/settings?tab=models");
    const trigger = page.getByRole("button", { name: /选择提供商|Choose a provider/ });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /^(关闭|Close)$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("button", { name: /稍后设置|Set up later/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "OpenAI", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /DeepSeek|OpenCode/ })).toHaveCount(0);
  });

  test("OpenAI offers ChatGPT device login with Luna and retains the API key option", async ({ page, request }) => {
    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    let state = "pending";
    let attempts = 0;
    const session = { sessionId: "synthetic-device-session", state, userCode: "TEST-1234", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2099-01-01T00:00:00Z", errorCode: null };
    await page.route("**/api/backend/settings/llm/oauth/openai/start", (route) => {
      expect(route.request().postDataJSON()).toEqual({ model: "gpt-5.6-luna", useAsDefault: true });
      attempts++;
      state = "pending";
      return route.fulfill({ json: { ...session, sessionId: `synthetic-device-session-${attempts}` } });
    });
    await page.route("**/api/backend/settings/llm/oauth/openai/synthetic-device-session-*", (route) => {
      if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
      return route.fulfill({ json: { ...session, sessionId: `synthetic-device-session-${attempts}`, state } });
    });
    await page.goto("/settings?tab=models");
    await page.getByRole("button", { name: /选择提供商|Choose a provider/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /继续连接|Continue/ }).click();
    const dialog = page.getByRole("dialog", { name: /连接 OpenAI|Connect OpenAI/ });
    await expect(dialog.getByRole("combobox")).toHaveText("gpt-5.6-luna");
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    const methodPicker = dialog.getByRole("radiogroup", { name: /OpenAI 连接方式|OpenAI connection method/ });
    const chatgpt = methodPicker.getByRole("radio", { name: /^(ChatGPT 登录|ChatGPT sign-in)$/ });
    const apiKey = methodPicker.getByRole("radio", { name: "API Key", exact: true });
    await expect(chatgpt).toBeChecked();
    await chatgpt.focus();
    await page.keyboard.press("ArrowRight");
    await expect(apiKey).toBeFocused();
    await expect(apiKey).toBeChecked();
    await expect(dialog.locator('input[type="password"]')).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(chatgpt).toBeFocused();
    await expect(chatgpt).toBeChecked();
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await apiKey.click();
    await expect(dialog.locator('input[type="password"]')).toBeVisible();
    await chatgpt.click();
    await dialog.getByRole("button", { name: /使用 ChatGPT 登录|Sign in with ChatGPT/ }).click();
    await expect(dialog.getByText("TEST-1234", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("link", { name: /打开 OpenAI 授权|Open OpenAI authorization/ })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const announcement = dialog.locator("[data-oauth-status]");
    await expect(announcement).toHaveText(/授权码已生成|authorisation code is ready/);
    state = "expired";
    await expect(announcement).toHaveText(/授权码已过期|authorisation code expired/);
    await expect(dialog.getByText("TEST-1234", { exact: true })).toBeHidden();
    await dialog.getByRole("button", { name: /使用 ChatGPT 登录|Sign in with ChatGPT/ }).click();
    await expect(announcement).toHaveText(/授权码已生成|authorisation code is ready/);
    expect(attempts).toBe(2);
    const item = overview.integrations.find((i) => i.provider === "openai-codex")!;
    Object.assign(item, { configured: true, enabled: true, needsSecret: false, model: "gpt-5.6-luna" });
    overview.llmRoutePolicy = { ...overview.llmRoutePolicy!, defaultRoute: "openai-codex/gpt-5.6-luna", revision: overview.llmRoutePolicy!.revision + 1 };
    state = "connected";
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /默认模型|Default model/, exact: true })).toHaveValue("OpenAI · ChatGPT · gpt-5.6-luna");
  });
});

test("Settings review uses the same OAuth polling error and retry in both channels", async ({ page, request }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a synthetic web preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
  overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
  await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
  let starts = 0;
  await page.route("**/api/backend/settings/llm/oauth/openai/start", (route) => {
    starts++;
    return route.fulfill({ json: {
      sessionId: "synthetic-review-" + starts, state: "pending", userCode: "TEST-1234",
      verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2099-01-01T00:00:00Z", errorCode: null,
    } });
  });
  await page.route("**/api/backend/settings/llm/oauth/openai/synthetic-review-*", (route) =>
    route.fulfill({ status: route.request().method() === "DELETE" ? 204 : 503 }));
  await page.goto("/settings?tab=models");
  await page.getByRole("button", { name: "Connect model: OpenAI", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect OpenAI", exact: true });
  await dialog.getByRole("button", { name: "Sign in with ChatGPT", exact: true }).click();
  const message = "Could not check authorisation status. Sign in again to retry.";
  await expect(dialog.locator("[data-oauth-status]")).toHaveText(message);
  const warning = dialog.getByRole("note").filter({ hasText: message });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Sign in with ChatGPT", exact: true }).click();
  expect(starts).toBe(2);
});
