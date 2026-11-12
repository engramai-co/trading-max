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
    let start!: () => void;
    const firstAnalytics = new Promise<void>((resolve) => { start = resolve; });
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
    const benchmark = page.getByRole("combobox", { name: "Comparison benchmark" });
    await expect(benchmark).toHaveValue("S&P 500 · VOO");
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
    await expect(page.getByText("Selected benchmark lacks shared records")).toBeVisible();
    await expect(chart).toBeVisible();
    await expect(comparison.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator(".mx-comparison-basis")).toHaveCount(0);
    qqqReady = true;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(comparison.getByRole("rowheader", { name: "QQQ" })).toBeVisible();
    await expect(page.getByText("Selected benchmark lacks shared records")).toHaveCount(0);

    const monthly = page.locator(".mx-monthly-returns");
    await expect(monthly.locator("table")).toHaveCount(0);
    await monthly.getByText("Monthly returns (TWR)", { exact: true }).press("Enter");
    await expect(monthly.locator("table")).toHaveCount(1);
    await expect(monthly).toHaveAttribute("open", "");
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
    await expect(page.getByRole("combobox", { name: "Comparison benchmark" })).toHaveValue("S&P 500 · VOO");
    await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
    await page.getByRole("tab", { name: "Risk profile" }).click();
    await expect(page.locator(".mx-risk-basis")).toContainText("All available history");
    await expect(page.locator(".mx-performance-risk [data-tm-chart-ready=true]")).toBeVisible();
  });
});
