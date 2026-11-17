import { expect, test, type Page } from "@playwright/test";

const asOf = "2026-10-20T12:00:00Z";
const bucket = {
  key: "SYNTHETIC",
  label: "Synthetic Long Named International Security",
  tradeCount: 123,
  netResultGbp: 123456.78,
  grossWinsGbp: 1234567.89,
  grossLossesGbp: -1111111.11,
};
const moneyOutcome = {
  ending_value_gbp: 1234567.89,
  net_pnl_gbp: -123456.78,
  max_pnl_drawdown_gbp: -234567,
  net_external_flows_gbp: 2345678,
};
const cfdMoney = {
  endingRealisedCashEquityProxyGbp: 1234567.89,
  netRealisedPnlGbp: -123456.78,
  maxRealisedPnlDrawdownGbp: -234567,
  accountCashFlowGbp: 2345678,
};
// Decisions large enough to crowd every verdict, in each account.
const scored = { observedDays: 30, horizonComplete: true, marketReturnHorizon: 0.02, marketReturnToDate: 0.02, events: [] };
const decisions = {
  status: "available",
  asOf,
  horizonDays: 20,
  decisions: [
    {
      ...scored, date: "2026-09-01", ticker: "SYNTHETIC", name: bucket.label, side: "buy", kind: "B", amountGbp: 2345678,
      effectHorizonGbp: 1234567, effectToDateGbp: 1234567, returnHorizon: 0.52, returnToDate: 0.52,
    },
    {
      ...scored, date: "2026-09-02", ticker: "SYNTHETIC.L", name: bucket.label + " plc", side: "sell", kind: "S", amountGbp: 1234567,
      effectHorizonGbp: -234567, effectToDateGbp: -234567, returnHorizon: 0.19, returnToDate: 0.19,
    },
  ],
  roundTripSummary: { count: 12, favourable: 7, resultGbp: 123456 },
};

async function serve(page: Page, account?: string) {
  await page.route("**/api/backend/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/dashboard/lens/")) return route.fulfill({ json: {
      runId: "synthetic-phone-review",
      brokerAsOf: asOf,
      reviewAsOf: asOf,
      holdings: [],
      nav: [],
      selectedAccount: { code: account, totalValueGbp: 1234567.89 },
      selectedAccountReview: { moneyOutcome, attribution: { by_instrument: { buckets: [bucket] } } },
      selectedCfdReview: { moneyOutcome: cfdMoney, attribution: { byInstrument: [bucket] } },
      selectedAccountDecisions: decisions,
      decisionReviews: { A: decisions, B: decisions },
      risk: { A: { twr: 1.2345 }, B: { twr: -0.4321 } },
    } });
    return route.fulfill(path.endsWith("/profile") ? { json: { accountLabels: {} } } : { status: 404, json: {} });
  });
}

/** The review's figures whose text runs past their own cell, and account cells that stick out of their row. */
function overflowing(page: Page) {
  return page.locator(".mx-review-lead").evaluateAll((leads) => leads.flatMap((lead) => {
    const outside = (inner: DOMRect, outer: DOMRect) => inner.left < outer.left - 0.5 || inner.right > outer.right + 0.5;
    const figures = [...lead.querySelectorAll(".mx-number-value, .mx-review-money dd")].filter((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const cell = (element.closest(".mx-number") ?? element).getBoundingClientRect();
      return [...range.getClientRects()].some((rect) => outside(rect, cell));
    });
    // A row's hidden columns and its screen-reader labels take no room of their own.
    const cells = [...lead.querySelectorAll(".mx-review-accounts-row > :not(.sr-only)")].filter((element) =>
      element.getClientRects().length > 0 && outside(element.getBoundingClientRect(), element.parentElement!.getBoundingClientRect()));
    return [...figures, ...cells].map((element) => element.textContent);
  }));
}

const pageWidth = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth);

test.describe("phone account review", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    for (const account of ["A", "B", "C"]) {
      test(`account ${account} fits every view at ${viewport.width}px`, async ({ page }, info) => {
        test.skip(info.project.name !== "mobile", "Uses the phone layout.");
        await page.setViewportSize(viewport);
        await serve(page, account);
        await page.goto("/review?account=" + account);
        const analysis = page.getByRole("region", { name: "账户分析" });
        await expect(analysis).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const tabs = analysis.getByRole("tab");
        // CFD history adds its import records.
        await expect(tabs).toHaveCount(account === "C" ? 8 : 7);
        const lead = page.getByRole("region", { name: "复盘结论" });
        await expect(lead.locator(account === "C" ? ".mx-number-value" : ".mx-review-money dd").first()).toHaveText("£1,234,567.89");
        for (const tab of await tabs.all()) {
          await test.step((await tab.textContent())!, async () => {
            // A phone switches the angle with a tap.
            await tab.tap();
            await expect(tab).toHaveAttribute("aria-selected", "true");
            expect(await pageWidth(page)).toBeLessThanOrEqual(viewport.width);
            expect(await overflowing(page)).toEqual([]);
            if (account !== "C" && (await tab.textContent()) === "盈亏归因") {
              const tableRegion = analysis.getByRole("region", { name: "归因明细" });
              await expect(tableRegion.getByRole("table")).toBeVisible();
              expect(await tableRegion.evaluate((element) => {
                element.scrollLeft = element.scrollWidth;
                return element.scrollLeft;
              })).toBeGreaterThan(0);
            }
          });
        }
      });
    }

    test(`every account fits at ${viewport.width}px`, async ({ page }, info) => {
      test.skip(info.project.name !== "mobile", "Uses the phone layout.");
      await page.setViewportSize(viewport);
      await serve(page);
      await page.goto("/review");
      const rows = page.locator("a.mx-review-accounts-row");
      await expect(rows).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);
      // On a phone an account keeps its name, its two verdicts and its way in.
      await expect(rows.first()).toContainText("赚 £1,234,567");
      await expect(rows.first()).toContainText("少赚 £234,567");
      expect(await pageWidth(page)).toBeLessThanOrEqual(viewport.width);
      expect(await overflowing(page)).toEqual([]);
      for (const row of await rows.all()) {
        const bounds = (await row.boundingBox())!;
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      }
      expect(await page.locator(".mx-review-line").evaluateAll((lines) => lines.every((line) => line.scrollWidth <= line.clientWidth))).toBe(true);
    });
  }
});
