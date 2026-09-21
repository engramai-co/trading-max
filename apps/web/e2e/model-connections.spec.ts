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
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("combobox")).toHaveValue("OpenAI");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "Anthropic", exact: true }).click();
    await dialog.getByRole("button", { name: /继续连接|Continue/ }).click();
    dialog = page.getByRole("dialog", { name: /连接 Anthropic|Connect Anthropic/ });
    await expect(dialog.getByRole("heading")).toContainText("Anthropic");
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    const key = dialog.getByLabel(/^API Key/);
    const save = dialog.getByRole("button", { name: /保存连接|Save connection/ });
    await expect(save).toBeDisabled();
    await key.fill("synthetic-key");
    await page.route("**/api/backend/settings/llm/providers/anthropic/test", (route) => route.fulfill({ json: { status: "succeeded", validationToken: "synthetic-receipt" } }));
    await dialog.getByRole("button", { name: /测试连接|Test connection/ }).click();
    await expect(save).toBeEnabled();
    await key.fill("changed-synthetic-key");
    await expect(save).toBeDisabled();
    await dialog.getByRole("button", { name: /测试连接|Test connection/ }).click();
    await expect(save).toBeEnabled();
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
    await page.getByRole("dialog").getByRole("button", { name: /稍后设置|Set up later/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "OpenAI", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /DeepSeek|OpenCode/ })).toHaveCount(0);
  });

  test("OpenAI offers ChatGPT device login with Luna and retains the API key option", async ({ page, request }) => {
    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    let state = "pending";
    const session = { sessionId: "synthetic-device-session", state, userCode: "TEST-1234", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2099-01-01T00:00:00Z", errorCode: null };
    await page.route("**/api/backend/settings/llm/oauth/openai/start", (route) => {
      expect(route.request().postDataJSON()).toEqual({ model: "gpt-5.6-luna", useAsDefault: true });
      return route.fulfill({ json: session });
    });
    await page.route("**/api/backend/settings/llm/oauth/openai/synthetic-device-session", (route) => {
      if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
      return route.fulfill({ json: { ...session, state } });
    });
    await page.goto("/settings?tab=models");
    await page.getByRole("dialog").getByRole("button", { name: /继续连接|Continue/ }).click();
    const dialog = page.getByRole("dialog", { name: /连接 OpenAI|Connect OpenAI/ });
    await expect(dialog.getByRole("combobox")).toHaveValue("gpt-5.6-luna");
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog.getByRole("radiogroup").getByText("API Key", { exact: true }).click();
    await expect(dialog.locator('input[type="password"]')).toBeVisible();
    await dialog.getByRole("radiogroup").getByText(/ChatGPT 登录|ChatGPT sign-in/).click();
    await dialog.getByRole("button", { name: /使用 ChatGPT 登录|Sign in with ChatGPT/ }).click();
    await expect(dialog.getByText("TEST-1234", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("link", { name: /打开 OpenAI 授权|Open OpenAI authorization/ })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const item = overview.integrations.find((i) => i.provider === "openai-codex")!;
    Object.assign(item, { configured: true, enabled: true, needsSecret: false, model: "gpt-5.6-luna" });
    overview.llmRoutePolicy = { ...overview.llmRoutePolicy!, defaultRoute: "openai-codex/gpt-5.6-luna", revision: overview.llmRoutePolicy!.revision + 1 };
    state = "connected";
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /默认模型|Default model/, exact: true })).toHaveValue("OpenAI · ChatGPT · gpt-5.6-luna");
  });
});
