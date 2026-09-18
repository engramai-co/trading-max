import { expect, test } from "@playwright/test";
import type { NavPoint } from "../lib/types";

// Complete ten-minute broker observations over the selected trading days.
// Market providers are not involved in this synthetic interaction fixture.
const start = Date.UTC(2026, 2, 6);
const londonWeekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
// End at 23:50 London time, so the final day has no intentional future gap.
const observations = Array.from({ length: 187 * 144 - 6 }, (_, index): NavPoint => {
  const time = start + index * 600_000;
  const value = 10_000 + index + Math.sin(index / 8) * 120;
  return {
    date: new Date(time).toISOString(),
    total: value, invest: value * 0.6, isa: value * 0.4,
    intraday: true, valuationSource: "broker", cadenceSeconds: 600,
    flowStatus: "verified", cfd: null, household: null,
    totalNetContributionsGbp: 10_000, investNetContributionsGbp: 6_000, isaNetContributionsGbp: 4_000,
    investTwr: null, isaTwr: null, totalTwr: null,
    investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null,
  };
}).filter((point) => {
  const weekday = londonWeekday.format(new Date(point.date));
  return weekday !== "Sun" && weekday !== "Sat";
});

test.describe("performance tooltip", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");

  test.beforeEach(async ({ page }) => {
    // Check steady-state hit testing rather than the range transition animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith("/dashboard/lens/analytics") ? {
        runId: "synthetic-tooltip", brokerAsOf: observations.at(-1)!.date,
        nav: [], intradayNav: observations,
      } : path.endsWith("/profile") ? { accountLabels: { A: "Invest", B: "Stocks ISA" } } : {} });
    });
  });

  test("stays visible between sampled points on either linked chart", async ({ page, isMobile }) => {
    test.skip(isMobile, "Continuous mouse hover is verified on desktop.");
    test.setTimeout(45_000);
    // One missed collection inside each two-hour period must not punch holes
    // in populated 30min/1h/2h/4h display buckets or fabricate hover values.
    await page.route("**/api/backend/dashboard/lens/analytics", (route) => route.fulfill({ json: {
      runId: "synthetic-tooltip-short-gaps", brokerAsOf: observations.at(-1)!.date,
      nav: [], intradayNav: observations.filter((point) => {
        const time = new Date(point.date);
        return time.getUTCMinutes() !== 20 || time.getUTCHours() % 2 !== 0;
      }),
    } }));
    await page.goto("/analytics");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    for (const range of ["5D", "1M", "3M", "6M"]) {
      await page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: range, exact: true }).click();
      await chart.scrollIntoViewIfNeeded();
      const box = (await chart.boundingBox())!;
      // Range state renders before the deferred chart option is applied. Wait
      // for a reading from the requested range before testing continuous hover.
      await expect(async () => {
        await page.mouse.move(box.x + box.width * 0.5, box.y + 175);
        await expect(page.locator(".mx-chart-tooltip__header")).toContainText(range);
      }).toPass();
      for (let index = 0; index < 24; index++) {
        await page.mouse.move(box.x + 64 + (box.width - 76) * (index + 0.37) / 24, box.y + (index % 2 ? 330 : 175));
        // Wait longer than the chart's hide delay: a brief show followed by a
        // hide between buckets is the regression this test must catch.
        await page.waitForTimeout(160);
        expect(await page.locator(".mx-chart-tooltip").isVisible(), `${range} hover sample ${index}`).toBe(true);
      }
      await expect(page.locator(".mx-chart-tooltip__header")).toContainText(range);
    }
    await page.mouse.move(230, 160);
    await expect(page.locator(".mx-chart-tooltip")).toBeHidden();
  });

  test("keeps the tapped card inside a narrow chart", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Touch interaction is verified on mobile.");
    await page.goto("/analytics");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.7, box.y + 175);
    const tooltip = page.locator(".mx-chart-tooltip");
    await expect(tooltip).toBeVisible();
    const card = (await tooltip.boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(box.x);
    expect(card.x + card.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(await tooltip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("shows no reading inside an unrecorded interval and resumes after the gap", async ({ page, isMobile }) => {
    test.skip(isMobile, "Gap hover is verified on desktop.");
    await page.route("**/api/backend/dashboard/lens/analytics", (route) => route.fulfill({ json: {
      runId: "synthetic-tooltip-gap", brokerAsOf: observations.at(-1)!.date,
      nav: [], intradayNav: observations.filter((point) => {
        const hour = new Date(Date.parse(point.date) + 3_600_000).getUTCHours();
        return hour < 9 || hour >= 16;
      }),
    } }));
    await page.goto("/analytics");
    await page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: "1D", exact: true }).click();
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    for (const [position, visible] of [[0.3, true], [0.55, false], [0.8, true]] as const) {
      await page.mouse.move(box.x + 64 + (box.width - 76) * position, box.y + 175);
      await expect(page.locator(".mx-chart-tooltip")).toBeVisible({ visible });
    }
  });
});
