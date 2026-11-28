import { expect, test } from "@playwright/test";
import { prepareHistory } from "../lib/portfolio/prepared";
import type { DashboardLens, NavPoint } from "../lib/types";
import { portfolioRange } from "../lib/portfolio/history";

const dates = ["2026-01-02", "2026-06-02", "2026-08-26", "2026-09-01", "2026-09-08"];
const nav: NavPoint[] = dates.map((date, i) => ({
  date, total: 2000 + 100 * i, invest: 1000 + 100 * i, isa: 1000 + 100 * i,
  totalNetContributionsGbp: 2000, investNetContributionsGbp: 1000, isaNetContributionsGbp: 1000,
  investTwr: null, investDrawdown: null, household: null, cfd: null, cfdProxyDrawdown: null,
  totalTwr: [0.2, -0.1, 0.01, 0.02, 0.05][i],
  isaTwr: [0.2, -0.1, 0.01, 0.02, 0.05][i],
  totalDrawdown: [0, -0.25, -0.1583, -0.15, -0.125][i],
  isaDrawdown: [0, -0.25, -0.1583, -0.15, -0.125][i],
  flowStatus: "daily_official", intraday: false, valuationSource: "broker",
}));
const firstRun = "synthetic-dash-before";
const nextRun = "synthetic-dash-after";
const brokerAsOf = "2026-09-08T15:00:00Z";
const profile = { accountLabels: {} };
const health = (runId: string) => ({ service: "trading_max-api", status: "ok", latestRunId: runId });
const supportingData = (path: string, runId: string) =>
  path.endsWith("/health") ? health(runId) : path.endsWith("/profile") ? profile : {};
const fixture = (runId: string, benchmark: DashboardLens["benchmarkSeries"] = {}) => ({
  runId, brokerAsOf, dataRevision: runId, benchmarkSeries: benchmark,
  nav: runId === firstRun ? nav : nav.map((point, i) => ({ ...point, isa: 1000 + 150 * i })),
});

