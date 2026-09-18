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

async function values(table: Locator, columns: number) {
  return table.locator("tbody tr").evaluateAll((rows, count) => rows.map((row) =>
    Array.from(row.children).slice(0, count).map((cell) => cell.textContent)), columns);
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
    test(`${range} preserves account, range, values, contributions and cutoff`, async ({ page }) => {
      const short = ["1D", "1W", "1M", "3M"].includes(range);
      const rangeLabel = range === "1W" ? "5D" : range === "ALL" ? "All" : range;
      await page.goto(`/?scope=isa&range=${range}`);
      const overview = page.locator(".mx-overview-history");
      await expect(overview.locator("[data-tm-chart-ready=true]")).toBeVisible();
      await expect(overview.getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(overview.locator(".mx-chart-legend")).toContainText("Cumulative net contributions");
      if (short) {
        await expect(overview.locator(".mx-freshness")).toContainText("Cash flows pending");
        await expect(overview.locator(".mx-chart-footer")).toContainText("£90.00");
        await expect(overview.locator(".mx-history-coverage-details")).not.toHaveAttribute("open");
      }
      await overview.locator(".mx-chart-data summary").click();
      const original = await values(overview.locator("table"), short ? 4 : 3);
      const coverage = await overview.locator(".mx-history-coverage").allTextContents();
      await overview.getByRole("link", { name: "View performance" }).click();
      await expect(page).toHaveURL(new RegExp(`view=money&range=${range}&scope=isa`));
      await expect(page.getByRole("combobox", { name: "Analysis account" })).toHaveValue("Stocks ISA");
      await expect(page.getByRole("group", { name: "Performance range" }).getByRole("button", { name: rangeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
      await page.locator(".mx-chart-data summary").first().click();
      expect(await values(page.locator(".mx-chart-data table").first(), short ? 4 : 3)).toEqual(original);
      expect(await page.locator(".mx-history-coverage").allTextContents()).toEqual(coverage);
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
