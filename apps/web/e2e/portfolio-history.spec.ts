import { expect, test, type Locator } from "@playwright/test";
import { historyPage, prepareHistory } from "../lib/portfolio/prepared";
import { PORTFOLIO_RANGES } from "../lib/portfolio/history";
import type { NavPoint } from "../lib/types";

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
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/**", (route) => {
      const { pathname, searchParams } = new URL(route.request().url());
      if (pathname.endsWith("/dashboard/history")) {
        const range = PORTFOLIO_RANGES.find((value) => value === searchParams.get("range"));
        const scope = searchParams.get("scope");
        if (!range || (scope !== "invest" && scope !== "isa") || searchParams.get("runId") !== fixture.runId) {
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
    test(`${range} shows cash-flow-adjusted P&L and preserves account, range and cutoff`, async ({ page }) => {
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
      await expect(overview.getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(overview.getByRole("heading", { name: "Period P&L", exact: true })).toBeVisible();
      await expect(overview).not.toContainText("Cumulative net contributions");
      await expect(overview).not.toContainText("Some periods have no observations");
      await expect(overview.locator(".mx-period-figure")).toContainText("£10.00");
      await expect(overview.locator(".mx-freshness")).toContainText("Cash flows pending");
      const original = await observations(overview.locator(".mx-chart-data"));
      expect(original.at(-1)).toEqual([intraday[2].date, "£190.00", "£10.00"]);
      if (short) expect(original.map((row) => row.at(-1))).toEqual(["£0.00", "£0.00", "£10.00"]);
      const coverage = await overview.locator(".mx-history-coverage").allTextContents();
      await overview.getByRole("link", { name: "View performance" }).click();
      await expect(page).toHaveURL(new RegExp(`view=money&range=${range}&scope=isa`));
      await expect(page.getByRole("combobox", { name: "Analysis account" })).toHaveValue("Stocks\u00a0ISA");
      await expect(page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
      expect(await observations(page.locator(".mx-chart-data").first())).toEqual(original);
      expect(await page.locator(".mx-history-coverage").allTextContents()).toEqual(coverage);
      await expect(page.getByText("Some periods have no observations", { exact: true })).toHaveCount(0);
      await expect(page.locator(".mx-money-summary")).toContainText("£10.00");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`scope=isa&range=${range}`));
      await expect(overview.getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
    });
  }
  test("range changes survive reload and invalid links use the default", async ({ page }) => {
    await page.goto("/?scope=invest&range=invalid");
    const overview = page.locator(".mx-overview-history");
    await expect(overview.getByRole("button", { name: "3M", exact: true })).toHaveAttribute("aria-pressed", "true");
    await overview.getByRole("button", { name: "6M", exact: true }).click();
    await page.reload();
    await expect(overview.getByRole("button", { name: "6M", exact: true })).toHaveAttribute("aria-pressed", "true");
    await overview.getByRole("link", { name: "View performance" }).click();
    await page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: "1M", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: "1M", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("combobox", { name: "Analysis account" })).toHaveValue("Invest");
  });
});
