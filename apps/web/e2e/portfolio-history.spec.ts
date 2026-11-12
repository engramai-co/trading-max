import { expect, test, type Locator } from "@playwright/test";
import { historyPage, prepareHistory } from "../lib/portfolio/prepared";
import { PORTFOLIO_RANGES } from "../lib/portfolio/history";
import type { NavPoint } from "../lib/types";
import { chooseRange, selectedRange } from "./dashboard-ranges";

const intraday: NavPoint[] = ([
  ["2026-09-18T09:00:00Z", 100, 90],
  ["2026-09-18T09:10:00Z", 180, 170],
  ["2026-09-18T09:30:00Z", 190, 170],
  ["2026-09-18T09:40:00Z", 500, null],
] as const).map(([date, value, flows]) => ({
  date, total: value * 3, household: value * 3, invest: value * 2, isa: value, cfd: null,
  flowStatus: flows == null ? "unverified" : "verified",
  investTwr: null, isaTwr: null, totalTwr: null,
  investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null,
  totalNetContributionsGbp: flows == null ? null : flows * 3,
  investNetContributionsGbp: flows == null ? null : flows * 2,
  isaNetContributionsGbp: flows,
  intraday: true, valuationSource: "broker", cadenceSeconds: 600,
}));
const nav = intraday.slice(0, 3).map((point, i): NavPoint => ({
  ...point, date: ["2026-01-02", "2026-06-18", "2026-09-18"][i], intraday: false, flowStatus: "daily_official",
}));
const fixture = {
  runId: "synthetic-overview-alignment", dataRevision: "synthetic", brokerAsOf: intraday.at(-1)!.date,
  totalValueGbp: 1500, nav, intradayNav: intraday, holdings: [],
  accounts: [
    { code: "A", isInvestable: true, totalValueGbp: 1000 },
    { code: "B", isInvestable: true, totalValueGbp: 500 },
  ],
};

async function observations(disclosure: Locator) {
  await disclosure.getByText("View exact observations", { exact: true }).click();
  const table = disclosure.getByRole("table");
  await expect(table).toBeVisible();
  const headings = await table.getByRole("columnheader").allTextContents();
  const columns = ["Date", "Account value", "Period P&L"].map((label) => headings.indexOf(label));
  expect(columns.every((index) => index !== -1)).toBe(true);
  return table.locator("tbody tr").evaluateAll((rows, indexes) => rows.map((row) =>
    indexes.map((index) => row.children[index].textContent)), columns);
}

