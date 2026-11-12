import { expect, test, type Page } from "@playwright/test";
import { portfolioRange } from "../lib/portfolio/history";
import { historyPage, prepareHistory } from "../lib/portfolio/prepared";
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

async function mockHistory(page: Page, intradayNav = observations) {
  const runId = "synthetic-tooltip";
  const health = { service: "trading_max-api", status: "ok", latestRunId: runId, queue: { running: 0, queued: 0 }, worker: { healthy: true } };
  const fixture = { runId, dataRevision: "synthetic", brokerAsOf: observations.at(-1)!.date, nav: [], intradayNav };
  await page.route("**/api/backend/**", (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname.endsWith("/dashboard/history")) {
      const range = portfolioRange(searchParams.get("range"));
      const prepared = prepareHistory(fixture, { range, scope: "total" });
      const pageNumber = searchParams.get("page");
      return route.fulfill({ json: pageNumber ? historyPage(prepared, Number(pageNumber)) : prepared.chart });
    }
    return route.fulfill({ json: pathname.endsWith("/dashboard/lens/analytics") ? { runId, brokerAsOf: fixture.brokerAsOf }
      : pathname.endsWith("/health") ? health
        : pathname.endsWith("/health/details") ? { health, readiness: { status: "ready" }, jobs: [], errors: [] }
          : pathname.endsWith("/profile") ? { accountLabels: { A: "Invest", B: "Stocks ISA" } } : {} });
  });
}

test.describe("performance tooltip", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");

  test.beforeEach(async ({ page }) => {
    // Check steady-state hit testing rather than the range transition animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  });

  test("stays visible between sampled points on either linked chart", async ({ page, isMobile }) => {
    test.skip(isMobile, "Continuous mouse hover is verified on desktop.");
    test.setTimeout(45_000);
    // One missed collection inside each two-hour period must not punch holes
    // in populated 30min/1h/2h/4h display buckets or fabricate hover values.
    await mockHistory(page, observations.filter((point) => {
      const time = new Date(point.date);
      return time.getUTCMinutes() !== 20 || time.getUTCHours() % 2 !== 0;
    }));
    await page.goto("/analytics");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    for (const range of ["5D", "1M", "3M", "6M"]) {
      await page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: range, exact: true }).click();
      await page.mouse.move(1, 1);
      await chart.scrollIntoViewIfNeeded();
      await expect(page.locator(".mx-data-body")).not.toHaveAttribute("aria-busy", "true");
      const box = (await chart.boundingBox())!;
      // Range state renders before the deferred chart option is applied. Wait
      // for a reading from the requested range before testing continuous hover.
      await expect(async () => {
        await page.mouse.move(box.x + box.width * 0.5, box.y + 175);
        await expect(page.locator(".mx-chart-tooltip__header")).toContainText(range);
      }).toPass();
      await expect(page.locator(".mx-source-legend")).toHaveCount(0);
      for (let index = 0; index < 24; index++) {
        await page.mouse.move(box.x + 64 + (box.width - 76) * (index + 0.37) / 24, box.y + (index % 2 ? 405 : 175));
        // Wait longer than the chart's hide delay: a brief show followed by a
        // hide between buckets is the regression this test must catch.
        await page.waitForTimeout(160);
        expect(await page.locator(".mx-chart-tooltip").isVisible(), `${range} hover sample ${index}`).toBe(true);
      }
      await expect(page.locator(".mx-chart-tooltip__header")).toContainText(range);
    }
    await page.mouse.move(1, 1);
    await expect(page.locator(".mx-chart-tooltip")).toBeHidden();
  });

  test("places the value keys between P&L and drawdown in GBP and percent", async ({ page, isMobile }) => {
    await mockHistory(page);
    if (isMobile) await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(`${isMobile ? "" : "/desktop"}/analytics?view=money`);
    const timeline = page.locator(".mx-money-timeline");
    const plot = timeline.locator("[data-tm-chart-ready=true]");
    const legend = timeline.locator(".mx-chart-legend");
    const drawdown = timeline.getByRole("heading", { name: "Maximum P&L drawdown" });
    await expect(plot).toBeVisible();
    await expect(page.locator(".mx-money-summary")).toContainText("Period net P&L");
    await expect(legend).toContainText("Account value");
    await expect(legend).toContainText("Cumulative net contributions");
    expect((await legend.boundingBox())!.y).toBeGreaterThan((await plot.boundingBox())!.y + 220);
    expect((await legend.boundingBox())!.y).toBeLessThan((await drawdown.boundingBox())!.y);
    await page.getByRole("button", { name: "% of opening value", exact: true }).click();
    await expect(legend).toContainText("Value change");
    await expect(legend).toContainText("Contribution change");
    expect((await legend.boundingBox())!.y).toBeLessThan((await drawdown.boundingBox())!.y);
    await page.getByText("View exact observations", { exact: true }).click();
    const records = page.locator(".mx-chart-data table");
    await expect(records.locator("tbody tr")).toHaveCount(20);
    await expect(records.getByRole("columnheader", { name: "P&L drawdown", exact: true })).toBeVisible();
  });

  test("keeps the tapped card inside a narrow chart", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Touch interaction is verified on mobile.");
    await mockHistory(page);
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
    await mockHistory(page, observations.filter((point) => {
      const hour = new Date(Date.parse(point.date) + 3_600_000).getUTCHours();
      return hour < 9 || hour >= 16;
    }));
    await page.goto("/analytics");
    await page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: "1D", exact: true }).click();
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await expect(page.locator(".mx-source-legend")).toHaveText("Missing");
    for (const [position, visible] of [[0.3, true], [0.55, false], [0.8, true]] as const) {
      await page.mouse.move(box.x + 64 + (box.width - 76) * position, box.y + 175);
      await expect(page.locator(".mx-chart-tooltip")).toBeVisible({ visible });
    }
  });
});
