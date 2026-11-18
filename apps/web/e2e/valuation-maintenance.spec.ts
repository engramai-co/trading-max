import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

// Synthetic research desk: a saved valuation version of one security reopened
// after a new report. Every backend response is fabricated in this file.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mx-research-index-open", "true");
    localStorage.setItem("mx-research-index-pinned", "true");
  });
});

const scenarios = ["bear", "base", "bull"] as const;
type Key = (typeof scenarios)[number];
type Inputs = { revenueCagr: number; targetFcfMargin: number; discountRate: number; exitFcfMultiple: number;
  shareCagr: number; rampYears: number };
const saved: Record<Key, Inputs> = {
  bear: { revenueCagr: 0.05, targetFcfMargin: 0.14, discountRate: 0.11, exitFcfMultiple: 13, shareCagr: 0, rampYears: 3 },
  base: { revenueCagr: 0.1, targetFcfMargin: 0.15, discountRate: 0.1, exitFcfMultiple: 15, shareCagr: 0, rampYears: 3 },
  bull: { revenueCagr: 0.15, targetFcfMargin: 0.16, discountRate: 0.09, exitFcfMultiple: 17, shareCagr: 0, rampYears: 3 },
};
const worth = (inputs: Inputs) => 100 * (1 + inputs.revenueCagr * 5);
const savedModel = {
  id: "saved-version", savedAt: "2026-08-03T10:00:00Z", previewId: "saved-preview",
  lockedInputs: [{ scenario: "base", field: "discount_rate" }],
};

