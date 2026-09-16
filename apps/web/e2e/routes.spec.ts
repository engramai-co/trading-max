import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/holdings",
  "/analytics",
  "/review",
  "/account-analysis?account=A",
  "/research",
  "/health",
  "/settings",
];
test.describe("portfolio workspace", () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.",
  );

  for (const route of routes) {
    test(`${route} has a usable heading, no horizontal overflow, and accessible controls`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText(
        /This page could not be displayed|这一页暂时无法显示/,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) => animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations).toEqual([]);
    });
  }

  test("settings tabs update both content and URL without reloading", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("tab", { name: /AI 分析|AI analysis/ }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /AI 分析|AI analysis/ }).click();
    await expect(page).toHaveURL(/tab=models/);
    await expect(
      page.getByRole("heading", {
        name: /分析模型|Analysis models/,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /个人偏好|Preferences/ }).click();
    await expect(
      page.getByRole("textbox", { name: /显示名称|Display name/ }),
    ).toBeVisible();
  });

  test("the broker form requires a successful candidate test before save", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page
      .getByRole("button", { name: /连接账户|Connect$/, exact: false })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: /保存连接|Save connection/ }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: /测试连接|Test connection/ }),
    ).toBeDisabled();
    await dialog.getByLabel(/^API Key ID/).fill("synthetic-id");
    await dialog.getByLabel(/^API Secret/).fill("synthetic-secret");
    await expect(
      dialog.getByRole("button", { name: /测试连接|Test connection/ }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole("button", { name: /保存连接|Save connection/ }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("failed data requests offer a retry and recover", async ({ page }) => {
    await page.route("**/api/backend/dashboard/lens/overview", (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /重新加载|Try again/ }),
    ).toBeVisible();
    await page.unroute("**/api/backend/dashboard/lens/overview");
    await page.getByRole("button", { name: /重新加载|Try again/ }).click();
    await expect(
      page.getByRole("button", { name: /重新加载|Try again/ }),
    ).toHaveCount(0);
  });

  test("command search supports keyboard selection and closes after navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: /搜索页面或证券|Search pages or securities/ })
      .click();
    await page
      .getByRole("textbox", {
        name: /搜索页面或证券|Search pages or securities/,
      })
      .fill("research");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/research/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
