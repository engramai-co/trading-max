import { expect, test } from "@playwright/test";

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

test.describe("phone account review", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    for (const account of ["A", "B", "C"]) {
      test(`account ${account} fits every view at ${viewport.width}px`, async ({ page }, info) => {
        test.skip(info.project.name !== "mobile", "Uses the phone layout.");
        await page.setViewportSize(viewport);
        await page.route("**/api/backend/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/account-analysis")) return route.fulfill({ json: {
            runId: "synthetic-phone-review",
            brokerAsOf: asOf,
            reviewAsOf: asOf,
            holdings: [],
            nav: [],
            selectedAccount: { code: account, totalValueGbp: 1234567.89 },
            selectedAccountReview: { moneyOutcome, attribution: { by_instrument: { buckets: [bucket] } } },
            selectedCfdReview: { moneyOutcome, attribution: { byInstrument: [bucket] } },
            selectedAccountDecisions: { status: "available", asOf, horizonDays: 20, decisions: [] },
          } });
          return route.fulfill(path.endsWith("/profile") ? { json: { accountLabels: {} } } : { status: 404, json: {} });
        });

        await page.goto(`/account-analysis?account=${account}&reviewView=outcome`);
        const evidence = page.getByRole("region", { name: "复盘证据" });
        await expect(evidence).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const tabs = evidence.getByRole("tab");
        await expect(tabs).toHaveCount(8);
        for (const tab of await tabs.all()) {
          await test.step((await tab.textContent())!, async () => {
            await tab.click();
            await expect(tab).toHaveAttribute("aria-selected", "true");
            expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(viewport.width);
            const amounts = page.locator(".mx-review-bento .mx-number-value");
            await expect(amounts.first()).toHaveText("£1,234,567.89");
            expect(await amounts.evaluateAll((elements) => elements.every((element) => {
              const bounds = element.closest(".mx-number")!.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(element);
              return [...range.getClientRects()].every((rect) => rect.left >= bounds.left && rect.right <= bounds.right);
            }))).toBe(true);
            if (account !== "C" && (await tab.textContent()) === "盈亏归因") {
              const tableRegion = evidence.getByRole("region", { name: "归因明细" });
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
  }
});
