import { expect, test, type Page } from "@playwright/test";

// A synthetic account with two scored decisions; between fetches only their context changes.
const asOf = "2026-10-20T12:00:00Z";
type Context = { benchmark: number; events: boolean };

function decisions({ benchmark, events }: Context) {
  const scored = { observedDays: 34, horizonComplete: true, marketReturnHorizon: benchmark, marketReturnToDate: benchmark };
  return [
    {
      ...scored, date: "2026-09-01", ticker: "SYNA", name: "Synthetic Alpha", side: "sell", kind: "S", amountGbp: 500,
      effectHorizonGbp: -40, effectToDateGbp: -55, returnHorizon: 0.08, returnToDate: 0.11, events: [],
    },
    {
      ...scored, date: "2026-09-02", ticker: "SYNB", name: "Synthetic Beta", side: "buy", kind: "B", amountGbp: 800,
      effectHorizonGbp: 60, effectToDateGbp: 70, returnHorizon: 0.09, returnToDate: 0.1,
      events: events ? [
        { date: "2026-09-05", kind: "news", title: "Synthetic Beta opens a second plant in a long-named industrial district" },
        { date: "2026-09-09", kind: "initiate", firm: "Example Securities International", toGrade: "buy" },
        { date: "2026-09-14", kind: "upgrade", firm: "Another Example Research Partners", toGrade: "outperform" },
      ] : [],
    },
  ];
}

async function serve(page: Page, context: () => Context) {
  await page.route("**/api/backend/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/dashboard/lens/")) return route.fulfill({ json: {
      runId: "synthetic-decision-context", brokerAsOf: asOf, reviewAsOf: asOf,
      totalValueGbp: 2000, totalCashGbp: 100, holdings: [], nav: [],
      accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2000 }],
      selectedAccountDecisions: { status: "available", asOf, horizonDays: 20, observingCount: 0, decisions: decisions(context()) },
    } });
    if (path.endsWith("/analysis")) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: path.endsWith("/profile") ? { accountLabels: {} } : {} });
  });
}

/** The connection drops and returns once the lens has gone stale, so it is fetched again. */
async function reconnect(page: Page) {
  await page.clock.fastForward(31_000);
  await page.context().setOffline(true);
  await page.context().setOffline(false);
}

test.describe("decision review", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  let context: Context;
  test.beforeEach(async ({ page }) => {
    context = { benchmark: 0.021, events: true };
    await page.clock.install({ time: new Date(asOf) });
    await serve(page, () => context);
    await page.goto("/account-analysis?account=A&reviewView=decisions");
  });

  test("a row keeps keyboard focus when a refetch updates its benchmark", async ({ page }) => {
    const row = page.getByRole("link", { name: /Synthetic Alpha/ });
    await expect(row).toContainText("标普 500 同期 +2.1%");
    await row.focus();
    context = { benchmark: 0.034, events: true };
    await reconnect(page);
    await expect(row).toContainText("标普 500 同期 +3.4%");
    await expect(row).toBeFocused();
  });

  test("\"+N\" keeps focus while its line stays crowded, then hands it to the row once all of it fits", async ({ page }) => {
    const entry = page.locator(".mx-decision-entry").filter({ has: page.getByRole("link", { name: /Synthetic Beta/ }) });
    const more = entry.getByRole("button", { name: /项/ });
    await more.focus();
    await expect(more).toBeFocused();
    context = { benchmark: 0.034, events: true };
    await reconnect(page);
    await expect(entry.getByRole("link")).toContainText("标普 500 同期 +3.4%");
    await expect(more).toBeFocused();
    context = { benchmark: 0.034, events: false };
    await reconnect(page);
    await expect(more).toBeHidden();
    await expect(entry.getByRole("link")).toBeFocused();
  });
});
