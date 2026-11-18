import { createHash } from "node:crypto";
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

/** Wide readings start with the index closed; these cases navigate with it pinned. */
async function openSectionIndex(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("mx-research-index-open", "true");
    localStorage.setItem("mx-research-index-pinned", "true");
  });
}

test.describe("research section navigation", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await openSectionIndex(page);
    await analystFixture(page);
  });

  test("a London technical close keeps its pence unit and observation date", async ({ page }) => {
    await page.route("**/api/backend/research/shell*", async (route) => {
      const response = await route.fetch(), shell = await response.json();
      await route.fulfill({ response, json: { ...shell, instruments: [...shell.instruments, {
        ...shell.instruments[0], ticker: "ARCH.L", name: "Archive London", exchange: "LSE",
        held: false, watchlisted: true, isFund: false, brokerPrice: null,
      }] } });
    });
    await page.route("**/api/backend/research/ARCH.L/lens/technical?**", async (route) => {
      const response = await route.fetch({ url: route.request().url().replace("/ARCH.L/", "/AAPL/") });
      const lens = await response.json();
      await route.fulfill({ response, json: { ...lens, ticker: "ARCH.L", market: null, valuation: null,
        context: { ...lens.context, quote: { price: null, currency: "GBP", exchange: "LSE" } },
        technical: { ...lens.technical, ticker: "ARCH", price: 3100, currency: "GBp", asOf: "2026-02-03" },
      } });
    });
    await page.route("**/api/backend/research/ARCH.L/prices?**", (route) => route.fulfill({ json: {
      ticker: "ARCH.L", currency: "GBp", points: [{ date: "2026-02-03", close: 3100 }], actualInterval: "1d",
    } }));
    await page.goto("/research?ticker=ARCH.L&view=technical");
    const header = page.locator(".mx-security-price");
    await expect(header.locator("strong")).toHaveText("£31.00");
    await expect(header).toContainText(/3 Feb(?: 2026)? close/);
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
    await page.keyboard.press("End");
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

  test("returning from Valuation opens Ratings after a legacy forecast bookmark", async ({ page }) => {
    await page.goto("/research?ticker=AAPL&view=analyst&forecastPeriod=%2B1q");
    await expect(page.locator("#research-forecast h2").first()).toBeFocused();
    await page.getByRole("tab", { name: "Valuation", exact: true }).click();
    await expect(page.locator("#research-history")).toBeAttached();
    await page.getByRole("tab", { name: /Estimates/ }).click();
    await expect(page.getByRole("link", { name: "Ratings & targets" })).toHaveAttribute("aria-current", "location");
    await expect(page.locator("#research-ratings h2").first()).not.toBeFocused();
  });

  test("arrow keys move focus along the research lenses, and Enter or Space opens one with one history entry", async ({ page }) => {
    await page.goto("/research?ticker=AAPL&view=technical");
    const tabs = page.getByRole("tablist", { name: "Research perspectives" });
    const price = tabs.getByRole("tab", { name: "Price & technicals" });
    const estimates = tabs.getByRole("tab", { name: /Estimates/ });
    const valuation = tabs.getByRole("tab", { name: "Valuation" });
    const panel = page.getByRole("tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", (await price.getAttribute("id"))!);
    const lenses: string[] = [];
    page.on("request", (request) => {
      const lens = /\/research\/AAPL\/lens\/(\w+)/.exec(request.url())?.[1];
      if (lens && lens !== "technical") lenses.push(lens);
    });
    const entries = await page.evaluate(() => history.length);
    // Arrows, Home and End only move focus: no other lens loads and the address stays.
    await price.press("ArrowRight");
    await expect(estimates).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(valuation).toBeFocused();
    await page.keyboard.press("End");
    await expect(tabs.getByRole("tab").last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tabs.getByRole("tab").first()).toBeFocused();
    await expect(price).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/view=technical/);
    expect(lenses).toEqual([]);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    // Enter opens the focused lens, once; the tab and its panel name each other.
    await estimates.focus();
    await page.keyboard.press("Enter");
    await expect(estimates).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("link", { name: "Ratings & targets" })).toHaveAttribute("aria-current", "location");
    await expect(estimates).toBeFocused();
    await expect(estimates).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
    await expect(panel).toHaveAttribute("aria-labelledby", (await estimates.getAttribute("id"))!);
    expect(await page.evaluate(() => history.length)).toBe(entries + 1);
    // Space does the same, and Back returns to the lens before.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press(" ");
    await expect(valuation).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#research-history")).toBeAttached();
    expect(await page.evaluate(() => history.length)).toBe(entries + 2);
    expect(lenses.filter((lens) => !["analyst", "valuation"].includes(lens))).toEqual([]);
    await page.goBack();
    await expect(estimates).toHaveAttribute("aria-selected", "true");
    await page.getByRole("link", { name: "Ratings & targets" }).press("Enter");
    await expect(page.locator("#research-ratings h2").first()).toBeFocused();
  });

  test("estimates read each figure one way: surprises in their colour, amounts with their currency", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), analyst: {
        ...lens.analyst,
        earningsHistory: [
          { quarter: "2026-06-27T00:00:00", epsActual: 1.9, epsEstimate: 1.8, surprisePercent: 0.0556 },
          { quarter: "2026-09-26T00:00:00", epsActual: 1.7, epsEstimate: 1.75, surprisePercent: -0.0286 },
        ],
        revenueEstimate: [{ period: "0q", avg: 120e9, low: 115e9, high: 125e9, yearAgoRevenue: 110e9, growth: 0.091, numberOfAnalysts: 20, currency: "USD" }],
        epsTrend: [{ period: "0q", current: 2.003, "7daysAgo": 2.002, "30daysAgo": 2.001, "60daysAgo": 2, "90daysAgo": 1.989 }],
      } } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst&analystView=forecast");
    const estimates = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: "Earnings & revenue estimates" }) });
    // Every amount carries its currency, so no code stands alone in the panel. Phones read the same
    // figures as records, and browsers differ only in the suffix.
    await expect(estimates).toContainText(/US\$120(bn|B)/);
    await expect(estimates.getByText("USD", { exact: true })).toHaveCount(0);
    // The table writes a beat or miss as the chart's reading does: signed, and green or red.
    await page.locator("summary").filter({ hasText: "Quarterly readings" }).click();
    const readings = page.getByRole("region", { name: "Quarterly EPS details" });
    await expect(readings.locator(".mx-up")).toHaveText(["+0.10", "+5.56%"]);
    await expect(readings.locator(".mx-down")).toHaveText(["\u22120.05", "\u22122.86%"]);
    // The 90-day revision is coloured the same way.
    await page.locator("summary").filter({ hasText: "Readings and basis" }).click();
    await expect(page.getByText("90-day EPS estimate change").locator(".mx-up")).toHaveText("+0.7%");
  });

  test("changing forecast frequency keeps focus on the filter, and its bookmark focuses Estimates", async ({ page }) => {
    await page.goto("/research?ticker=AAPL&view=analyst");
    const annual = page.getByRole("button", { name: "Annual", exact: true });
    await annual.press("Enter");
    await expect(annual).toHaveAttribute("aria-pressed", "true");
    await expect(annual).toBeFocused();
    const bookmark = page.url();
    await page.goto("/");
    await page.goto(bookmark);
    await expect(page.locator("#research-actions")).toContainText("Sample Research");
    await expect(annual).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#research-forecast h2").first()).toBeFocused();
    await page.unrouteAll({ behavior: "wait" });
  });

  test("a clamped event jump stays current until the reader scrolls", async ({ page, isMobile }) => {
    test.skip(isMobile, "The short sections both fit in a desktop viewport.");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/research/AAPL/prices?**", async (route) => { await gate; await route.fallback(); });
    await page.goto("/research?ticker=AAPL&view=analyst");
    const nav = page.getByRole("navigation", { name: "On this page" });
    const events = nav.getByRole("link", { name: "Earnings events" });
    const ratings = page.locator("#research-ratings");
    // Model an earlier section shrinking after a clamped jump.
    await ratings.evaluate((section) => { section.style.paddingBottom = "80px"; });
    await events.click();
    await expect(page.locator("#research-events h2")).toBeFocused();
    await expect(events).toHaveAttribute("aria-current", "location");
    await page.keyboard.press("End");
    release();
    await expect(page.locator(".mx-price-context-status")).toHaveCount(0);
    await ratings.evaluate((section) => { section.style.paddingBottom = ""; });
    await expect.poll(() => page.evaluate(() => Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight)).toBe(true);
    await expect(events).toHaveAttribute("aria-current", "location");
    await page.keyboard.press("Home");
    await expect(nav.getByRole("link", { name: "Ratings & targets" })).toHaveAttribute("aria-current", "location");
  });

  test("snapshot and split-adjusted firm targets use pounds alongside pound prices", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, context: { ...data.context,
        quote: { ...data.context.quote, price: 4.25, currency: "GBP", quoteUnit: "GBp", asOf: days[2] } },
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

  for (const coverage of ["complete", "stale"] as const) {
    test("an older target snapshot with " + coverage + " split coverage keeps dated amounts and verifies the upside", async ({ page }) => {
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
          points: (coverage === "complete" ? days : days.slice(0, 1)).map((date) => ({
            date, close: 4.25, split: date === days[1] ? 2 : 0,
          })) } });
      });
      await page.goto("/research?ticker=AAPL&view=analyst");
      const summary = page.locator(".mx-target-summary");
      await expect(summary).toBeVisible();
      await expect.soft(summary).toContainText("£9.00", { timeout: 500 });
      await expect.soft(summary).not.toContainText("%");
      await expect(page.locator(".mx-target-dateline")).toContainText("£4.25");
      release();
      await expect(page.locator(".mx-price-context-status")).toHaveCount(0);
      if (coverage === "complete") {
        await expect(summary).toContainText("£4.50");
        await expect(summary).toContainText("+5.9%");
      } else {
        await expect(summary).toContainText("£9.00");
        await expect(summary).not.toContainText("%");
        await expect(page.locator(".mx-target-dateline")).toContainText("£4.25");
      }
    });
  }

  test("a later confirmed split puts both older dated amounts on the chart's share basis", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, context: { ...data.context,
        quote: { ...data.context.quote, price: 8.5, currency: "GBP", quoteUnit: "GBp", asOf: days[0] } },
        analyst: { ...lens.analyst, asOf: days[0], priceTargets: { median: 900 } } } });
    });
    await page.route("**/api/backend/research/AAPL/prices?**", (route) => route.fulfill({ json: {
      ticker: "AAPL", currency: "GBP",
      points: days.map((date) => ({ date, close: 4.25, split: date === days[1] ? 2 : 0 })),
    } }));
    await page.goto("/research?ticker=AAPL&view=analyst");
    await expect(page.locator(".mx-target-summary")).toContainText("£4.50");
    await expect(page.locator(".mx-target-summary")).toContainText("+5.9%");
    await expect(page.locator(".mx-target-dateline")).toContainText("£4.25");
  });

  test("post-split announcements stay readable without changing a pre-split price chart", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let median = 450, firmTarget = 460, covered = true;
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, context: { ...data.context,
        quote: { ...data.context.quote, price: 4.25, currency: "GBP", quoteUnit: "GBp", asOf: days[2] } },
        analyst: { ...lens.analyst, asOf: days[2], priceTargets: { low: median - 10, median, high: median + 10 },
          upgradesDowngrades: [{ index: days[2], firm: "Post Split Research", currentPriceTarget: firmTarget }] } } });
    });
    await page.route("**/api/backend/research/AAPL/prices?**", (route) => route.fulfill({ json: {
      ticker: "AAPL", currency: "GBP", points: covered
        ? days.map((date) => ({ date, close: 4.25, split: date === days[2] ? 2 : 0 }))
        : days.slice(0, 2).map((date) => ({ date, close: 8.5 })),
    } }));
    const chart = page.locator(".mx-target-chart");
    const readout = chart.locator(".mx-chart-readout-values");
    const draw = async () => {
      await page.goto("/research?ticker=AAPL&view=analyst");
      await chart.scrollIntoViewIfNeeded();
      await expect(chart.getByRole("group", { name: /^Historical prices/ })).toHaveAttribute("data-tm-chart-ready", "true");
      await expect(readout).toContainText("Post Split Research · Target " + (firmTarget / 100).toFixed(2));
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const pixels = await chart.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
      return createHash("sha256").update(pixels).digest("hex");
    };
    const withSplit = await draw();
    await expect(page.locator(".mx-target-key")).toBeVisible();
    firmTarget = 800;
    expect(await draw()).not.toBe(withSplit);
    covered = false;
    firmTarget = 460;
    const pricesOnly = await draw();
    // Changing only the unverified snapshot, then only the unverified firm target,
    // must leave the price scale, range, labels and scatter pixels identical.
    median = 1500;
    expect.soft(await draw()).toBe(pricesOnly);
    firmTarget = 50;
    expect.soft(await draw()).toBe(pricesOnly);
    median = 450;
    firmTarget = 460;
    await draw();
    await expect(page.locator(".mx-target-summary")).toContainText("£4.50");
    await expect(page.locator(".mx-target-summary")).toContainText("+5.9%");
    await expect(page.locator("#research-actions")).toContainText("£4.60");
    await expect(page.locator(".mx-target-key")).toBeHidden();
    await chart.getByRole("group", { name: /^Historical prices/ }).press("End");
    await expect(readout).toContainText("5 Oct");
    await expect(readout).toContainText("Post Split Research · Target 4.60 · as announced");
    await expect(readout).not.toContainText("Close");
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

  for (const width of [320, 390]) {
    test("the chart and its legend reserve their phone height at " + width, async ({ page, isMobile }) => {
      test.skip(!isMobile, "The phone label wraps.");
      await page.setViewportSize({ width, height: 844 });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/backend/research/AAPL/prices?**", async (route) => { await gate; await route.fallback(); });
      await page.goto("/research?ticker=AAPL&view=analyst");
      const heading = page.locator(".mx-target-chart-heading");
      await expect(heading).toBeVisible();
      const before = await heading.boundingBox();
      const chart = page.locator(".mx-target-chart");
      const beforeChart = await chart.boundingBox();
      const dateline = page.locator(".mx-target-dateline");
      const beforePrice = await dateline.evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
      release();
      await expect(heading).toContainText("Firm targets");
      await expect(page.locator(".mx-price-context-status")).toHaveCount(0);
      expect((await heading.boundingBox())!.height).toBe(before!.height);
      expect((await chart.boundingBox())!.height).toBe(beforeChart!.height);
      expect(await dateline.evaluate((node) => node.getBoundingClientRect().top + window.scrollY)).toBeCloseTo(beforePrice, 0);
    });
  }

  test("the close line connects Friday and Monday across a target-only Saturday", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.route("**/api/backend/research/AAPL/prices?**", (route) => route.fulfill({ json: {
      ticker: "AAPL", currency: "USD", points: [{ date: days[1], close: 100 }, { date: days[2], close: 120 }],
    } }));
    await page.goto("/research?ticker=AAPL&view=analyst");
    const chart = page.locator(".mx-target-chart");
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.getByRole("group", { name: /^Historical prices/ })).toHaveAttribute("data-tm-chart-ready", "true");
    // Only the closing-price stroke uses cobalt inside the middle of the historical plot.
    await expect.poll(() => chart.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => {
      const x = Math.floor(canvas.width * 0.4);
      const pixels = canvas.getContext("2d")!.getImageData(x, 0, 1, canvas.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 2] > pixels[i] + 80 && pixels[i + 3] > 100) return true;
      }
      return false;
    })).toBe(true);
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

  test("price, diagnosis and seasonality read as one page", async ({ page }) => {
    const seasonality: string[] = [];
    page.on("request", (request) => {
      if (/\/research\/AAPL\/lens\/technical\?.*detail=seasonality/.test(request.url())) seasonality.push(request.url());
    });
    await page.goto("/research?ticker=AAPL&view=technical&technicalView=seasonality");
    const index = page.getByRole("navigation", { name: "On this page" });
    await expect(index.getByRole("link")).toHaveText(["Price", "Technical diagnosis", "Seasonality"]);
    await expect(page.locator("#research-seasonality h2").first()).toBeFocused();
    await expect(page.locator("#research-seasonality")).toContainText("Monthly seasonality");
    expect(seasonality.length).toBeGreaterThan(0);
    await index.getByRole("link", { name: "Technical diagnosis" }).click();
    await expect(page.locator("#research-data h2").first()).toBeFocused();
    await expect(index.getByRole("link", { name: "Technical diagnosis" })).toHaveAttribute("aria-current", "location");
    await expect(page.getByRole("tab", { name: "Seasonality" })).toHaveCount(0);
  });

  test("financial sections read as one page and load every reported row on approach", async ({ page }) => {
    let full = 0;
    page.on("request", (request) => {
      if (/\/research\/AAPL\/lens\/fundamentals\?.*detail=full/.test(request.url())) full += 1;
    });
    await page.goto("/research?ticker=AAPL&view=fundamentals");
    const index = page.getByRole("navigation", { name: "On this page" });
    await expect(index.getByRole("link")).toHaveText([
      "Operating analysis", "Income", "Balance sheet", "Cash flow", "Segments", "Ownership & dividends", "All reported rows",
    ]);
    await expect(page.getByRole("region", { name: "Income statement" })).toBeAttached();
    await expect(page.getByRole("region", { name: "Balance sheet" })).toBeAttached();
    await expect(page.getByRole("region", { name: "Cash flow statement" })).toBeAttached();
    expect(full).toBe(0);
    await index.getByRole("link", { name: "All reported rows" }).click();
    await expect(page.locator("#research-full h2").first()).toBeFocused();
    await expect.poll(() => full).toBeGreaterThan(0);
    // A former mode link opens its section, with the shared reporting controls above.
    await page.goto("/research?ticker=AAPL&view=fundamentals&financialMode=cash&frequency=ttm");
    await expect(page.locator("#research-cash h2").first()).toBeFocused();
    await expect(index.getByRole("link", { name: "Cash flow" })).toHaveAttribute("aria-current", "location");
    await expect(page.getByRole("radiogroup", { name: "Reporting frequency" }).or(page.getByRole("group", { name: "Reporting frequency" })).first()).toBeAttached();
  });
});

