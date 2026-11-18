import type { Page } from "@playwright/test";
import { join } from "node:path";

// A synthetic research desk shared by the valuation specs: a saved valuation version of one
// security reopened after a new report. Every backend response is fabricated here.
export const scenarios = ["bear", "base", "bull"] as const;
export type Key = (typeof scenarios)[number];
export type Inputs = { revenueCagr: number; targetFcfMargin: number; discountRate: number; exitFcfMultiple: number;
  shareCagr: number; rampYears: number };
export const saved: Record<Key, Inputs> = {
  bear: { revenueCagr: 0.05, targetFcfMargin: 0.14, discountRate: 0.11, exitFcfMultiple: 13, shareCagr: 0, rampYears: 3 },
  base: { revenueCagr: 0.1, targetFcfMargin: 0.15, discountRate: 0.1, exitFcfMultiple: 15, shareCagr: 0, rampYears: 3 },
  bull: { revenueCagr: 0.15, targetFcfMargin: 0.16, discountRate: 0.09, exitFcfMultiple: 17, shareCagr: 0, rampYears: 3 },
};
export const worth = (inputs: Inputs) => 100 * (1 + inputs.revenueCagr * 5);
export const savedModel = {
  id: "saved-version", savedAt: "2026-08-03T10:00:00Z", previewId: "saved-preview",
  lockedInputs: [{ scenario: "base", field: "discount_rate" }],
};

export function preview(inputs: Record<Key, Inputs>) {
  const spot = 120;
  return {
    id: "synthetic-SYNT-" + JSON.stringify(inputs), formulaVersion: "statement-equity-v2",
    basis: {
      ticker: "SYNT", family: "cash-flow", quoteId: "SYNT-quote", dataVersion: "SYNT-research", currency: "USD",
      spot, spotSource: "quote", spotAsOf: "2026-11-04T21:00:00Z", revenue: 4300, shares: 100, startMargin: 0.116,
      periodId: "ttm:2026-09-30", periodChoice: "latest-four-quarters", reportingCurrency: "USD", fxRate: 1,
      evidence: [], cashFlowType: "operating-cash-flow-less-capex-equity-proxy", discountRateType: "cost-of-equity",
    },
    horizon: 5,
    scenarios: Object.fromEntries(scenarios.map((key) => {
      const value = worth(inputs[key]);
      const years = [1, 2, 3, 4, 5].map((year) => ({
        year, growth: inputs[key].revenueCagr, revenue: 4300 + year * 100, fcfMargin: 0.15, freeCashflow: 600,
        shares: 100, cashflowPerShare: 6, discountFactor: 0.9, presentValue: 5.4,
      }));
      return [key, { inputs: inputs[key], years, operatingValue: 27, terminalValue: 90, terminalPresentValue: 56,
        terminalContribution: 0.6, equityFloorAdjustment: 0, value, upside: value / spot - 1 }];
    })),
    sensitivity: Array.from({ length: 25 }, (_, index) => ({ growth: 0.1, discountRate: 0.1, value: 140 + index, upside: 0.2 })),
    reverseMetric: "revenue-growth", reverseValue: 0.06, impliedGrowth: 0.06, impliedGrowthBound: null,
    impliedGrowthReason: null, references: [], defaultSource: "saved-model", savedModel,
  };
}

