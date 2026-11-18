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

  for (const filter of ["estimateFrequency=year", "forecastPeriod=%2B1q"]) {
    test("forecast bookmark " + filter + " lands on estimates", async ({ page }) => {
      await page.goto("/research?ticker=AAPL&view=analyst&" + filter);
      await expect(page.locator("#research-forecast h2").first()).toBeFocused();
    });
  }

  test("a clamped event jump stays current until the reader scrolls", async ({ page, isMobile }) => {
    test.skip(isMobile, "The short sections both fit in a desktop viewport.");
    await page.goto("/research?ticker=AAPL&view=analyst");
    const nav = page.getByRole("navigation", { name: "On this page" });
    const events = nav.getByRole("link", { name: "Earnings events" });
    await events.click();
    await expect(page.locator("#research-events h2")).toBeFocused();
    await expect(events).toHaveAttribute("aria-current", "location");
    await page.keyboard.press("Home");
    await expect(nav.getByRole("link", { name: "Ratings & targets" })).toHaveAttribute("aria-current", "location");
  });

  test("snapshot and split-adjusted firm targets use pounds alongside pound prices", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, context: { ...data.context,
        quote: { ...data.context.quote, price: 4.25, currency: "GBP", quoteUnit: "GBp" } },
        analyst: { ...lens.analyst, priceTargets: { median: 450, high: 495, low: 419 },
          upgradesDowngrades: [{ index: days[0], firm: "Before Split", currentPriceTarget: 920 },
            { index: days[1], firm: "On Split", currentPriceTarget: 470 }] } } });
    });
    await page.route("**/api/backend/research/AAPL/prices?**", (route) => route.fulfill({ json: {
      ticker: "AAPL", currency: "GBP", events: [{ date: days[1], kind: "split", value: 2 }],
      points: days.map((date) => ({ date, close: 4.25 })),
    } }));
    await page.goto("/research?ticker=AAPL&view=analyst");
    const summary = page.locator(".mx-target-summary");
    await expect(summary).toContainText("£4.50");
    await expect(summary).toContainText("+5.9%");
    const chart = page.getByRole("group", { name: /^Historical prices/ });
    await page.locator(".mx-target-chart").scrollIntoViewIfNeeded();
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await chart.press("Home");
    const reading = page.locator(".mx-target-chart .mx-chart-readout-values");
    await expect(reading).toContainText("Before Split · Target 4.60");
    await chart.press("ArrowRight");
    await expect(reading).toContainText("On Split · Target 4.70");
    await expect(page.locator("#research-actions")).toContainText("£9.20");
  });

  test("an older target snapshot waits for the split history before comparing it with today's quote", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, context: { ...data.context,
        quote: { ...data.context.quote, price: 4.25, currency: "GBP", quoteUnit: "GBp", asOf: days[2] } },
        analyst: { ...lens.analyst, asOf: days[0], priceTargets: { median: 900 } } } });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/research/AAPL/prices?**", async (route) => {
      await gate;
      await route.fulfill({ json: { ticker: "AAPL", currency: "GBP",
        points: days.map((date) => ({ date, close: 4.25, split: date === days[1] ? 2 : 0 })) } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst");
    const summary = page.locator(".mx-target-summary");
    await expect(summary).toBeVisible();
    await expect.soft(summary).not.toContainText("+111.8%", { timeout: 500 });
    release();
    await expect(summary).toContainText("£4.50");
    await expect(summary).toContainText("+5.9%");
  });

  test("target-only dates after the last close run through the snapshot date", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), analyst: {
        ...lens.analyst, asOf: "2026-10-07T12:00:00Z", upgradesDowngrades: [
          { index: "2026-10-06", firm: "Later Research", currentPriceTarget: 110 },
          { index: "2026-10-08", firm: "Future Research", currentPriceTarget: 200 },
        ] } } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst");
    const chart = page.getByRole("group", { name: /^Historical prices/ });
    await page.locator(".mx-target-chart").scrollIntoViewIfNeeded();
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await chart.press("End");
    const reading = page.locator(".mx-target-chart .mx-chart-readout-values");
    await expect(reading).toContainText("Later Research · Target 110.00");
    await expect(reading).not.toContainText("Close");
  });

  test("revisions and the calendar keep their distinct readings", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), nextEarningsDate: "2030-02-14",
        analyst: { ...lens.analyst, epsTrend: [{ period: "0q", current: 2.6, "90daysAgo": 2 }] } } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst");
    const revisions = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: "EPS estimate revisions" }) });
    await revisions.locator("details summary").click();
    await expect.soft(revisions).toContainText("+30.0%");
    await expect(page.locator("#research-events")).toContainText("14 Feb 2030");
  });

  test("the price legend reserves its phone height while prices load", async ({ page, isMobile }) => {
    test.skip(!isMobile, "The phone label wraps.");
    await page.setViewportSize({ width: 320, height: 844 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/research/AAPL/prices?**", async (route) => { await gate; await route.fallback(); });
    await page.goto("/research?ticker=AAPL&view=analyst");
    const heading = page.locator(".mx-target-chart-heading");
    await expect(heading).toBeVisible();
    const before = await heading.boundingBox();
    release();
    await expect(heading).toContainText("Firm targets");
    await expect(page.locator(".mx-price-context-status")).toHaveCount(0);
    expect((await heading.boundingBox())!.height).toBe(before!.height);
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
