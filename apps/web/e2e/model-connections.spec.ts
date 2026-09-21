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
      expect(body.model).toBe("claude-sonnet-4-6");
      expect(body.validationToken).toBe("synthetic-receipt");
      const item = overview.integrations.find((i) => i.provider === "anthropic")!;
      Object.assign(item, { enabled: true, configured: true, needsSecret: false, model: body.model });
      overview.llmRoutePolicy = { ...overview.llmRoutePolicy!, defaultRoute: "anthropic/claude-sonnet-4-6", revision: overview.llmRoutePolicy!.revision + 1 };
      return route.fulfill({ json: item });
    });
    await save.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /默认模型|Default model/, exact: true })).toHaveValue("Anthropic · claude-sonnet-4-6");
    await page.reload();
    await expect(page.getByRole("combobox", { name: /默认模型|Default model/, exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("setup can be dismissed without connecting or choosing a different provider", async ({ page }) => {
    await page.goto("/settings?tab=models");
    await page.getByRole("dialog").getByRole("button", { name: /稍后设置|Set up later/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "OpenAI", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /DeepSeek|OpenCode/ })).toHaveCount(0);
  });
});