/** Saved → new statements → price and FX → proposal: synthetic parts that add up. */
export function maintenance(body: { scenarios: Record<Key, Inputs>; lockedInputs: unknown[] }) {
  const walk = Object.fromEntries(scenarios.map((key) => {
    const priceFx = worth(saved[key]);
    const statements = priceFx + 1.25;
    const start = statements - 8.6;
    const proposal = worth(body.scenarios[key]);
    return [key, { saved: start, restated: start - 2.4, statements, priceFx, proposal, restatementEffect: -2.4,
      statementsEffect: statements - start, priceFxEffect: priceFx - statements, assumptionsEffect: proposal - priceFx }];
  }));
  const changes = scenarios.flatMap((key) => body.scenarios[key].revenueCagr === saved[key].revenueCagr ? []
    : [{ scenario: key, field: "revenue_cagr", saved: saved[key].revenueCagr, proposed: body.scenarios[key].revenueCagr, locked: false }]);
  return {
    modelId: savedModel.id, savedAt: savedModel.savedAt, family: "cash-flow", formulaVersion: "statement-equity-v2",
    horizon: 5, currency: "USD", fxSeparated: true, scenarios: walk,
    saved: { periodId: "ttm:2026-06-30", periodChoice: "latest-four-quarters", spot: 104, spotSource: "quote",
      spotAsOf: "2026-08-03T20:00:00Z", fxRate: 1, reportingCurrency: "USD" },
    current: { periodId: "ttm:2026-09-30", periodChoice: "latest-four-quarters", spot: 120, spotSource: "quote",
      spotAsOf: "2026-11-04T21:00:00Z", fxRate: 1, reportingCurrency: "USD" },
    figures: [
      { metric: "revenue", saved: 4000, current: 4300, unit: "currency", currency: "USD" },
      { metric: "startMargin", saved: 0.125, current: 0.116, unit: "ratio", currency: null },
    ],
    restatementCheck: "restated",
    restatements: [{ periodId: "ttm:2026-06-30", metric: "revenue", saved: 4000, current: 3850, unit: "currency", currency: "USD" }],
    conflicts: [{ kind: "quarters-vs-fiscal-year", periodId: "ttm:2026-09-30", metric: "revenue", quarters: 4300,
      fiscalYear: 4410, unit: "currency", currency: "USD" }],
    estimates: [
      { metric: "consensusRevenueGrowth", periodEnd: "2027-09-30", saved: 0.15, current: 0.19,
        savedAsOf: "2026-08-01", currentAsOf: "2026-11-01" },
      { metric: "consensusEps", periodEnd: "2027-09-30", currency: "USD", saved: 2.5, current: 2.7,
        savedAsOf: "2026-08-02T21:00:00Z", currentAsOf: "2026-11-03T21:00:00Z" },
    ],
    assumptions: changes, lockedInputs: body.lockedInputs, newStatements: true, newEstimates: true,
  };
}

export function lens(view: string) {
  return {
    ticker: "SYNT", view, runId: "synthetic-run", generatedAt: "2026-11-04T12:00:00Z", dataRevision: "synthetic",
    context: {
      quote: { id: "SYNT-quote", ticker: "SYNT", price: 120, currency: "USD", quoteUnit: "USD", exchange: "NYSE",
        timezone: "America/New_York", asOf: "2026-11-04T21:00:00Z", session: "regular", change: 1, changePct: 0.01,
        delayMinutes: 0, source: "synthetic", listing: "US:SYNT", schedule: null },
      assetType: "EQUITY", capabilities: [{ task: "valuation", state: "available", reason: null, intervals: [] }], datasets: [],
    },
    financialFacts: { version: "SYNT-facts", currency: "USD", periods: [], observations: [], latestTtm: null, reconciliation: {} },
    researchEvidence: {}, market: { spot: 120, currency: "USD" }, analyst: view === "analyst" ? {} : null,
    timeline: [], events: [], models: [], alerts: [],
  };
}

export type Review = ReturnType<typeof maintenance>;

