import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { prepareHistory } from "../lib/portfolio/prepared";
import type { Holding } from "../lib/types";

const day = "2026-11-26";
const brokerAsOf = day + "T17:30:00Z";
const us: Holding = {
  ticker: "SYNUS", name: "Synthetic US stock", account: "A", listingMarket: "US",
  isFund: false, quantity: 2, currentPrice: 25, priceCurrency: "USD",
  currentValueGbp: 40, costGbp: 35, pnlGbp: 5, pnlPct: 1 / 7, allocationPct: 0.5,
  dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null,
  dilutedCostCurrency: "USD", snapshotFxRateNativePerGbp: null, fxImpactGbp: null,
  dayChangeClosedOn: day, dayChangeGbp: null, dayChangePct: null,
};
const uk: Holding = {
  ...us, ticker: "SYNUK", name: "Synthetic London fund", isFund: true, listingMarket: "LSE",
  priceCurrency: "GBP", dayChangeClosedOn: undefined, dayChangeDate: day, dayChangeGbp: 0, dayChangePct: 0,
};
const lens = {
  runId: "synthetic-closed-market", dataRevision: "synthetic", brokerAsOf, holdings: [us, uk],
  totalValueGbp: 80, totalInvestedGbp: 80, totalCashGbp: 0, totalUnrealizedPnlGbp: 10,
  accounts: [{ code: "A", isInvestable: true, totalValueGbp: 80, asOf: brokerAsOf }],
};
const history = prepareHistory(lens, { range: "1D", scope: "total" }).chart;
const accessible = "该上市交易所休市";

test("a closed listing replaces the day figure on each position surface", async ({ page }, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");
  const phone = info.project.name === "mobile";
  await page.clock.setFixedTime(new Date(brokerAsOf));
  await page.route("**/api/backend/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.includes("/dashboard/lens/") ? lens
      : path.endsWith("/dashboard/history") ? history
        : path.endsWith("/health") ? { service: "trading_max-api", status: "ok", latestRunId: lens.runId }
          : path.endsWith("/profile") ? { accountLabels: {} }
            : path.endsWith("/refresh/attention") ? { checkedAt: brokerAsOf, issues: [] } : {};
    return route.fulfill({ json });
  });
  await page.goto("/?range=1D");
  const overview = page.locator(".mx-overview-holdings");
  const usRow = phone ? overview.getByRole("link", { name: new RegExp("SYNUS.*" + accessible) })
    : overview.getByRole("row").filter({ hasText: "SYNUS" });
  await expect(usRow.getByText("休市", { exact: true })).toBeVisible();
  if (!phone) await expect(usRow.getByRole("cell", { name: accessible })).toBeVisible();
  const ukRow = phone ? overview.getByRole("link", { name: /SYNUK/ })
    : overview.getByRole("row").filter({ hasText: "SYNUK" });
  await expect(ukRow.getByText("0.00%", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".mx-overview-holdings").analyze()).violations).toEqual([]);
  const evidence = process.env.TONE_QA_EVIDENCE;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await overview.screenshot({ path: `${evidence}/closed-overview-${info.project.name}.png` });
  }
  if (!phone) {
    await usRow.locator(".mx-peek-target").hover();
    const preview = page.locator(".mx-peek").filter({ hasText: "SYNUS" });
    await expect(preview.getByText("休市", { exact: true })).toBeVisible();
    if (evidence) await preview.screenshot({ path: `${evidence}/closed-preview.png` });
  }

  await page.goto("/holdings");
  const position = phone ? page.getByRole("button", { name: new RegExp("SYNUS.*" + accessible) })
    : page.getByRole("row").filter({ hasText: "SYNUS" });
  await expect(position.getByText("休市", { exact: true })).toBeVisible();
  if (phone) await position.tap();
  else await position.getByRole("button", { name: /查看持仓 SYNUS/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("休市", { exact: true })).toBeVisible();
  await expect(drawer.getByText(accessible, { exact: true })).toBeAttached();
  if (evidence) await drawer.screenshot({ path: `${evidence}/closed-drawer-${info.project.name}.png` });
});
