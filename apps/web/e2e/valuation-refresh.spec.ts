import { expect, test, type Page, type Route } from "@playwright/test";

// Synthetic research desk: a held security whose broker price moves from 100 to
// 120 while its assumptions are being edited, and a second, unheld security.
const scenarios = ["bear", "base", "bull"] as const;
const defaults = { revenueCagr: 0.1, targetFcfMargin: 0.15, discountRate: 0.1, exitFcfMultiple: 15, shareCagr: 0 };
type Inputs = typeof defaults;

/** A complete synthetic preview; the figures only need to move with the spot and inputs. */
function preview(ticker: string, spot: number, asOf: string, held: boolean, inputs: Record<string, Inputs>) {
  const value = (scenario: Inputs) => 100 * (1 + scenario.revenueCagr * 5);
  return {
    id: `synthetic-${ticker}-${spot}-${JSON.stringify(inputs)}`,
    formulaVersion: "equity-proxy-projection-v1",
    basis: {
      ticker, quoteId: `${ticker}-quote`, dataVersion: `${ticker}-research`, currency: "USD",
      spot, spotSource: held ? "broker" : "quote", spotAsOf: asOf,
      revenue: 1000, shares: 100, startMargin: 0.1, evidence: [],
      cashFlowType: "operating-cash-flow-less-capex-equity-proxy", discountRateType: "cost-of-equity",
    },
    horizon: 5,
    scenarios: Object.fromEntries(scenarios.map((key) => {
      const scenario = inputs[key] ?? defaults;
      const years = [1, 2, 3, 4, 5].map((year) => ({
        year, growth: scenario.revenueCagr, revenue: 1000 + year * 100, fcfMargin: 0.15,
        freeCashflow: 150, shares: 100, cashflowPerShare: 1.5, discountFactor: 0.9, presentValue: 1.35,
      }));
      return [key, {
        inputs: scenario, years, operatingValue: 7, terminalValue: 22, terminalPresentValue: 13,
        terminalContribution: 0.6, equityFloorAdjustment: 0, value: value(scenario), upside: value(scenario) / spot - 1,
      }];
    })),
    sensitivity: Array.from({ length: 25 }, (_, index) => ({
      growth: 0.1, discountRate: 0.1, value: 150 + index, upside: (150 + index) / spot - 1,
    })),
    impliedGrowth: 0.05, impliedGrowthBound: null, impliedGrowthReason: null, references: [],
    defaultSource: "configured-scenarios",
  };
}

function instrument(ticker: string, order: number, held: boolean, broker: { price: number; asOf: string }) {
  return {
    ticker, name: `${ticker} Synthetic`, exchange: "NYSE", website: "", bloombergTicker: "", figi: "",
    categoryId: "", researchThemeId: null, taxonomyStatus: "unclassified", taxonomyLabelZh: null,
    taxonomyLabelEn: null, taxonomyVersion: null, taxonomyDecisionId: null, gics: null, order,
    // A running update keeps the shell polling, so the header follows the broker.
    status: held ? "running" : "ready", lastRunId: "synthetic-run", lastError: null,
    hasMarket: true, hasTechnical: true, hasOptions: false, hasValuation: true, hasEarnings: false, hasFundamentals: true,
    held, exposureGbp: held ? 1000 : 0, directValueGbp: held ? 1000 : 0,
    brokerPrice: held ? broker.price : null, brokerPriceCurrency: held ? "USD" : null,
    brokerAsOf: held ? broker.asOf : null, brokerListing: held ? `US:${ticker}` : null,
  };
}

function lens(ticker: string, view: string, price: number) {
  return {
    ticker, view, runId: "synthetic-run", generatedAt: "2026-11-04T12:00:00Z", dataRevision: "synthetic",
    context: {
      quote: {
        id: `${ticker}-quote`, ticker, price, currency: "USD", quoteUnit: "USD", exchange: "NYSE",
        timezone: "America/New_York", asOf: "2026-11-03T21:00:03Z", session: "regular", change: 1,
        changePct: 0.01, delayMinutes: 0, source: "synthetic", listing: `US:${ticker}`, schedule: null,
      },
      assetType: "EQUITY",
      capabilities: [{ task: "valuation", state: "available", reason: null, intervals: [] }],
      datasets: [],
    },
    financialFacts: { version: `${ticker}-facts`, currency: "USD", periods: [], observations: [], latestTtm: null, reconciliation: {} },
    researchEvidence: {}, market: { spot: price, currency: "USD" }, analyst: view === "analyst" ? {} : null,
    timeline: [], events: [], models: [], alerts: [],
  };
}

