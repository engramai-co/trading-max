import { expect, test } from "@playwright/test";

test.describe("held funds in research", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");

  test("a held fund opens from the overview ledger, its position drawer and search", async ({ page }) => {
    const origin = new URL(process.env.PLAYWRIGHT_BASE_URL!).origin;
    // Do not permit writes or external requests in the synthetic preview.
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== "GET") return route.abort();
      return url.pathname.startsWith("/api/company-logo/") ? route.fulfill({ status: 204 }) : route.continue();
    });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?range=1D");

    const fixtureTicker = process.env.HELD_FUND_QA_TICKER;
    test.skip(!fixtureTicker, "Requires the isolated preview with an unlisted held fund.");
    const shell = await page.request.get("/api/backend/research/shell");
    expect((await shell.json()).instruments).toContainEqual(expect.objectContaining({
      ticker: fixtureTicker, held: true, isFund: true, watchlisted: false,
    }));
    const ticker = fixtureTicker!;
    const tickerPattern = new RegExp("^" + ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const fundLink = page.locator('[data-asset-class="funds"]:visible')
      .getByRole("link", { name: tickerPattern }).first();
    expect(ticker).toBeTruthy();
    await fundLink.click();

    const lenses = page.getByRole("tablist", { name: "证券研究视角" });
    async function expectFundView() {
      await expect(page).toHaveURL(new RegExp("/research\\?ticker=" + ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await expect(lenses.getByRole("tab")).toHaveCount(6);
      await expect(lenses.getByRole("tab", { name: "指数与跟踪" })).toBeVisible();
      await expect(page.getByText("还不在研究清单里", { exact: false })).toHaveCount(0);
      await expect(page.locator(".mx-etf-summary")).toBeVisible();
    }
    await expectFundView();

    await page.goto("/holdings?q=" + encodeURIComponent(ticker));
    const holding = page.locator("button:visible").filter({ hasText: ticker }).first();
    await holding.click();
    await page.getByRole("dialog").getByRole("link", { name: "研究这项投资" }).click();
    await expectFundView();

    await page.goto("/");
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索页面或证券" });
    await search.fill(ticker);
    await page.getByRole("option", { name: tickerPattern }).click();
    await expectFundView();
  });
});
