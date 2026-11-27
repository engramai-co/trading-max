import { expect, test, type Page } from "@playwright/test";
import { portfolioRange } from "../lib/portfolio/history";
import { isPortfolioWeekendDisplayTimestamp } from "../lib/chart-domain";
import { historyPage, prepareHistory } from "../lib/portfolio/prepared";
import type { NavPoint } from "../lib/types";

// Complete ten-minute broker observations over the selected trading days.
// Market providers are not involved in this synthetic interaction fixture.
const start = Date.UTC(2026, 2, 6);
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
}).filter((point) => isPortfolioWeekendDisplayTimestamp(point.date));

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

test.describe("performance reading popup", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");

  test.beforeEach(async ({ page }) => {
    // Check steady-state hit testing rather than the range transition animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  });

  test("shows readings between sampled points on either linked chart", async ({ page, isMobile }) => {
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
      await expect(page.locator(".mx-data-body")).not.toHaveAttribute("aria-busy", "true");
      await expect(chart).toBeVisible();
      await chart.scrollIntoViewIfNeeded();
      const box = (await chart.boundingBox())!;
      // Range state renders before the deferred chart option is applied. Wait
      // for a reading from the requested range before testing continuous hover.
      await expect(async () => {
        await page.mouse.move(box.x + box.width * 0.5, box.y + 175);
        await expect(page.locator("[data-chart-reading]")).toHaveAttribute("data-chart-reading", "selected");
      }).toPass();
      const popup = chart.locator("xpath=..").locator(".mx-chart-popup");
      await expect(popup).toBeVisible();
      const card = (await popup.boundingBox())!;
      expect(card.x).toBeGreaterThanOrEqual(box.x);
      expect(card.x + card.width).toBeLessThanOrEqual(box.x + box.width + 1);
      // The card's top stays at the top of the plot wherever the pointer is vertically.
      await page.mouse.move(box.x + box.width * 0.5, box.y + 405);
      await expect.poll(async () => Math.round((await popup.boundingBox())!.y)).toBe(Math.round(card.y));
      expect(card.y).toBeLessThan(box.y + 60);
      await expect(page.locator(".mx-source-legend")).toHaveCount(0);
      for (let index = 0; index < 24; index++) {
        await page.mouse.move(box.x + 64 + (box.width - 76) * (index + 0.37) / 24, box.y + (index % 2 ? 405 : 175));
        await expect(page.locator("[data-chart-reading]"), `${range} hover sample ${index}`).toHaveAttribute("data-chart-reading", "selected");
      }
      await expect(page.locator("[data-chart-reading]")).toHaveAttribute("data-chart-reading", "selected");
    }
    await page.mouse.move(1, 1);
    await expect(page.locator("[data-chart-reading]")).toHaveAttribute("data-chart-reading", "latest");
    await expect(chart.locator("xpath=..").locator(".mx-chart-popup")).toBeHidden();
  });

  test("long currency figures wrap in the hover card and remain scrollable in the strip", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    const records = observations.slice(-288).map((point, index) => {
      const total = (index + 1) * 12_345_678_910_000_000_000_000;
      return { ...point, total, invest: total * 0.6, isa: total * 0.4 };
    });
    await mockHistory(page, records);
    await page.goto("/analytics?range=1D");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    await page.evaluate((top) => window.scrollBy(0, top - 260), (await chart.boundingBox())!.y);
    const widthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    const box = (await chart.boundingBox())!;
    if (isMobile) await page.touchscreen.tap(box.x + box.width * 0.7, box.y + 120);
    else await page.mouse.move(box.x + box.width * 0.7, box.y + 120);
    const reading = page.locator(isMobile ? ".mx-chart-strip .mx-reading" : ".mx-chart-popup .mx-reading");
    const primary = reading.locator(".mx-reading-value");
    await expect(primary).toHaveText(/£[\d,]{24,}\.00$/);
    const geometry = await primary.evaluate((figure) => {
      const range = document.createRange();
      range.selectNodeContents(figure);
      const card = figure.closest(".mx-reading")!.getBoundingClientRect();
      return {
        lines: [...range.getClientRects()].map(({ left, right }) => ({ left, right })),
        card: { left: card.left, right: card.right },
        overflow: figure.scrollWidth > figure.clientWidth + 1,
        whiteSpace: getComputedStyle(figure).whiteSpace,
      };
    });
    if (isMobile) {
      expect(geometry.lines).toHaveLength(1);
      expect(geometry.whiteSpace).toBe("nowrap");
      expect(geometry.overflow).toBe(true);
      expect(await primary.evaluate((figure) => { figure.scrollLeft = figure.scrollWidth; return figure.scrollLeft; })).toBeGreaterThan(0);
    } else {
      expect(geometry.lines.length).toBeGreaterThan(1);
      expect(geometry.overflow).toBe(false);
      expect(geometry.lines.every((line) => line.left >= geometry.card.left && line.right <= geometry.card.right)).toBe(true);
      const supportingValue = reading.locator(".mx-reading-row > dd").filter({ hasText: /£[\d,]{24,}/ }).first();
      await expect(supportingValue).toBeVisible();
      expect(await supportingValue.evaluate((value) => value.scrollWidth <= value.clientWidth + 1)).toBe(true);
      const swatch = reading.locator("i.mx-reading-key:not([data-dashed]):not([data-dotted]):not([data-kind])").first();
      const borders = await swatch.evaluate((line) => {
        const css = getComputedStyle(line);
        return [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth];
      });
      expect(borders).toEqual(["2px", "0px", "0px", "0px"]);
      expect((await swatch.boundingBox())!.height).toBe(2);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(widthBefore);
  });

  test("places the value keys between P&L and drawdown in GBP and percent", async ({ page, isMobile }) => {
    await mockHistory(page);
    if (isMobile) await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(`${isMobile ? "" : "/desktop"}/analytics?view=money`);
    const timeline = page.locator(".mx-money-timeline");
    const plot = timeline.locator("[data-tm-chart-ready=true]");
    const legend = timeline.locator(".mx-chart-legend");
    const drawdown = timeline.getByRole("heading", { name: "Max P&L drawdown" });
    await expect(plot).toBeVisible();
    await expect(page.locator(".mx-money-summary")).toContainText("Period net P&L");
    await expect(legend).toContainText("Account value");
    await expect(legend).toContainText("Cumulative net deposits");
    expect((await legend.boundingBox())!.y).toBeGreaterThan((await plot.boundingBox())!.y + 220);
    expect((await legend.boundingBox())!.y).toBeLessThan((await drawdown.boundingBox())!.y);
    await page.getByRole("button", { name: "% of opening value", exact: true }).click();
    await expect(legend).toContainText("Value change");
    await expect(legend).toContainText("Net deposit change");
    expect((await legend.boundingBox())!.y).toBeLessThan((await drawdown.boundingBox())!.y);
    await page.getByText("View exact observations", { exact: true }).click();
    const records = page.locator(".mx-chart-data table");
    await expect(records.locator("tbody tr")).toHaveCount(20);
    await expect(records.getByRole("columnheader", { name: "P&L drawdown", exact: true })).toBeVisible();
  });

  test("pins a tap as a reading strip above the narrow plot", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Touch interaction is verified on mobile.");
    await mockHistory(page);
    await page.goto("/analytics");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    // Bring the top of the tall money chart into view, below the panel heading.
    await page.evaluate((top) => window.scrollBy(0, top - 260), (await chart.boundingBox())!.y);
    const box = (await chart.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.7, box.y + 120);
    await expect(page.locator("[data-chart-reading]")).toHaveAttribute("data-chart-reading", "selected");
    // Phones read above the plot; nothing floats over the lines.
    await expect(chart.locator("xpath=..").locator(".mx-chart-popup")).toHaveCount(0);
    const strip = page.locator(".mx-chart-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Period net P&L");
    const bar = (await strip.boundingBox())!;
    const plot = (await chart.boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(plot.y + 1);
    expect(bar.x).toBeGreaterThanOrEqual(plot.x - 1);
    expect(bar.x + bar.width).toBeLessThanOrEqual(plot.x + plot.width + 1);
    expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const close = page.getByRole("button", { name: "Close reading" });
    const target = (await close.boundingBox())!;
    expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(strip).toBeHidden();
    await expect(page.locator("[data-chart-reading]")).toHaveAttribute("data-chart-reading", "latest");
    // Scrolled past the top of the tall chart, the strip docks under the top bar so it stays in view.
    await page.evaluate(() => window.scrollBy(0, 320));
    const lower = (await chart.boundingBox())!;
    await page.touchscreen.tap(lower.x + lower.width * 0.5, Math.max(lower.y, 0) + 360);
    await expect(strip).toHaveAttribute("data-docked", "");
    const docked = (await strip.boundingBox())!;
    expect(docked.y).toBeGreaterThanOrEqual(0);
    expect(docked.y + docked.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press("Escape");
    await expect(strip).toBeHidden();
  });

  test("shows no reading inside an unrecorded interval and resumes after the gap", async ({ page, isMobile }) => {
    test.skip(isMobile, "Gap hover is verified on desktop.");
    await mockHistory(page, observations.filter((point) => {
      const hour = new Date(Date.parse(point.date) + 3_600_000).getUTCHours();
      return hour < 9 || hour >= 16;
    }));
    await page.goto("/analytics?range=1D");
    await expect(page.getByRole("button", { name: "1D", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mx-data-body")).not.toHaveAttribute("aria-busy", "true");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await expect(page.locator(".mx-source-legend")).toHaveText("Missing");
    for (const [position, visible] of [[0.3, true], [0.55, false], [0.8, true]] as const) {
      await page.mouse.move(box.x + 64 + (box.width - 76) * position, box.y + 175);
      await expect(page.locator("[data-chart-reading]")).toHaveAttribute("data-chart-reading", visible ? "selected" : "latest");
      // Inside the gap the card keeps only its title: no data, and the interval it spans.
      if (!visible) await expect(chart.locator("xpath=..").locator(".mx-chart-popup")).toContainText("No data");
    }
  });
});