test.describe("dashboard readings", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  });

  test("uses one shared VOO interval, restores a missing comparison, and opens monthly returns by keyboard", async ({ page }) => {
    let qqqReady = false;
    let reads = 0;
    const { promise: firstAnalytics, resolve: start } = Promise.withResolvers<void>();
    await page.route("**/api/backend/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/dashboard/lens/analytics")) {
        if (++reads === 1) await firstAnalytics;
        return route.fulfill({ json: fixture(firstRun, {
          VOO: [{ date: dates[3], close: 100 }, { date: dates[4], close: 101 }],
          QQQ: qqqReady ? [{ date: dates[2], close: 100 }, { date: dates[4], close: 102 }] : [],
        }) });
      }
      return route.fulfill({ json: supportingData(path, firstRun) });
    });
    await page.goto("/analytics?view=returns&range=1M");
    const benchmark = page.getByRole("combobox", { name: "Benchmark" });
    await expect(benchmark).toHaveText("S&P 500 · VOO");
    await expect(page.getByRole("group", { name: "Performance range" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading 1M records…" })).toBeVisible();
    await expect(page.locator("[data-tm-chart-ready=true]")).toHaveCount(0);
    start();

    const comparison = page.getByRole("region", { name: "Return and drawdown comparison" });
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await expect(comparison.locator("tbody tr")).toHaveCount(2);
    await expect(comparison.getByRole("rowheader", { name: "VOO" })).toBeVisible();
    await expect(page.locator(".mx-comparison-basis")).toHaveText(/Shared dates.*1 Sept? – 8 Sept?/);
    await expect(page.locator(".mx-return-comparator")).toContainText("+1.94 pp");
    await expect(page.locator(".mx-chart-legend svg path[stroke-dasharray]")).toHaveCount(1);

    await benchmark.click();
    await page.getByRole("option", { name: "Nasdaq 100 · QQQ" }).click();
    await expect(page.locator(".mx-retry-reading").getByText("Selected benchmark lacks shared records").and(page.locator(":not(.sr-only)"))).toBeVisible();
    await expect(chart).toBeVisible();
    await expect(comparison.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator(".mx-comparison-basis")).toHaveCount(0);
    qqqReady = true;
    await expect(page.getByRole("status").filter({ hasText: "Selected benchmark lacks shared records" })).toHaveCount(1);
    await page.getByRole("button", { name: "Retry: Selected benchmark lacks shared records", exact: true }).click();
    await expect(comparison.getByRole("rowheader", { name: "QQQ" })).toBeVisible();
    await expect(page.locator(".mx-retry-reading")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Shared benchmark records are available again." })).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: "Selected benchmark lacks shared records" })).toHaveCount(0);

    const monthly = page.locator(".mx-monthly-returns");
    const toggle = monthly.getByRole("button", { name: "Periodic returns (TWR)" });
    await expect(monthly.locator("table")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.press("Enter");
    await expect(monthly.locator("table")).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle.locator("svg")).toHaveCount(1);
    await toggle.press("Space");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(monthly.locator("table")).toHaveCount(0);
  });

  test("a keyboard TWR drill-down focuses the chart and Restore returns to the period cell", async ({ page, isMobile }) => {
    const monthDates = ["2025-12-31", "2026-01-30", "2026-02-27", "2026-03-12"];
    const sample = monthDates.map((date, index) => ({ ...nav[index], date, totalTwr: [0, 0.2, 0.08, 0.134][index] }));
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const projection = { ...fixture(firstRun), brokerAsOf: "2026-03-12T17:00:00Z", nav: sample };
      return route.fulfill({ json: path.endsWith("/dashboard/lens/analytics") ? projection : supportingData(path, firstRun) });
    });
    await page.goto("/analytics?view=returns&range=3M");
    const grid = page.locator(".mx-monthly-returns");
    await grid.getByRole("button", { name: "Periodic returns (TWR)" }).click();
    if (isMobile) {
      const year = grid.getByRole("combobox", { name: "Year" });
      await expect(year).toHaveText("2026");
      await expect(grid.getByRole("rowheader", { name: "2026" })).toHaveClass("sr-only");
      await year.press("Space");
      await page.keyboard.press("Escape");
      await expect(year).toBeFocused();
      await year.click();
      await page.getByRole("option", { name: "2025" }).click();
      await expect(grid.getByRole("rowheader", { name: "2025" })).toHaveCount(1);
      await year.click();
      await page.getByRole("option", { name: "2026" }).click();
    }
    const periods = grid.getByRole("group", { name: "Return period" });
    const month = periods.getByRole("button", { name: "Month", exact: true });
    await month.press("ArrowRight");
    const quarter = periods.getByRole("button", { name: "Quarter", exact: true });
    await expect(quarter).toBeFocused();
    await quarter.press("Space");
    const cell = grid.getByRole("button", { name: /2026-Q1 · \+8.00%.*Partial coverage/ });
    await cell.press("Enter");
    await expect(page).toHaveURL(/returnFrom=2025-12-31&returnTo=2026-02-27/);
    const toolbar = page.getByRole("group", { name: "Return comparison", exact: true });
    await expect(toolbar).toBeFocused();
    await expect(toolbar).toBeInViewport();
    await expect(toolbar.locator(".mx-period-control")).toContainText(/31 Dec.*27 Feb/);
    await page.keyboard.press("Tab");
    await expect(toolbar.getByRole("combobox", { name: "Benchmark" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cell).toHaveAttribute("aria-pressed", "true");
    const range = toolbar.getByRole("group", { name: "Performance range" });
    await expect(range.getByRole("button", { pressed: true })).toHaveCount(0);
    if (isMobile) await expect(toolbar.getByRole("button", { name: "More periods", exact: true })).toBeVisible();
    await expect(page.locator(".mx-chart-readout-latest")).toContainText("+8.00%");
    const restore = toolbar.getByRole("button", { name: "Restore previous range" });
    await restore.press("Enter");
    await expect(page).toHaveURL(/range=3M$/);
    await expect(range.getByRole("button", { name: "3M", pressed: true })).toBeVisible();
    await expect(cell).toBeFocused();
    await expect(cell).toBeInViewport();

    await cell.click();
    await expect(cell).toHaveAttribute("aria-pressed", "true");
    await restore.press("Enter");
    await expect(cell).toBeFocused({ timeout: 3000 });
    await expect(cell).toBeInViewport();
  });

  test("English phone Money keeps the chart units label and switch on one row", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Phone toolbar geometry.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/analytics?view=money");
    const toolbar = page.locator(".mx-chart-toolbar");
    const label = toolbar.getByText("Chart units", { exact: true });
    const switcher = toolbar.getByRole("group", { name: "Chart units" });
    await expect(label).toBeVisible();
    await expect(switcher).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const labelBox = (await label.boundingBox())!;
    const switchBox = (await switcher.boundingBox())!;
    expect(switchBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width);
    expect(Math.abs(labelBox.y + labelBox.height / 2 - switchBox.y - switchBox.height / 2)).toBeLessThan(1);
    expect(Math.abs(switchBox.height - 44)).toBeLessThan(1);
  });

  test("periodic returns loads on disclosure and can recover from a failed read to an empty grid", async ({ page }) => {
    let fail = true;
    const allHistory = "**/dashboard/lens/analytics?**range=ALL**";
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith("/dashboard/lens/analytics") ? fixture(firstRun) : supportingData(path, firstRun) });
    });
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    await page.route(allHistory, async (route) => {
      await held;
      return fail ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { ...fixture(firstRun), nav: [] } });
    });
    await page.goto("/analytics?view=returns&range=3M");
    const grid = page.locator(".mx-monthly-returns");
    const toggle = grid.getByRole("button", { name: "Periodic returns (TWR)" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.press("Enter");
    try {
      await expect(grid.getByRole("status").filter({ hasText: "Loading data…" })).toBeVisible();
    } finally {
      release();
    }
    const retry = grid.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    fail = false;
    await retry.click();
    await expect(grid.getByText("More daily return observations are needed")).toBeVisible();
    await expect(grid.getByRole("table")).toHaveCount(0);
  });

  test("drawdown duration counts calendar dates and preserves elapsed-day and gap readings", async ({ page }) => {
    const cases = [
      { dates: ["2026-10-24", "2026-10-25", "2026-10-26"], depth: [0, -0.25, 0], text: "2 days" },
      { dates: ["2026-10-24T14:00:00+01:00", "2026-10-25T14:00:00+00:00", "2026-10-26T14:00:00+00:00"], depth: [0, -0.25, 0], text: "3 days" },
      { dates: ["2026-10-24", "2026-10-25", "2026-10-26"], depth: [0, -0.25, null], text: "Recovery unverified across a gap" },
    ];
    let scenario = cases[0];
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = { ...fixture(firstRun), nav: scenario.dates.map((date, index) => ({ ...nav[index], date, totalDrawdown: scenario.depth[index] })) };
      return route.fulfill({ json: path.endsWith("/dashboard/lens/analytics") ? data : supportingData(path, firstRun) });
    });
    for (scenario of cases) {
      await page.goto("/analytics?view=risk");
      await expect(page.locator(".mx-drawdown-reading")).toContainText(scenario.text);
    }
  });

  test("takes the selected account to risk and requests all history", async ({ page }) => {
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith("/dashboard/lens/analytics") ? fixture(firstRun) : supportingData(path, firstRun) });
    });
    await page.goto("/analytics?view=returns&range=1M&scope=isa");
    await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
    const request = page.waitForRequest((event) => {
      const url = new URL(event.url());
      return url.pathname.endsWith("/dashboard/lens/analytics") && url.searchParams.get("range") === "ALL";
    });
    await page.getByRole("tab", { name: "Risk profile" }).click();
    expect(new URL((await request).url()).searchParams.get("scope")).toBe("isa");
    await expect(page.locator(".mx-risk-basis")).toContainText("All available history");
    await expect(page.locator(".mx-risk-readings")).toContainText("-25.00%");
    await expect(page.locator(".mx-risk-drawdown-episode time").first()).toHaveAttribute("datetime", dates[0]);
    await expect(page.locator(".mx-risk-drawdown-episode time").last()).toHaveAttribute("datetime", dates[1]);
    await expect(page.getByRole("group", { name: "Performance range" })).toHaveCount(0);
  });

  test("retains reconciled amounts and the chart when a new P&L history fails", async ({ page }) => {
    let published = firstRun;
    let failHistory = true;
    await page.clock.setFixedTime(new Date(brokerAsOf));
    await page.route("**/api/backend/**", (route) => {
      const { pathname, searchParams } = new URL(route.request().url());
      if (pathname.endsWith("/dashboard/history")) {
        const run = searchParams.get("runId")!;
        if (run === nextRun && failHistory) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: prepareHistory(fixture(run), { range: portfolioRange(searchParams.get("range")), scope: "isa" }).chart });
      }
      const json = pathname.endsWith("/dashboard/lens/analytics") ? fixture(published)
        : supportingData(pathname, published);
      return route.fulfill({ json });
    });
    await page.goto("/analytics?range=ALL&scope=isa");
    const summary = page.locator(".mx-money-summary");
    const chart = page.locator("[data-tm-chart-ready=true]").first();
    await expect(chart).toBeVisible();
    await expect(summary.locator("dd")).toHaveText(["£1,000.00", "+ £0.00", "+ £400.00", "= £1,400.00"]);

    published = nextRun;
    await page.clock.setFixedTime(new Date(Date.parse(brokerAsOf) + 15_000));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const retry = page.locator(".mx-money-history-failure").getByRole("button", { name: /Update failed.*Retry/ });
    await expect(retry).toBeVisible();
    await expect(summary.locator("dd").last()).toHaveText("= £1,400.00");
    await expect(chart).toBeVisible();

    failHistory = false;
    await retry.click();
    await expect(summary.locator("dd").last()).toHaveText("= £1,600.00");
    await expect(chart).toBeVisible();
    await expect(retry).toHaveCount(0);
  });

  test("the desktop preview loads the dashboard and performance views", async ({ page }) => {
    const demo = process.env.DESKTOP_DEMO_QA_URL;
    test.skip(!demo?.startsWith("http://127.0.0.1:"), "Requires an isolated desktop preview.");
    await page.goto(new URL("/desktop", demo).href);
    await expect(page.locator(".mx-overview-portfolio time.mx-freshness")).toBeVisible();
    await expect(page.locator(".mx-overview-history [data-tm-chart-ready=true]")).toBeVisible();
    await page.goto(new URL("/desktop/analytics?view=returns", demo).href);
    await expect(page.getByRole("combobox", { name: "Benchmark", exact: true })).toHaveText("S&P 500 · VOO");
    await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
    await page.getByRole("tab", { name: "Risk profile" }).click();
    await expect(page.locator(".mx-risk-basis")).toContainText("All available history");
    await expect(page.locator(".mx-performance-risk [data-tm-chart-ready=true]")).toBeVisible();
  });
});
