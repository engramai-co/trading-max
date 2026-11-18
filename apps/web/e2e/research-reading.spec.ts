import { expect, test, type Page } from "@playwright/test";

const days = ["2026-10-01", "2026-10-02", "2026-10-05"];
const lens = {
  analyst: {
    asOf: "2026-10-05", reportingCurrency: "USD", providerRecommendationKey: "buy",
    priceTargets: { low: 85, median: 112, mean: 114, high: 138 },
    recommendations: [{ period: "0m", strongBuy: 3, buy: 5, hold: 4, sell: 1, strongSell: 0 }],
    upgradesDowngrades: [
      { index: "2026-10-03", firm: "Sample Research", currentPriceTarget: 109, action: "up" },
      { index: "2026-10-03", firm: "Sample Partners", currentPriceTarget: 111, action: "main" },
    ],
    fiscalPeriods: [{ period: "0q", endDate: "2026-12-26" }, { period: "0y", endDate: "2027-09-25" }],
    earningsEstimate: [{ period: "0q", avg: 2, low: 1.8, high: 2.2, yearAgoEps: 1.75, numberOfAnalysts: 13, currency: "USD" }],
    earningsEvents: [{ id: "event1", date: "2026-10-01", status: "reported", actualEps: 1.9, estimatedEps: 1.8 }],
  },
};

async function analystFixture(page: Page) {
  await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), ...lens } });
  });
  await page.route("**/api/backend/research/AAPL/prices?**", (route) => route.fulfill({ json: {
    ticker: "AAPL", currency: "USD", points: days.map((date, i) => ({ date, close: 100 + i })),
  } }));
}

test.describe("research section navigation", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await analystFixture(page);
  });

  test("legacy links, keyboard navigation, Back and manual scrolling follow the section headings", async ({ page, isMobile }) => {
    await page.goto("/research?ticker=AAPL&view=analyst&analystView=forecast");
    const index = page.getByRole("navigation", { name: "On this page" });
    const forecast = index.getByRole("link", { name: "Earnings estimates" });
    await expect(page.locator("#research-forecast h2").first()).toBeFocused();
    await expect(forecast).toHaveAttribute("aria-current", "location");
    const ratings = index.getByRole("link", { name: "Ratings & targets" });
    await ratings.focus();
    await ratings.press("Enter");
    await expect(page.locator("#research-ratings h2").first()).toBeFocused();
    await expect(ratings).toHaveAttribute("aria-current", "location");
    await page.goBack();
    await expect(forecast).toHaveAttribute("aria-current", "location");
    await page.locator("#research-actions").evaluate((section) => section.scrollIntoView({ block: "start" }));
    await expect(index.getByRole("link", { name: "Institutional actions" })).toHaveAttribute("aria-current", "location");
    await expect(forecast).not.toHaveAttribute("aria-current", "location");
    // The index stays operable after scrolling, including when a side panel takes space.
    if (!isMobile) {
      await page.locator(".mx-reading-container").evaluate((section) => { section.style.maxWidth = "760px"; });
      await expect(index).toHaveCSS("display", "flex");
    }
    await index.getByRole("link", { name: "Earnings events" }).click();
    await expect(page.locator("#research-events h2")).toBeFocused();
    if (isMobile) {
      const events = page.getByRole("region", { name: "Earnings calendar" });
      for (const width of [320, 360, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(events.locator("dt").filter({ hasText: "Event date" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      await forecast.click();
      await expect(page.getByText("FY27 Q1", { exact: true })).toBeVisible();
    }
  });

  test("a target on a non-trading day shares the price timeline and keeps both firms", async ({ page }) => {
    await page.goto("/research?ticker=AAPL&view=analyst");
    const chart = page.getByRole("group", { name: /^Historical prices and analyst target range/ });
    await page.locator(".mx-target-chart").scrollIntoViewIfNeeded();
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await chart.press("End");
    await chart.press("ArrowLeft");
    const reading = page.locator(".mx-target-chart .mx-chart-readout-values");
    await expect(reading).toContainText("3 Oct");
    await expect(reading).toContainText("Sample Research · Target 109.00");
    await expect(reading).toContainText("Sample Partners · Target 111.00");
    await expect(reading).not.toContainText("Close");
    await expect(page.getByRole("group", { name: "Historical firm targets" })).toHaveCount(0);
  });
});