function preview(inputs: Record<Key, Inputs>) {
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
function maintenance(body: { scenarios: Record<Key, Inputs>; lockedInputs: unknown[] }) {
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

function lens(view: string) {
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

async function desk(page: Page, { assistant = false } = {}) {
  const state = {
    reviews: [] as { modelId: string; scenarios: Record<Key, Inputs>; lockedInputs: unknown[] }[],
    saves: [] as Record<string, unknown>[],
    drafts: [] as Record<string, unknown>[],
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
    return route.fulfill({ json: maintenance(body) });
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
  return state;
}

async function capture(page: Page, name: string, anchor = "#valuation-evidence") {
  const dir = process.env.VALUATION_MAINTENANCE_SCREENSHOTS_DIR;
  if (!dir) return;
  await page.locator(anchor).evaluate((element) => {
    window.scrollBy({ top: element.getBoundingClientRect().top - (window.innerWidth < 768 ? 150 : 90), behavior: "instant" });
  });
  await page.screenshot({ scale: "css", path: join(dir, name + ".png") });
}

for (const locale of ["zh", "en"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`compare a saved version with new evidence without MaxAI · ${locale} · ${scheme}`, async ({ page }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    const en = locale === "en";
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
    const state = await desk(page);
    await page.goto("/research?ticker=SYNT&view=valuation");
    const editor = page.locator("#valuation-assumptions");
    const toggle = editor.getByRole("button", { name: en ? "See new evidence" : "看新证据", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(editor.getByRole("button", { name: en ? "✦ Draft" : "✦ 起草", exact: true })).toHaveCount(0);
    expect(state.reviews).toEqual([]);
    await toggle.click();
    const review = page.locator("#valuation-evidence");
    await expect(review).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const walk = review.locator("table");
    await expect(walk.locator("thead th")).toHaveText(en ? ["Bear", "Base", "Bull"] : ["保守", "中性", "乐观"]);
    const row = (label: string) => walk.locator("tbody tr").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });
    await expect(row(en ? "Saved 3 Aug" : "8月3日 保存").locator("td")).toHaveText(["US$117.65", "US$142.65", "US$167.65"]);
    await expect(row(en ? "New financial base" : "新财务基数").locator("td")).toHaveText(["+US$8.60", "+US$8.60", "+US$8.60"]);
    await expect(row(en ? "Of which restated" : "其中重述").locator("td")).toHaveText(["−US$2.40", "−US$2.40", "−US$2.40"]);
    await expect(row(en ? "Price and FX" : "价格与汇率").locator("td")).toHaveText(["−US$1.25", "−US$1.25", "−US$1.25"]);
    await expect(row(en ? "Changed assumptions" : "改动的假设").locator("td")).toHaveText(["US$0.00", "US$0.00", "US$0.00"]);
    await expect(row(en ? "New proposal" : "新提案").locator("td")).toHaveText(["US$125.00", "US$150.00", "US$175.00"]);
    await expect(walk.locator("td[data-selected]")).toHaveCount(6);
    const notes = review.locator(".mx-evidence-notes li");
    await expect(notes).toHaveCount(4);
    await expect(notes.nth(0)).toContainText(en ? "Restated" : "重述");
    await expect(notes.nth(0)).toContainText(en ? "4.00k → 3.85k USD" : "4,000 → 3,850 USD");
    await expect(notes.nth(1)).toContainText(en ? "Conflict" : "冲突");
    await expect(notes.nth(1)).toContainText(en ? "four quarters 4.30k · fiscal year 4.41k USD" : "四季合计 4,300 · 年报 4,410 USD");
    await expect(notes.nth(2)).toContainText(en ? "Revenue-growth consensus" : "营收增长一致预期");
    await expect(notes.nth(2)).toContainText("15.0% → 19.0%");
    await expect(notes.nth(3)).toContainText("2.50 → 2.70 USD");
    expect(state.reviews[0]).toMatchObject({ modelId: "saved-version", horizon: 5,
      lockedInputs: [{ scenario: "base", field: "discount_rate" }] });
    await review.locator("summary").click();
    await expect(review.locator(".mx-facts")).toContainText(en ? "Locked assumptions" : "锁定的假设");
    await capture(page, `${info.project.name}-${locale}-${scheme}`);
    await review.getByRole("button", { name: en ? "Restated" : "重述" }).first().click();
    await expect(page.getByRole("dialog")).toContainText(en ? "Of which restated" : "其中重述");
    await page.keyboard.press("Escape");
    expect(state.saves).toEqual([]);
    expect(state.drafts).toEqual([]);
    await review.getByRole("button", { name: en ? "Close new evidence" : "收起新证据" }).click();
    await expect(review).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });
}

test("a locked assumption is saved with the version and kept out of a MaxAI draft", async ({ page }, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const state = await desk(page, { assistant: true });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const growth = editor.getByLabel("Revenue growth · years 1–5", { exact: true });
  await expect(growth).toHaveValue("10%");
  const lock = editor.getByRole("button", { name: "Lock", exact: true });
  await expect(lock).toHaveAccessibleDescription("Revenue growth · years 1–5");
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await expect(growth).toHaveAttribute("readonly", "");
  await editor.getByRole("button", { name: /^Cost of equity/ }).click();
  await expect(lock).toHaveAccessibleDescription("Cost of equity");
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await capture(page, info.project.name + "-locks", "#valuation-assumptions");
  const locks = [{ scenario: "base", field: "discount_rate" }, { scenario: "base", field: "revenue_cagr" }];
  await editor.getByRole("button", { name: "See new evidence", exact: true }).click();
  await expect.poll(() => state.reviews.at(-1)?.lockedInputs).toEqual(locks);
  await editor.getByRole("button", { name: "✦ Draft", exact: true }).click();
  await expect.poll(() => state.drafts.length).toBe(1);
  expect(state.drafts[0]).toMatchObject({ lockedInputs: locks });
  await editor.getByRole("group", { name: "Edit scenario" }).getByRole("button", { name: "Bull", exact: true }).click();
  await editor.getByRole("button", { name: "Accept Revenue growth · years 1–5", exact: true }).click();
  await expect.poll(() => state.reviews.at(-1)?.scenarios.bull.revenueCagr).toBe(0.19);
  const assumptions = page.locator("#valuation-evidence tbody tr")
    .filter({ has: page.getByRole("rowheader", { name: "Changed assumptions", exact: true }) });
  await expect(assumptions.locator("td")).toHaveText(["US$0.00", "US$0.00", "+US$20.00"]);
  await editor.getByRole("button", { name: "Save model version", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save version", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({ lockedInputs: locks,
    draftReview: { id: "synthetic-draft", decisions: { bull: { revenue_cagr: "accepted" } } } });
});