async function synthetic(page: Page) {
  const state = {
    broker: { price: 100, asOf: "2026-11-04T15:40:00Z" },
    defaultsDown: false,
    posts: [] as { ticker: string; scenarios: Record<string, Inputs> }[],
    releaseOther: () => {},
  };
  const otherDefaults = new Promise<void>((resolve) => { state.releaseOther = resolve; });
  await page.route("**/api/backend/**", (route) => route.fulfill({ status: 404, json: { detail: "synthetic" } }));
  await page.route("**/api/company-logo/**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/backend/research/shell", (route) => route.fulfill({ json: {
    status: { runId: "synthetic-run", overall: "fresh", artifacts: [] },
    watchlistCategories: [],
    instruments: [instrument("SYNT", 1, true, state.broker), instrument("OTHR", 2, false, state.broker)],
  } }));
  await page.route(/\/api\/backend\/research\/(SYNT|OTHR)\/lens\/(\w+)/, (route) => {
    const [, ticker, view] = /research\/(SYNT|OTHR)\/lens\/(\w+)/.exec(route.request().url())!;
    return route.fulfill({ json: lens(ticker, view, ticker === "SYNT" ? 101 : 55) });
  });
  await page.route(/\/api\/backend\/research\/(SYNT|OTHR)\/valuation-preview/, async (route: Route) => {
    const request = route.request();
    const ticker = /research\/(SYNT|OTHR)\//.exec(request.url())![1];
    const held = ticker === "SYNT";
    const spot = held ? state.broker : { price: 55, asOf: "2026-11-03T21:00:03Z" };
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { scenarios: Record<string, Inputs> };
      state.posts.push({ ticker, scenarios: body.scenarios });
      return route.fulfill({ json: preview(ticker, spot.price, spot.asOf, held, body.scenarios) });
    }
    if (!held) await otherDefaults;
    if (held && state.defaultsDown) return route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
    return route.fulfill({ json: preview(ticker, spot.price, spot.asOf, held, {}) });
  });
  return state;
}

test.describe("valuation refresh", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test("a failed broker refresh keeps edited assumptions and retries inline", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page);
    await page.goto("/research?ticker=SYNT&view=valuation");
    const spot = page.locator(".mx-scenario-spot");
    await expect(spot).toContainText("100.00");
    const growth = page.getByLabel("Revenue growth · years 1–5");
    await growth.fill("20");
    await expect.poll(() => state.posts.at(-1)?.scenarios.base.revenueCagr).toBe(0.2);

    // The broker price moves to 120 and its revaluation fails.
    state.defaultsDown = true;
    state.broker = { price: 120, asOf: "2026-11-04T15:50:00Z" };
    await expect(page.locator(".mx-security-price")).toContainText("120.00");
    const failure = page.getByRole("alert").filter({ hasText: "Not revalued at the latest price" });
    await expect(failure).toBeVisible();
    await expect(spot).toContainText("100.00");
    await expect(growth).toHaveValue("20%");
    await expect(page.getByText("Cash-flow model inputs are incomplete")).toHaveCount(0);

    // A successful retry revalues the edited assumptions at 120 and keeps them.
    state.defaultsDown = false;
    const posts = state.posts.length;
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect(spot).toContainText("120.00");
    await expect(failure).toHaveCount(0);
    await expect(growth).toHaveValue("20%");
    await expect.poll(() => state.posts.length).toBeGreaterThan(posts);
    expect(state.posts.at(-1)?.scenarios.base.revenueCagr).toBe(0.2);

    // Another security never shows this one's preview while its own loads.
    await page.getByRole("button", { name: "Next security" }).click();
    await expect(page).toHaveURL(/ticker=OTHR/);
    await expect(page.locator(".mx-security-header h2")).toContainText("OTHR");
    await expect(spot).toHaveCount(0);
    state.releaseOther();
    await expect(spot).toContainText("55.00");
    await expect(spot).not.toContainText("120.00");
  });
});
