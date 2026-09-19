import { expect, test, type Locator } from "@playwright/test";
import type { NavPoint } from "../lib/types";

const intraday = [
  ["2026-09-18T09:00:00Z", 100, 90],
  ["2026-09-18T09:10:00Z", 180, 170],
  ["2026-09-18T09:30:00Z", 190, 170],
  ["2026-09-18T09:40:00Z", 500, null],
].map(([date, value, flows]) => ({
  date, total: value, invest: value, isa: value,
  totalNetContributionsGbp: flows, investNetContributionsGbp: flows, isaNetContributionsGbp: flows,
  intraday: true, valuationSource: "broker", cadenceSeconds: 600,
})) as NavPoint[];
const nav = intraday.slice(0, 3).map((point, i) => ({
  ...point, date: ["2026-01-02", "2026-06-18", "2026-09-18"][i], intraday: false,
}));
const fixture = {
  runId: "synthetic-overview-alignment", brokerAsOf: intraday.at(-1)!.date,
  totalValueGbp: 500, nav, intradayNav: intraday, holdings: [],
  accounts: ["A", "B"].map((code) => ({ code, isInvestable: true, totalValueGbp: 500 })),
};

async function values(table: Locator, columns: number[]) {
  return table.locator("tbody tr").evaluateAll((rows, indexes) => rows.map((row) =>
    indexes.map((index) => row.children[index].textContent)), columns);
}

test.describe("overview to performance", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = path.includes("/dashboard/lens/") ? fixture
        : path.endsWith("/profile") ? { accountLabels: { A: "Invest", B: "Stocks ISA" } } : {};
      return route.fulfill({ json });
    });
  });

  for (const range of ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"]) {
    test(`${range} shows cash-flow-adjusted P&L and preserves account, range and cutoff`, async ({ page }) => {
      const short = ["1D", "1W", "1M", "3M"].includes(range);
      const rangeLabel = range === "1W" ? "5D" : range === "ALL" ? "All" : range;
      const historyRequest = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/dashboard/lens/analytics"));
      await page.goto(`/?scope=isa&range=${range}`);
      const requested = new URL((await historyRequest).url());
      expect(requested.searchParams.get("range")).toBe(range);
      expect(requested.searchParams.get("scope")).toBe("isa");
      const overview = page.locator(".mx-overview-history");
      await expect(overview.locator("[data-tm-chart-ready=true]")).toBeVisible();
      await expect(overview.getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(overview.getByRole("heading", { name: "Period P&L", exact: true })).toBeVisible();
      await expect(overview).not.toContainText("Cumulative net contributions");
      await expect(overview).not.toContainText("Some periods have no observations");
      await expect(overview.locator(".mx-chart-footer")).toContainText("£10.00");
      await expect(overview.locator(".mx-freshness")).toContainText("Cash flows pending");
      await overview.locator(".mx-chart-data summary").click();
      const original = await values(overview.locator("table"), [0, 1, 2]);
      if (short) expect(original.map((row) => row.at(-1))).toEqual(["£0.00", "£0.00", "£10.00"]);
      const coverage = await overview.locator(".mx-history-coverage").allTextContents();
      await overview.getByRole("link", { name: "View performance" }).click();
      await expect(page).toHaveURL(new RegExp(`view=money&range=${range}&scope=isa`));
      await expect(page.getByRole("combobox", { name: "Analysis account" })).toHaveValue("Stocks ISA");
      await expect(page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
      await page.locator(".mx-chart-data summary").first().click();
      expect(await values(page.locator(".mx-chart-data table").first(), [0, 1, 4])).toEqual(original);
      expect(await page.locator(".mx-history-coverage").allTextContents()).toEqual(coverage);
      await expect(page.getByText("Some periods have no observations", { exact: true })).toHaveCount(0);
      if (short) await expect(page.locator(".mx-metric-grid").first()).toContainText("£10.00");
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
