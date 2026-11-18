import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareHistory } from "../lib/portfolio/prepared";
import type { Holding } from "../lib/types";

const day = "2026-11-26";
const brokerAsOf = day + "T17:30:00Z";
const us: Holding = {
  ticker: "SYNUS", name: "Synthetic US stock", account: "A", listingMarket: "US",
  isFund: false, quantity: 2, currentPrice: 25, priceCurrency: "USD",
  currentValueGbp: 40, costGbp: 35, pnlGbp: 5, pnlPct: 1 / 7, allocationPct: 0.5,
  dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null,
  dilutedCostCurrency: "USD", snapshotFxRateNativePerGbp: 1.25, fxImpactGbp: -3.25,
  dayChangeClosedOn: day, dayChangeGbp: null, dayChangePct: null,
};
const uk: Holding = {
  ...us, ticker: "SYNUK", name: "Synthetic London fund", isFund: true, listingMarket: "LSE",
  priceCurrency: "GBP", fxImpactGbp: 0, dayChangeClosedOn: undefined, dayChangeDate: day, dayChangeGbp: 0, dayChangePct: 0,
};
const lens = {
  runId: "synthetic-closed-market", dataRevision: "synthetic", brokerAsOf, holdings: [us, uk],
  totalValueGbp: 80, totalInvestedGbp: 80, totalCashGbp: 0, totalUnrealizedPnlGbp: 10,
  accounts: [{ code: "A", isInvestable: true, totalValueGbp: 80, asOf: brokerAsOf }],
};
const history = prepareHistory(lens, { range: "1D", scope: "total" }).chart;
const accessible = "该上市交易所休市";

async function syntheticHoldings(page: Page) {
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
}

test("retained position prices and balances show their own observation times", async ({page,isMobile}) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local fixture.");
  await syntheticHoldings(page);
  await page.setViewportSize(isMobile ? {width:390,height:844} : {width:1440,height:900});
  const positionAt = day+"T15:00:00Z";
  await page.route("**/dashboard/lens/holdings-positions?**", route => route.fulfill({json: {
    ...lens, positionAsOf:{A:positionAt},
  }}));
  await page.goto("/holdings?account=A&snapshotId="+lens.runId+"&evidence=list_holdings");
  const position = isMobile ? page.getByRole("button",{name:/SYNUS.*休市/})
    : page.getByRole("row").filter({hasText:"SYNUS"});
  await expect(position.locator(".mx-holding-quote-basis time")).toHaveAttribute("datetime",positionAt);
  await expect(page.locator(".mx-holdings-summary .mx-freshness")).toContainText("17:30");
  if (process.env.TM_INSPECTION_SHOTS) {
    await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS, (isMobile ? "phone" : "desktop")+"-retained-position-times.png")});
  }
  if (isMobile) await position.tap();
  else await position.getByRole("button",{name:/查看持仓 SYNUS/}).click();
  await expect(page.getByRole("dialog").locator('time[datetime="'+positionAt+'"]').first()).toBeVisible();
});

test("an undated ISA quote shows the price and its missing time on both position surfaces", async ({page,isMobile}) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local fixture.");
  await syntheticHoldings(page);
  await page.setViewportSize(isMobile ? {width:390,height:844} : {width:1440,height:900});
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  const stamp = day+"T21:15:00Z";
  await page.route("**/dashboard/lens/holdings-positions*", route => route.fulfill({json:{
    ...lens, brokerAsOf:stamp, positionAsOf:{B:null},
    accounts:[{...lens.accounts[0], code:"B", asOf:stamp}],
    holdings:[{...uk, account:"B", currentPrice:7}],
  }}));
  await page.goto("/holdings?account=B");
  const row = isMobile ? page.getByRole("button",{name:/SYNUK/}) : page.getByRole("row").filter({hasText:"SYNUK"});
  await expect(row.locator(".mx-holding-quote-basis")).toContainText("Time unavailable");
  await expect(page.locator(".mx-holdings-summary .mx-freshness")).toContainText("21:15");
  if (isMobile) await row.tap();
  else await row.getByRole("button",{name:/SYNUK/}).first().click();
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".mx-position-summary")).toContainText("£7.00");
  await expect(detail.locator(".mx-position-summary")).toContainText("Time unavailable");
  await detail.locator("summary").filter({hasText:"Quote and calculation"}).click();
  await expect(detail.getByText("Time unavailable",{exact:true})).toHaveCount(2);
  if (process.env.TM_INSPECTION_SHOTS) {
    await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS,(isMobile ? "phone" : "desktop")+"-undated-isa.png")});
  }
});

test("a closed listing replaces the day figure on each position surface", async ({ page }, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");
  const phone = info.project.name === "mobile";
  await syntheticHoldings(page);
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
  await expect(position.locator(".mx-holding-quote-basis")).toContainText("券商快照");
  await expect(position.locator(".mx-holding-quote-basis time")).toHaveAttribute("datetime", brokerAsOf);
  if (phone) await position.tap();
  else await position.getByRole("button", { name: /查看持仓 SYNUS/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("休市", { exact: true })).toBeVisible();
  await expect(drawer.getByText(accessible, { exact: true })).toBeAttached();
  if (evidence) await drawer.screenshot({ path: `${evidence}/closed-drawer-${info.project.name}.png` });
});

for (const locale of ["zh", "en"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`the holding's FX impact is consistent in ${locale} and ${scheme}`, async ({ page, isMobile }, info) => {
      test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");
      if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await syntheticHoldings(page);
      await page.goto("/holdings");
      const row = isMobile ? page.getByRole("button", { name: /SYNUS/ })
        : page.getByRole("row").filter({ hasText: "SYNUS" });
      if (!isMobile) await expect(row.getByRole("cell", { name: /3\.25/ })).toBeVisible();
      const target = isMobile ? row : row.getByRole("button", { name: /SYNUS/ }).first();
      await target.focus();
      await target.press("Enter");
      const dialog = page.getByRole("dialog");
      await dialog.locator("summary").filter({ hasText: /报价与计算|Quote and calculation/ }).press("Enter");
      const fx = dialog.getByText(/^(汇率影响|FX impact)$/);
      await expect(fx).toBeVisible();
      await expect(dialog.getByText(/[-−]£3\.25/)).toBeVisible();
      const folder = process.env.HOLDINGS_QA_EVIDENCE;
      if (folder) {
        await mkdir(folder, { recursive: true });
        await page.screenshot({ path: `${folder}/holding-fx-${info.project.name}-${locale}-${scheme}.png` });
      }
    });
  }
}
