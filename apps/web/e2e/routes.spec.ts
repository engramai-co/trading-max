import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/holdings",
  "/analytics",
  "/review",
  "/research",
  "/health",
  "/settings",
];

test.describe("primary routes", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to run deployed UI checks.");

  for (const route of routes) {
    test(`${route} renders and passes automated accessibility checks`, async ({ page }) => {
      await page.goto(route, { waitUntil: "networkidle" });
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(
        /This page could not load|这个页面暂时加载失败/,
      );
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .disableRules(["color-contrast"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