test.describe("overview to performance", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("trading_max-locale", "en");
      localStorage.setItem("trading_max-overview-range", "6M");
    });
    await page.route("**/api/backend/**", (route) => {
      const { pathname, searchParams } = new URL(route.request().url());
      if (pathname.endsWith("/dashboard/history")) {
        const range = PORTFOLIO_RANGES.find((value) => value === searchParams.get("range"));
        const scope = searchParams.get("scope");
        if (!range || (scope !== "invest" && scope !== "isa" && scope !== "total") || searchParams.get("runId") !== fixture.runId) {
          return route.fulfill({ status: 400, json: {} });
        }
        const prepared = prepareHistory(fixture, { range, scope });
        const page = searchParams.get("page");
        return route.fulfill({ json: page ? historyPage(prepared, Number(page)) : prepared.chart });
      }
      const json = pathname.includes("/dashboard/lens/") ? fixture
        : pathname.endsWith("/health") ? { service: "trading_max-api", status: "ok", latestRunId: fixture.runId }
          : pathname.endsWith("/profile") ? { accountLabels: { A: "Invest", B: "Stocks ISA" } } : {};
      return route.fulfill({ json });
    });
  });

  for (const range of ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"]) {
    test(`${range} shows cash-flow-adjusted P&L and preserves account, range and cutoff`, async ({ page, isMobile }) => {
      const short = ["1D", "1W", "1M", "3M"].includes(range);
      const rangeLabel = range === "1W" ? "5D" : range === "ALL" ? "All" : range;
      // Overview also reads 1D for its Today figure; observe the selected period.
      const historyRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith("/dashboard/history") && url.searchParams.get("range") === range;
      });
      await page.goto(`/?scope=isa&range=${range}`);
      const requested = new URL((await historyRequest).url());
      expect(requested.searchParams.get("range")).toBe(range);
      expect(requested.searchParams.get("scope")).toBe("isa");
      expect(requested.searchParams.get("runId")).toBe(fixture.runId);
      const overview = page.locator(".mx-overview-history");
      await expect(overview.locator("[data-tm-chart-ready=true]")).toBeVisible();
      await selectedRange(overview.locator(".mx-dashboard-ranges"), rangeLabel, isMobile);
      await expect(overview.getByRole("heading", { name: "Period P&L", exact: true })).toBeVisible();
      await expect(overview).not.toContainText("Cumulative net contributions");
      await expect(overview).not.toContainText("Some periods have no observations");
      await expect(overview.locator(".mx-period-figure")).toContainText("£10.00");
      await expect(overview.locator(".mx-freshness")).toContainText("Cash flows pending");
      await expect(overview.locator(".mx-chart-data, .mx-source-legend, .mx-tag-help")).toHaveCount(0);
      if (range === "1D") {
        await overview.locator(".mx-info").click();
        await expect(page.getByText(/Dashed lines show estimates reconstructed/)).toBeVisible();
        await page.keyboard.press("Escape");
      }
      const coverage = await overview.locator(".mx-history-coverage").allTextContents();
      await overview.getByRole("link", { name: "View performance" }).click();
      await expect(page).toHaveURL(new RegExp(`view=money&range=${range}&scope=isa`));
      await expect(page.getByRole("combobox", { name: "Analysis account" })).toHaveValue("Stocks\u00a0ISA");
      await selectedRange(page.locator(".mx-chart-toolbar .mx-dashboard-ranges"), rangeLabel, isMobile);
      await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
      const exact = await observations(page.locator(".mx-chart-data").first());
      expect(exact.at(-1)).toEqual([intraday[2].date, "£190.00", "£10.00"]);
      if (short) expect(exact.map((row) => row.at(-1))).toEqual(["£0.00", "£0.00", "£10.00"]);
      expect(await page.locator(".mx-history-coverage").allTextContents()).toEqual(coverage);
      await expect(page.getByText("Some periods have no observations", { exact: true })).toHaveCount(0);
      await expect(page.locator(".mx-money-summary")).toContainText("£10.00");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`scope=isa&range=${range}`));
      await selectedRange(overview.locator(".mx-dashboard-ranges"), rangeLabel, isMobile);
    });
  }
  test("bare overview and its home links always start on 1D", async ({ page, isMobile }) => {
    const overview = page.locator(".mx-overview-history");
    const control = overview.locator(".mx-dashboard-ranges");
    const activeRange = (range: string) => selectedRange(control, range, isMobile);
    await page.goto("/");
    await activeRange("1D");
    await chooseRange(overview.locator(".mx-dashboard-ranges"), "6M", isMobile);
    await activeRange("6M");
    await overview.getByRole("link", { name: "View performance" }).click();
    await expect(page).toHaveURL(/view=money&range=6M/);
    const home = page.getByRole("link", { name: isMobile ? "Home" : "Overview", exact: true });
    await expect(home).toHaveAttribute("href", "/");
    await home.click();
    await expect(page).toHaveURL(/\/$/);
    await activeRange("1D");
  });
  test("range changes survive reload and invalid links use the default", async ({ page, isMobile }) => {
    await page.goto("/?scope=invest&range=invalid");
    const overview = page.locator(".mx-overview-history");
    await selectedRange(overview.locator(".mx-dashboard-ranges"), "1D", isMobile);
    await chooseRange(overview.locator(".mx-dashboard-ranges"), "6M", isMobile);
    await page.reload();
    await selectedRange(overview.locator(".mx-dashboard-ranges"), "6M", isMobile);
    await overview.getByRole("link", { name: "View performance" }).click();
    await chooseRange(page.locator(".mx-chart-toolbar .mx-dashboard-ranges"), "1M", isMobile);
    await page.reload();
    await selectedRange(page.locator(".mx-chart-toolbar .mx-dashboard-ranges"), "1M", isMobile);
    await expect(page.getByRole("combobox", { name: "Analysis account" })).toHaveValue("Invest");
  });
});