export async function desk(page: Page, { assistant = false, amend = (review: Review): object => review, notices, journal }: {
  assistant?: boolean;
  amend?: (review: Review) => object;
  /** The evidence notices the service reports; opening their evidence settles them. */
  notices?: { enabled: boolean; runId: string | null; notices: object[] };
  journal?: object;
} = {}) {
  const state = {
    reviews: [] as { modelId: string; scenarios: Record<Key, Inputs>; lockedInputs: unknown[] }[],
    saves: [] as Record<string, unknown>[],
    drafts: [] as Record<string, unknown>[],
    seen: [] as { modelId: string; keys: string[] }[],
  };
  await page.route("**/api/backend/**", (route) => route.fulfill({ status: 404, json: { detail: "synthetic" } }));
  await page.route("**/api/backend/health", (route) => route.fulfill({ json: {
    service: "trading_max-api", status: "ok", latestRunId: "synthetic-run" } }));
  await page.route("**/api/company-logo/**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/backend/profile", (route) => route.fulfill({ json: { assistantEnabled: assistant, accountLabels: {} } }));
  await page.route("**/api/backend/research/shell", (route) => route.fulfill({ json: {
    status: { runId: "synthetic-run", overall: "fresh", artifacts: [] }, watchlistCategories: [],
    instruments: [{ ticker: "SYNT", name: "SYNT Synthetic", exchange: "NYSE", website: "", bloombergTicker: "", figi: "",
      categoryId: "", researchThemeId: null, taxonomyStatus: "unclassified", taxonomyLabelZh: null, taxonomyLabelEn: null,
      taxonomyVersion: null, taxonomyDecisionId: null, gics: null, order: 1, status: "ready", lastRunId: "synthetic-run",
      lastError: null, hasMarket: true, hasTechnical: true, hasOptions: false, hasValuation: true, hasEarnings: false,
      hasFundamentals: true, held: false, exposureGbp: 0, directValueGbp: 0, brokerPrice: null, brokerPriceCurrency: null,
      brokerAsOf: null, brokerListing: null }],
  } }));
  await page.route(/\/api\/backend\/research\/SYNT\/lens\/(\w+)/, (route) =>
    route.fulfill({ json: lens(/lens\/(\w+)/.exec(route.request().url())![1]) }));
  await page.route("**/SYNT/valuation-preview*", (route) => {
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    return route.fulfill({ json: preview(body?.scenarios ?? saved) });
  });
  await page.route("**/SYNT/valuation-maintenance", (route) => {
    const body = route.request().postDataJSON();
    state.reviews.push(body);
    return route.fulfill({ json: amend(maintenance(body)) });
  });
  await page.route("**/SYNT/models", (route) => {
    state.saves.push(route.request().postDataJSON());
    return route.fulfill({ json: { ticker: "SYNT", notes: [], baselineModelId: null, models: [] } });
  });
  await page.route("**/SYNT/valuation-draft", (route) => {
    state.drafts.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ phase: "complete", result: {
      id: "synthetic-draft", snapshotId: "synthetic-run", family: "cash-flow", familySelection: "automatic",
      proposals: [{ scenario: "bull", field: "revenue_cagr", value: 0.19, category: "consensus", source: "consensus-growth",
        evidenceIds: ["estimate"] }],
      deskReadings: { bear: { value: 125, upside: 0.04 }, base: { value: 150, upside: 0.25 }, bull: { value: 195, upside: 0.62 } },
      origins: {},
      evidence: { estimate: { locator: { dataset: "analyst" }, metric: "consensusRevenueGrowth",
        period: { kind: "forecast", forecastSlot: "+1y", end: "2027-09-30" }, publishedAt: "2026-11-01",
        observedAt: "2026-11-03T21:00:00Z", value: 0.19, unit: "ratio" } },
    } }) + "\n" });
  });
  if (notices) {
    let current = notices;
    await page.route("**/api/backend/valuation/evidence-notices", (route) => route.fulfill({ json: current }));
    await page.route("**/api/backend/valuation/evidence-notices/*/seen", (route) => {
      state.seen.push(route.request().postDataJSON());
      current = { ...current, notices: [] };
      return route.fulfill({ json: current });
    });
  }
  if (journal) await page.route("**/api/backend/research/SYNT/journal", (route) => route.fulfill({ json: journal }));
  return state;
}

export async function capture(page: Page, name: string, anchor = "#valuation-evidence",
  dir = process.env.VALUATION_MAINTENANCE_SCREENSHOTS_DIR) {
  if (!dir) return;
  await page.locator(anchor).evaluate((element) => {
    window.scrollBy({ top: element.getBoundingClientRect().top - (window.innerWidth < 768 ? 150 : 90), behavior: "instant" });
  });
  await page.screenshot({ scale: "css", path: join(dir, name + ".png") });
}