test.describe("research section index", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test("a wide index floats over the reading until the reader pins it", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.goto("/research?ticker=AAPL&view=technical");
    const index = page.getByRole("navigation", { name: "On this page" });
    const toggle = page.getByRole("button", { name: "Sections on this page" });
    const pin = page.getByRole("button", { name: "Pin sections" });
    const reading = page.locator(".mx-reading-sections");
    if (isMobile) {
      // Phones keep the index as the sticky strip.
      await expect(index.getByRole("link", { name: "Seasonality" })).toBeVisible();
      await expect(toggle).toBeHidden();
      return;
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(index).toBeHidden();
    await expect(pin).toHaveCount(0);
    const width = (await reading.boundingBox())!.width;
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Floating: the reading keeps its width and the faint index sits above it.
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    expect((await reading.boundingBox())!.width).toBe(width);
    // Frosted glass: a translucent tint over the blurred reading.
    const glass = await page.locator(".mx-section-panel").evaluate((element) => {
      const style = getComputedStyle(element);
      return { tint: style.backgroundColor, blur: style.backdropFilter };
    });
    expect(glass.tint).toMatch(/\/ 0\.\d+\)$|^rgba\(/);
    expect(glass.blur).toContain("blur(");
    await toggle.evaluate((element) => (element as HTMLElement).blur());
    await page.mouse.move(10, 600);
    await expect.poll(() => index.evaluate((element) => getComputedStyle(element).opacity)).toBe("0.55");
    await index.getByRole("link", { name: "Seasonality" }).click();
    await expect(page.locator("#research-seasonality h2").first()).toBeFocused();
    await expect(index.getByRole("link", { name: "Seasonality" })).toHaveAttribute("aria-current", "location");
    // The floating index works from the keyboard too, and marks one place at a time.
    await index.getByRole("link", { name: "Technical diagnosis" }).press("Enter");
    await expect(page.locator("#research-data h2").first()).toBeFocused();
    await expect(index.getByRole("link", { name: "Technical diagnosis" })).toHaveAttribute("aria-current", "location");
    await expect(index.locator('[aria-current="location"]')).toHaveCount(1);
    // Pinned: the index takes its own column and the reading narrows.
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await reading.boundingBox())!.width).toBeLessThan(width);
    await index.getByRole("link", { name: "Price" }).click();
    await expect(page.locator("#research-price h2").first()).toBeFocused();
    await expect(index.getByRole("link", { name: "Price" })).toHaveAttribute("aria-current", "location");
    await expect(index.locator('[aria-current="location"]')).toHaveCount(1);
    await page.reload();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(index.getByRole("link", { name: "Seasonality" })).toBeVisible();
    await pin.click();
    await expect.poll(async () => (await reading.boundingBox())!.width).toBe(width);
  });
});
