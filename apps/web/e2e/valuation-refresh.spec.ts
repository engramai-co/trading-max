import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { join } from "node:path";
import type { ResearchLensSnapshot } from "../lib/types";

// These cases read with the wide section index pinned; it starts closed for a new reader.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mx-research-index-open", "true");
    localStorage.setItem("mx-research-index-pinned", "true");
  });
});

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
      ticker, family: "cash-flow", quoteId: `${ticker}-quote`, dataVersion: `${ticker}-research`, currency: "USD",
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

function zeroRevenue(ticker: string, spot: number, asOf: string, value: number | null) {
  const p = preview(ticker, spot, asOf, true, {});
  return {
    ...p, formulaVersion: "statement-equity-v2",
    basis: { ...p.basis, family: "cash-flow", revenue: 0, startMargin: 0,
      periodChoice: "latest-fiscal-year", periodId: "annual:2025-12-31" },
    scenarios: {}, sensitivity: [], reverseMetric: "year-five-revenue",
    reverseValue: value, reverseReason: value === null ? "positive-target-and-multiple-required" : null,
    reverseInputs: { ...defaults, exitFcfMultiple: value === null ? 0 : defaults.exitFcfMultiple },
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

function peHistory(short = false): ResearchLensSnapshot["trailingPeHistory"] {
  const dates = Array.from({ length: 549 }, (_, index) => new Date(Date.UTC(2024, 0, 2 + index)))
    .filter((date) => date.getUTCDay() % 6 !== 0)
    .map((date) => date.toISOString().slice(0, 10));
  const earnings = [
    { effectiveDate: dates[0], periodEnd: "2023-09-30", eps: 4, method: "annual" as const },
    { effectiveDate: dates[132], periodEnd: "2024-03-31", eps: -0.25, method: "fourQuarters" as const },
    { effectiveDate: dates[152], periodEnd: "2024-06-30", eps: 5, method: "derivedFourthQuarter" as const },
  ];
  const points = (short ? dates.slice(0, 12) : dates).map((date, i, all) => {
    const earningsIndex = i < 132 ? 0 : i < 152 ? 1 : 2;
    const pe = earningsIndex === 1 ? null : i === all.length - 1 ? 28.4
      : 22 + i * 0.02 + Math.sin(i * 0.052) * 4 + Math.sin(i * 0.56) + Math.cos(i * 2.5) * 0.35;
    return { date, pe, close: pe === null ? 105 : pe * earnings[earningsIndex].eps, earningsIndex, notMeaningful: null };
  });
  const values = points.flatMap(({ pe }) => pe === null ? [] : [pe]).sort((a, b) => a - b);
  const quantile = (q: number) => {
    const rank = (values.length - 1) * q;
    const i = Math.floor(rank);
    return values[i] + (values[i + 1] - values[i]) * (rank - i);
  };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    currency: "USD",
    points,
    earnings,
    distribution: short ? null : {
      samples: values.length, lowerQuartile: quantile(0.25), median: quantile(0.5),
      upperQuartile: quantile(0.75), mean,
      standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
      latestPercentile: values.filter((value) => value <= 28.4).length / values.length,
    },
  };
}

function forwardHistory(short = false): ResearchLensSnapshot["forwardPeHistory"] {
  const points = Array.from({ length: short ? 5 : 46 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 1 + i + (i >= 23 ? 8 : 0))).toISOString().slice(0, 10);
    const eps = 6.12 + 0.015 * i;
    const pe = i === 0 ? 25 : 18 + i * 0.12 + Math.sin(i * 0.44) * 1.5 + Math.cos(i * 0.9) * 0.32;
    return {
      date, pe, eps, price: eps * pe,
      observedAt: date + "T21:30:00Z", priceAsOf: date + "T20:00:00Z",
      source: i === 0 ? "yahoo-forward-pe" as const : "yahoo-consensus" as const,
      recovered: i === 0,
    };
  });
  const values = points.slice(1).map((p) => p.pe).sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    currency: "USD",
    points,
    distribution: short ? null : {
      samples: values.length, lowerQuartile: values[11], median: values[22],
      upperQuartile: values[33], mean,
      standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
      latestPercentile: values.filter((value) => value <= points.at(-1)!.pe).length / values.length,
    },
  };
}

async function peScreenshot(page: Page, scenario: string, project: string) {
  const dir = process.env.PE2_QA_SCREENSHOTS_DIR;
  if (!dir) return;
  const section = page.locator(".mx-pe-history");
  // Centre above the fixed phone dock before capturing the chart's x-axis.
  await section.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await section.screenshot({ path: join(dir, `${project}-${scenario}.png`) });
}

async function synthetic(page: Page, running = true) {
  const state = {
    broker: { price: 100, asOf: "2026-11-04T15:40:00Z" },
    defaultsDown: false,
    publication: "synthetic-run",
    newResearch: false,
    trailingPe: null as ResearchLensSnapshot["trailingPeHistory"],
    forwardPe: null as ResearchLensSnapshot["forwardPeHistory"],
    evidence: {} as Record<string, unknown>,
    valuation: null as Record<string, unknown> | null,
    posts: [] as { ticker: string; scenarios: Record<string, Inputs> }[],
    releaseOther: () => {},
  };
  const otherDefaults = new Promise<void>((resolve) => { state.releaseOther = resolve; });
  await page.route("**/api/backend/**", (route) => route.fulfill({ status: 404, json: { detail: "synthetic" } }));
  await page.route("**/api/backend/health", (route) => route.fulfill({ json: {
    service: "trading_max-api", status: "ok", latestRunId: state.publication,
  } }));
  await page.route("**/api/company-logo/**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/backend/research/shell", (route) => route.fulfill({ json: {
    status: { runId: state.publication, overall: "fresh", artifacts: [] },
    watchlistCategories: [],
    instruments: [{ ...instrument("SYNT", 1, true, state.broker), lastRunId: state.publication, status: running ? "running" : "ready" }, instrument("OTHR", 2, false, state.broker)],
  } }));
  await page.route(/\/api\/backend\/research\/(SYNT|OTHR)\/lens\/(\w+)/, (route) => {
    const [, ticker, view] = /research\/(SYNT|OTHR)\/lens\/(\w+)/.exec(route.request().url())!;
    const data = {
      ...lens(ticker, view, ticker === "SYNT" ? 101 : 55),
      trailingPeHistory: ticker === "SYNT" && view === "valuation" ? state.trailingPe : null,
      forwardPeHistory: ticker === "SYNT" && view === "valuation" ? state.forwardPe : null,
      ...(ticker === "SYNT" ? { researchEvidence: state.evidence } : {}),
      ...(ticker === "SYNT" && state.valuation ? { valuation: state.valuation } : {}),
    };
    return route.fulfill({ json: state.newResearch && ticker === "SYNT" ? {
      ...data, runId: state.publication, financialFacts: { ...data.financialFacts, version: "new-facts" },
    } : data });
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
    const newDefaults = Object.fromEntries(scenarios.map((key) => [key, { ...defaults, revenueCagr: 0.33 }]));
    const data = preview(ticker, spot.price, spot.asOf, held, state.newResearch ? newDefaults : {});
    return route.fulfill({ json: state.newResearch ? { ...data, basis: { ...data.basis, dataVersion: "new-research" } } : data });
  });
  return state;
}

test.describe("valuation refresh", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test("a legacy estimate reference focuses the scenario while the model loads and after a 422", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await synthetic(page, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/SYNT/valuation-preview*", async (route) => {
      await gate;
      await route.fulfill({ status: 422, json: { detail: "synthetic missing inputs" } });
    });
    await page.goto("/research?ticker=SYNT&view=valuation&estimateRef=%2B1y");
    const section = page.locator("#research-scenario");
    await expect(section).toBeAttached();
    const heading = section.getByRole("heading").first();
    await expect.soft(heading).toBeFocused({ timeout: 1200 });
    release();
    await expect(section).toContainText("Matching statements, a quote and verified listing shares are required");
    await expect(heading).toBeFocused();
    await expect(page.getByRole("link", { name: "Scenario model" })).toHaveAttribute("aria-current", "location");
  });

  test("a delayed successful scenario bookmark focuses the valuation results", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await synthetic(page, false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/SYNT/valuation-preview*", async route => { await gate; await route.fallback(); });
    await page.goto("/research?ticker=SYNT&view=valuation&valuationView=scenario");
    await expect(page.getByRole("heading", { name: "Scenario model", exact: true })).toBeFocused();
    release();
    await expect(page.getByRole("heading", { name: "Scenario valuation", exact: true })).toBeFocused();
  });

  test("a model response never replays a completed scenario bookmark after the reader moves to History", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await synthetic(page, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/SYNT/valuation-preview*", async (route) => { await gate; await route.fallback(); });
    await page.goto("/research?ticker=SYNT&view=valuation&estimateRef=%2B1y");
    await expect(page.locator("#research-scenario h2").first()).toBeFocused();
    await page.keyboard.press("Home");
    const control = page.locator("#research-history button").first();
    await control.focus();
    release();
    await expect(page.locator("#valuation-assumptions")).toBeAttached();
    await expect(control).toBeFocused();
    await expect(page.getByRole("link", { name: "Historical valuation" })).toHaveAttribute("aria-current", "location");
  });

  test("a worksheet bookmark waits for its heading to mount", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await synthetic(page, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/SYNT/valuation-preview*", async (route) => { await gate; await route.fallback(); });
    await page.goto("/research?ticker=SYNT&view=valuation&valuationView=worksheet");
    await expect(page.locator("#research-scenario h2").first()).toBeAttached();
    await expect(page.locator("#research-worksheet")).toHaveCount(0);
    release();
    await expect(page.locator("#research-worksheet h2").first()).toBeFocused();
    await expect(page.getByRole("link", { name: "Worksheet" })).toHaveAttribute("aria-current", "location");
  });

  for (const { width, height } of [{ width: 800, height: 900 }, { width: 768, height: 1024 }]) {
    test(`a delayed target-margin reading keeps Historical valuation in place at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
      await synthetic(page, false);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/SYNT/valuation-preview*", async route => {
        await gate;
        const model = preview("SYNT", 100, "2026-11-04", true, {});
        await route.fulfill({ json: { ...model, formulaVersion: "statement-equity-v2", defaultSource: "sector-template",
          basis: { ...model.basis, family: "cash-flow", startMargin: -0.05 }, reverseMetric: "target-margin", reverseValue: 0.17,
        } });
      });
      await page.goto("/research?ticker=SYNT&view=valuation");
      const history = page.locator("#research-history");
      const reverse = page.locator(".mx-valuation-readout .mx-metric").nth(1);
      await expect(reverse).toContainText("Price-implied growth");
      await page.evaluate(() => document.fonts.ready);
      const top = (await history.boundingBox())!.y;
      release();
      await expect(reverse).toContainText("Target margin implied by price");
      await expect(reverse.locator(".mx-number-value")).toHaveText("17.0%");
      expect((await history.boundingBox())!.y).toBe(top);
    });

    for (const locale of ["en", "zh"] as const) {
      test(`a delayed floor keeps Historical valuation in place at ${width}×${height} · ${locale}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
        await synthetic(page, false);
        const history = page.locator("#research-history");
        const readout = page.locator(".mx-valuation-readout");
        const note = readout.getByText(locale === "en" ? "Negative equity value floored at zero" : "股权估值为负，按零计");
        const endpoint = "**/SYNT/valuation-preview*";
        let standardTop: number | undefined;
        for (const example of ["floored", "exact-zero", "larger-text", "narrow-pane"]) {
          let release!: () => void;
          const gate = new Promise<void>(resolve => { release = resolve; });
          const model = preview("SYNT", 100, "2026-11-04", true, {});
          const adjustment = example === "exact-zero" ? 0 : 3;
          Object.assign(model.scenarios.base, {
            operatingValue: -adjustment - 1, terminalPresentValue: 1, equityFloorAdjustment: adjustment, value: 0, upside: -1,
          });
          await page.route(endpoint, async route => { await gate; await route.fulfill({ json: model }); });
          await page.goto("/research?ticker=SYNT&view=valuation");
          if (example === "narrow-pane") {
            await page.locator(".mx-reading-container").evaluate(container => { container.style.maxWidth = "475px"; });
          }
          if (example === "larger-text") {
            await page.addStyleTag({ content: ".mx-valuation-readout .mx-valuation-floor { font-size: 32px; }" });
          }
          await expect(history).toBeVisible();
          await expect(note).toBeHidden();
          await page.evaluate(() => document.fonts.ready);
          const top = (await history.boundingBox())!.y;
          if (example === "floored") standardTop = top;
          if (example === "exact-zero") expect(top).toBe(standardTop);
          release();
          await expect(readout).toContainText("US$0.00");
          if (adjustment) await expect(note).toBeVisible();
          else await expect(note).toBeHidden();
          if (example === "larger-text") {
            const lines = await note.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
            expect(lines).toBeGreaterThan(1.5);
          }
          expect((await history.boundingBox())!.y).toBe(top);
          await page.unroute(endpoint);
        }
      });
    }
  }

  for (const example of ["large", "floored"] as const) {
    test(`the readout keeps its space and shows the signed gap for a ${example} base value`, async ({ page, isMobile }) => {
      if (isMobile) await page.setViewportSize({ width: example === "large" ? 320 : 390, height: 844 });
      await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
      await synthetic(page, false);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/SYNT/valuation-preview*", async (route) => {
        await gate;
        const model = preview("SYNT", 150000, "2026-11-04", true, {});
        model.basis.currency = "JPY";
        model.scenarios.base.value = example === "large" ? 135956.78 : 0;
        model.scenarios.base.equityFloorAdjustment = example === "floored" ? 3 : 0;
        model.scenarios.base.upside = model.scenarios.base.value / model.basis.spot - 1;
        await route.fulfill({ json: model });
      });
      await page.goto("/research?ticker=SYNT&view=valuation");
      const history = page.locator("#research-history");
      await expect(history).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await history.boundingBox();
      release();
      const readout = page.locator(".mx-valuation-readout");
      await expect(readout).toContainText(example === "large" ? "135,956.78" : "Negative equity value floored at zero");
      await expect.soft(readout).toContainText(example === "large" ? /[-−]9.4%/ : /[-−]100.0%/);
      expect.soft(Math.abs((await history.boundingBox())!.y - before!.y)).toBeLessThan(1);
      if (isMobile) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
        const metrics = await readout.locator(".mx-metric").evaluateAll((items) => items.map((node) => node.getBoundingClientRect().top));
        expect(metrics[1]).toBeGreaterThan(metrics[0]);
      }
    });
  }

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
    await expect(page.getByText("Matching statements, a quote and verified listing shares are required")).toHaveCount(0);

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
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page).toHaveURL(/ticker=OTHR/);
    await expect(page.locator(".mx-security-header h2")).toContainText("OTHR");
    await expect(spot).toHaveCount(0);
    state.releaseOther();
    await expect(spot).toContainText("55.00");
    await expect(spot).not.toContainText("120.00");
  });

  test("a failed quote refresh labels the retained year-five revenue and retries inline", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page);
    let receipt: Promise<void> | undefined;
    let release!: () => void;
    await page.route("**/SYNT/valuation-preview*", async route => {
      if (state.defaultsDown) return route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
      await receipt;
      return route.fulfill({ json: zeroRevenue("SYNT", state.broker.price, state.broker.asOf, state.broker.price * 1000) });
    });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const reverse = page.locator(".mx-valuation-readout .mx-metric").filter({ hasText: "Year-five revenue" });
    await expect(reverse).toContainText("US$100k");
    state.defaultsDown = true;
    state.broker = { price: 120, asOf: "2026-11-04T15:50:00Z" };
    await expect(page.locator(".mx-security-price")).toContainText("120.00");
    const failure = reverse.getByRole("alert");
    await expect(failure).toContainText("Not revalued at the latest price");
    await expect(reverse).toContainText("US$100k");
    state.defaultsDown = false;
    const retryButton = failure.getByRole("button", { name: "Retry" });
    const history = page.locator("#research-history");
    await retryButton.focus();
    const top = (await history.boundingBox())!.y;
    receipt = new Promise<void>(resolve => { release = resolve; });
    const request = page.waitForRequest("**/SYNT/valuation-preview*");
    await page.keyboard.press("Enter");
    await request;
    await expect.soft(retryButton).toBeFocused({ timeout: 1000 });
    expect.soft(Math.abs((await history.boundingBox())!.y - top)).toBeLessThan(1);
    release();
    await expect(reverse).toContainText("US$120k");
    await expect(failure).toHaveCount(0);
    await expect(reverse.getByText("US$120k", { exact: true })).toBeFocused();
    expect(Math.abs((await history.boundingBox())!.y - top)).toBeLessThan(1);

    state.defaultsDown = true;
    state.broker = { price: 140, asOf: "2026-11-04T16:00:00Z" };
    await expect(retryButton).toBeVisible();
    state.defaultsDown = false;
    receipt = new Promise<void>(resolve => { release = resolve; });
    await retryButton.focus();
    await page.keyboard.press("Enter");
    const other = reverse.getByRole("button", { name: /explained/ });
    await other.focus();
    release();
    await expect(reverse).toContainText("US$140k");
    await expect(other).toBeFocused();
  });

  test("new research defaults do not rebase dirty assumptions", async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    await page.goto("/research?ticker=SYNT&view=valuation");
    const growth = page.getByLabel("Revenue growth · years 1–5");
    await expect(growth).toHaveValue("10%");
    await growth.fill("20");
    await expect.poll(() => state.posts.at(-1)?.scenarios.base.revenueCagr).toBe(0.2);

    state.newResearch = true;
    state.publication = "synthetic-research-two";
    const fresh = page.waitForResponse((response) => response.url().endsWith("/SYNT/valuation-preview") &&
      response.request().method() === "GET" && response.ok());
    await page.clock.fastForward(60_000);
    const response = await (await fresh).json();
    expect(response.basis.dataVersion).toBe("new-research");
    await expect(growth).toHaveValue("20%");
    await expect(growth).toBeFocused();
    await expect(page).toHaveURL(/ticker=SYNT&view=valuation$/);
  });

  for (const [unit, scale, symbol] of [
    ["GBp", 100, "£"], ["GBP", 1, "£"], ["USD", 1, "US$"], ["EUR", 1, "€"],
  ] as const) {
    test(`live and saved valuations agree in ${unit}`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
      await synthetic(page, false);
      const data = preview("SYNT", 31 * scale, "2026-02-03", false, {});
      data.basis.currency = unit;
      for (const key of scenarios) {
        data.scenarios[key].value = 1.5 * scale;
        for (const year of data.scenarios[key].years) year.presentValue = 1.5 * scale;
      }
      for (const cell of data.sensitivity) cell.value = 1.5 * scale;
      const saved = { id: "frozen", savedAt: "2026-02-03T21:00:00Z", preview: data };
      await page.route("**/api/backend/research/SYNT/valuation-preview", (route) => route.fulfill({ json: data }));
      await page.route("**/api/backend/research/SYNT/journal", (route) => route.fulfill({ json: {
        ticker: "SYNT", notes: [], models: [saved],
      } }));
      const value = symbol + "1.50";
      await page.goto("/research?ticker=SYNT&view=valuation");
      await expect(page.locator(".mx-scenario-spot strong")).toHaveText(symbol + "31.00");
      await expect(page.locator(".mx-scenario-cards strong").first()).toHaveText(value);
      await expect.soft(page.locator(".mx-valuation-readout")).toContainText(value, { timeout: 1000 });
      await expect.soft(page.locator("#research-worksheet").getByRole("row", { name: /^Value per share/ })).toContainText(value, { timeout: 1000 });
      await expect.soft(page.locator(".mx-sensitivity-matrix td strong").first()).toHaveText("1.50", { timeout: 1000 });

      await page.goto("/research?ticker=SYNT&view=ledger&notebook=notes");
      await page.getByRole("button", { name: "New note" }).click();
      await page.getByRole("combobox", { name: "Related model version" }).click();
      await expect.soft(page.getByRole("option").first()).toContainText(value, { timeout: 1000 });

      await page.goto("/research?ticker=SYNT&view=ledger&notebook=models");
      const comparison = page.getByRole("region", { name: "Saved model comparison" });
      await expect.soft(comparison.getByRole("row", { name: /^Base value/ })).toContainText(value, { timeout: 1000 });
      await expect.soft(comparison.getByRole("row", { name: /^Price at save/ })).toContainText(symbol + "31.00", { timeout: 1000 });
      await comparison.getByRole("button", { name: "Open worksheet" }).click();
      await expect(page.getByRole("dialog")).toContainText("Value per share: " + value);
    });
  }

  test("archived vendor EPS keeps its unverified unit separate from the price", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    const history = forwardHistory(true)!;
    state.forwardPe = { ...history, currency: "GBp", points: [{
      ...history.points[0], price: 3100, eps: 200, pe: 15.5, source: "yahoo-forward-pe",
    }] };
    await page.goto("/research?ticker=SYNT&view=valuation");
    const section = page.locator(".mx-pe-history");
    const reading = section.locator(".mx-chart-readout-values");
    await expect(reading).toContainText("Price 31.00");
    await expect.soft(reading).toContainText("Forward EPS (unit unverified) 200.00", { timeout: 1000 });
    await section.locator(".mx-info").first().click();
    // Phones open the same help as a sheet.
    const help = page.locator(":is(.mx-help-popover, .mx-help-sheet)");
    await expect(help).toContainText("Price currency: GBP.");
    await expect(help).not.toContainText("Price and EPS currency");
  });

  test("trailing P/E reuses the lens and makes its basis readable from the chart", async ({ page, isMobile }, testInfo) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    state.trailingPe = peHistory();
    await page.goto("/research?ticker=SYNT&view=valuation");
    const section = page.locator(".mx-pe-history");
    const chart = section.getByRole("group", { name: /^Trailing P\/E history/ });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await expect(chart).toHaveAccessibleName(/^Trailing P\/E history · Historical percentile P\d+$/);
    await expect(section.getByRole("button", { name: "P25–P75" })).toHaveAttribute("aria-pressed", "true");

    await peScreenshot(page, "trailing-gap", testInfo.project.name);

    await chart.focus();
    await chart.press("Home");
    for (let i = 0; i < 132; i++) await chart.press("ArrowRight");
    // The chart speaks its reading in the live region beside it.
    const reading = section.locator(".mx-chart-readout-values");
    await expect(reading).toHaveAttribute("data-chart-reading", "selected");
    await expect(reading).toContainText("Not meaningful");
    await expect(reading).toContainText("EPS (TTM) −0.25");
    // A gap has no percentile; sources and units stay out of the reading.
    await expect(reading).not.toContainText("Percentile");
    await expect(reading).not.toContainText("USD");
    // On phones the reading strip sits over the panel's controls; close it before switching the band.
    await chart.press("Escape");
    const deviation = section.getByRole("button", { name: "Mean ±1σ" });
    await deviation.click();
    await expect(deviation).toHaveAttribute("aria-pressed", "true");
    await chart.focus();
    await chart.press("End");
    await expect(reading).toContainText("28.4×");
    await expect(reading).toContainText(/Percentile P\d+/);
    await expect(reading).toContainText("Close 142.00");
    await expect(reading).toContainText("EPS (TTM) 5.00");
    await expect(reading).toContainText("Inferred Q4");
    await expect(reading).not.toContainText("Yahoo");
    await chart.press("Escape");
    await expect(reading).toHaveAttribute("data-chart-reading", "latest");
    await expect(section.locator("summary").filter({ hasText: "Valuation at disclosure" })).toBeVisible();
  });

  test("trailing P/E omits distribution for short histories and stays absent without SEC data", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    state.trailingPe = peHistory(true);
    await page.goto("/research?ticker=SYNT&view=valuation");
    const chart = page.getByRole("group", { name: /^Trailing P\/E history/ });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await expect(chart).not.toHaveAccessibleName(/percentile/);
    await expect(page.getByRole("button", { name: "P25–P75" })).toHaveCount(0);
    state.releaseOther();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page).toHaveURL(/ticker=OTHR/);
    await expect(page.locator(".mx-scenario-spot")).toContainText("55.00");
    await expect(chart).toHaveCount(0);
  });

  test("the same chart switches to archived NTM and identifies its fallback", async ({ page, isMobile }, testInfo) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    state.trailingPe = peHistory();
    state.forwardPe = forwardHistory();
    let extra = 0;
    page.on("request", (request) => {
      if (/\/estimate-history|finance\.yahoo/.test(request.url())) extra++;
    });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const section = page.locator(".mx-pe-history");
    const modes = section.getByRole("group", { name: "Historical valuation basis" });
    const ntm = modes.getByRole("button", { name: isMobile ? "NTM" : "NTM P/E", exact: true });
    await ntm.click();
    await expect(ntm).toHaveAttribute("aria-pressed", "true");
    const chart = section.getByRole("group", { name: /^NTM P\/E history/ });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await expect(chart).toHaveAccessibleName(/Historical percentile P\d+/);
    await expect(section.getByRole("button", { name: "P25–P75" })).toHaveAttribute("aria-pressed", "true");
    await peScreenshot(page, "ntm-ranked", testInfo.project.name);
    await section.getByRole("button", { name: "Mean ±1σ" }).click();
    await expect(section.getByRole("button", { name: "Mean ±1σ" })).toHaveAttribute("aria-pressed", "true");
    await chart.focus();
    await chart.press("Home");
    const reading = section.locator(".mx-chart-readout-values");
    await expect(reading).toContainText("Fallback");
    await expect(reading).toContainText("Forward EPS");
    await chart.press("End");
    await expect(reading).toContainText("EPS (NTM)");
    await expect(reading).toContainText(/Percentile P\d+/);
    await expect(reading).not.toContainText("Fallback");
    await expect(reading).not.toContainText("Yahoo");
    expect(extra).toBe(0);
    const controls = (await modes.boundingBox())!;
    const bounds = (await section.boundingBox())!;
    expect(controls.x + controls.width).toBeLessThan(bounds.x + bounds.width);
  });

  test("the valuation index keeps assumptions mounted and wide tables scroll locally", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    state.trailingPe = peHistory();
    await page.goto("/research?ticker=SYNT&view=valuation&valuationView=scenario");
    const index = page.getByRole("navigation", { name: "On this page" });
    await expect(page.locator("#valuation-results h2")).toBeFocused();
    const growth = page.getByLabel("Revenue growth · years 1–5");
    await growth.fill("17");
    await expect.poll(() => state.posts.at(-1)?.scenarios.base.revenueCagr).toBe(0.17);
    await index.getByRole("link", { name: "Sensitivity" }).click();
    await expect(page.locator("#research-sensitivity h2")).toBeFocused();
    await expect(index.getByRole("link", { name: "Sensitivity" })).toHaveAttribute("aria-current", "location");
    await expect(growth).toHaveValue("17%");
    const matrix = page.getByRole("region", { name: "Two-dimensional sensitivity matrix" });
    if (isMobile) {
      for (const width of [320, 360, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await matrix.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }
    await index.getByRole("link", { name: "Historical valuation" }).click();
    await page.locator("#research-history summary").filter({ hasText: "Valuation at disclosure" }).click();
    await page.getByRole("group", { name: "Historical valuation basis" }).getByRole("button", { name: "P/S" }).click();
    await expect(page.locator("#research-history")).toContainText("P/S at disclosure");
  });

  test("a short NTM archive shows the latest multiple without a percentile", async ({ page, isMobile }, testInfo) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
    const state = await synthetic(page, false);
    state.forwardPe = forwardHistory(true);
    await page.goto("/research?ticker=SYNT&view=valuation");
    const section = page.locator(".mx-pe-history");
    const chart = section.getByRole("group", { name: /^NTM P\/E 历史/ });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await expect(chart).not.toHaveAccessibleName(/历史分位/);
    await expect(section.getByRole("button", { name: "P25–P75" })).toHaveCount(0);
    await expect(section.getByText("有效样本不足，暂无分位带")).toBeVisible();
    await peScreenshot(page, "ntm-short", testInfo.project.name);
    await section.getByRole("button", { name: isMobile ? "TTM" : "滚动 P/E" }).click();
    await expect(section.getByText("暂不支持滚动 P/E 历史")).toBeVisible();
  });

  test("withheld trailing multiples leave a gap and say why", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    // A break and its recovery, a growth-phase climb to about 300×, then EPS near zero (800×).
    state.trailingPe = withheldHistory([[2, 30], [20, 10, "segmentJump"], [2.1, 10, "segmentJump"], [2.2, 20],
      [0.5, 10], [0.133, 10], [0.05, 5, "aboveCap"]]);
    await page.goto("/research?ticker=SYNT&view=valuation");
    await expect(page.locator(".mx-valuation-readout .mx-metric").first()).toContainText("Not meaningful");
    const section = page.locator(".mx-pe-history");
    await expect(section.getByText("The latest P/E is above 400× and not meaningful")).toBeVisible();
    const chart = section.getByRole("group", { name: /^Trailing P\/E history/ });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await chart.focus();
    await chart.press("End");
    const reading = section.locator(".mx-chart-readout-values");
    await expect(reading).toContainText("Not meaningful");
    await expect(reading).toContainText("Above 400×");
    await expect(reading).toContainText("EPS (TTM) 0.05");
    await chart.press("Home");
    for (let i = 0; i < 35; i++) await chart.press("ArrowRight");
    await expect(reading).toContainText("Jumped over 5×");
    await expect(reading).toContainText("EPS (TTM) 20.00");
    // About 300× reads as a multiple.
    for (let i = 0; i < 50; i++) await chart.press("ArrowRight");
    await expect(reading.locator("span").filter({ hasText: /^(29|30)\d(\.\d{1,2})?×$/ })).toHaveCount(1);
    await expect(reading).not.toContainText("Not meaningful");
    await chart.press("Escape");
    await section.locator(".mx-info").first().click();
    const help = page.locator(":is(.mx-help-popover, .mx-help-sheet)");
    await expect(help).toContainText("above 400× (an earnings yield under 0.25%");
    await expect(help).toContainText("more than 5× away from the previous close");
  });

  test("a disclosure sample without a multiple is one line, not empty axes", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    state.trailingPe = peHistory();
    state.evidence = { releaseMultiples: [
      { publishedAt: "2025-02-27", priceDate: "2025-02-28", periodEnd: "2024-12-31", eps: -0.13, price: 24.02,
        currency: "USD", pe: null, state: "notMeaningful", url: "https://www.sec.gov/" },
      { publishedAt: "2026-02-09", priceDate: "2026-02-10", periodEnd: "2025-12-31", eps: -0.37, price: 148.7,
        currency: "USD", pe: null, state: "notMeaningful", url: "https://www.sec.gov/" },
    ] };
    await page.goto("/research?ticker=SYNT&view=valuation");
    const history = page.locator("#research-history");
    await history.locator("summary").filter({ hasText: "Valuation at disclosure" }).click();
    const sample = history.locator(".mx-multiple-context");
    await expect(sample).toContainText("Annual EPS was nonpositive at every filing; P/E is not meaningful");
    await expect(sample.locator("[data-tm-chart-ready], canvas, .mx-facts, table")).toHaveCount(0);
    await expect(sample).not.toContainText("×");
  });

  test("P/E time axes name the month or the year, never a bare day", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("trading_max-locale", "en");
      // ECharts draws axis labels on its canvas; keep what each canvas draws.
      const drawn: { text: string; canvas: HTMLCanvasElement }[] = [];
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
        drawn.push({ text: String(text), canvas: this.canvas });
        return maxWidth === undefined ? fill.call(this, text, x, y) : fill.call(this, text, x, y, maxWidth);
      };
      Object.assign(window, { drawnText: drawn });
    });
    const state = await synthetic(page, false);
    state.trailingPe = peHistory();
    state.forwardPe = forwardHistory(true);
    const timeLabels = () => page.evaluate(() => {
      const drawn = (window as unknown as { drawnText: { text: string; canvas: HTMLCanvasElement }[] }).drawnText;
      // Multiples carry ×, the latest point its percentile; the rest are dates.
      const labels = drawn.filter(({ canvas, text }) => canvas.isConnected && canvas.closest(".mx-pe-history") && !/×|^P\d/.test(text));
      return [...new Set(labels.map(({ text }) => text))];
    });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const section = page.locator(".mx-pe-history");
    await expect(section.getByRole("group", { name: /^Trailing P\/E history/ })).toHaveAttribute("data-tm-chart-ready", "true");
    // About eighteen months: months, with the year on January and before it.
    await expect.poll(timeLabels).toContain("2025");
    // en-GB writes September as "Sept".
    for (const label of await timeLabels()) expect(label).toMatch(/^([A-Z][a-z]{2,3}( \d{4})?|\d{4})$/);
    await section.getByRole("group", { name: "Historical valuation basis" }).getByRole("button", { name: /^NTM/ }).click();
    await expect(section.getByRole("group", { name: /^NTM P\/E history/ })).toHaveAttribute("data-tm-chart-ready", "true");
    // Five archive days: each label names its day and month.
    await expect.poll(async () => (await timeLabels()).filter((label) => / Aug/.test(label)).length).toBeGreaterThan(1);
    const days = (await timeLabels()).filter((label) => !/^([A-Z][a-z]{2,3}( \d{4})?|\d{4})$/.test(label));
    for (const label of days) expect(label).toMatch(/^\d{1,2} [A-Z][a-z]{2,3}( \d{4})?$/);
  });

  test("the scenario model names the sector template its assumptions start from", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page, false);
    state.valuation = { assumptions: { profile: "power-industrial" } };
    await page.route("**/SYNT/valuation-preview*", (route) => route.request().method() === "GET"
      ? route.fulfill({ json: { ...preview("SYNT", 100, "2026-11-04T15:40:00Z", true, {}), defaultSource: "sector-template" } })
      : route.fallback());
    await page.goto("/research?ticker=SYNT&view=valuation&valuationView=scenario");
    const source = page.locator("#valuation-assumptions .mx-assumption-source");
    await expect(source).toHaveText("Sector scenario template · Power & industrials");
    // In the panel header, never only inside the collapsed sources.
    await expect(source).toBeVisible();
    await page.locator("#valuation-assumption-sources summary").click();
    await expect(page.locator("#valuation-assumption-sources")).toContainText("Sector scenario template");
  });

});

/** Daily closes near 40, one EPS reading per segment, and the API's reason where it withholds a multiple. */
function withheldHistory(segments: [eps: number, count: number, reason?: "aboveCap" | "segmentJump"][]): ResearchLensSnapshot["trailingPeHistory"] {
  const dates = Array.from({ length: 400 }, (_, index) => new Date(Date.UTC(2025, 0, 2 + index)))
    .filter((date) => date.getUTCDay() % 6 !== 0)
    .map((date) => date.toISOString().slice(0, 10));
  const earnings: NonNullable<ResearchLensSnapshot["trailingPeHistory"]>["earnings"] = [];
  const points: NonNullable<ResearchLensSnapshot["trailingPeHistory"]>["points"] = [];
  segments.forEach(([eps, count, reason], index) => {
    earnings.push({ effectiveDate: dates[points.length], periodEnd: "2024-12-31", eps, method: "fourQuarters" });
    for (const date of dates.slice(points.length, points.length + count)) {
      const close = 40 + Math.sin(points.length / 6);
      points.push({ date, close, pe: reason ? null : close / eps, earningsIndex: index, notMeaningful: reason ?? null });
    }
  });
  return { currency: "USD", points, earnings, distribution: null };
}

/** NYSE sessions in winter (UTC), weekdays only. */
function nyseSessions(from: string, to: string) {
  const sessions = [];
  for (let day = Date.parse(from + "T00:00:00Z"); day <= Date.parse(to + "T00:00:00Z"); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (new Date(day).getUTCDay() % 6 !== 0) sessions.push({ date, open: date + "T14:30:00Z", close: date + "T21:00:00Z" });
  }
  return sessions;
}

/** An analyst lens priced on Wednesday 18 November at 16:00 UTC, with daily closes through `lastClose`.
 * The held line is quoted at its broker price, so the broker reports at that time as well. */
async function expectations(page: Page, lastClose: string) {
  const state = await synthetic(page, false);
  state.broker = { price: 101, asOf: "2026-11-18T16:00:00Z" };
  const base = lens("SYNT", "analyst", 101);
  await page.route(/\/api\/backend\/research\/SYNT\/lens\/analyst/, (route) => route.fulfill({ json: {
    ...base,
    context: { ...base.context, quote: { ...base.context.quote, asOf: "2026-11-18T16:00:00Z",
      schedule: { calendar: "XNYS", sessions: nyseSessions("2026-11-02", "2026-11-27"), until: "2026-11-30T14:30:00Z" } } },
    analyst: {
      asOf: "2026-11-18", reportingCurrency: "USD", providerRecommendationKey: "buy",
      priceTargets: { low: 85, median: 112, mean: 114, high: 138 },
      recommendations: [{ period: "0m", strongBuy: 3, buy: 5, hold: 4, sell: 1, strongSell: 0 }],
      earningsEvents: [{ id: "event1", date: "2026-07-28", instant: "2026-07-28T16:05:00-04:00", timezone: "America/New_York",
        precision: "minute", status: "reported", actualEps: 1.9, estimatedEps: 1.8, currency: "USD" }],
    },
  } }));
  const closes = nyseSessions("2025-12-01", lastClose).map(({ date }, index) => ({ date, close: 95 + (index % 7) }));
  await page.route("**/api/backend/research/SYNT/prices?**", (route) => route.fulfill({ json: {
    ticker: "SYNT", currency: "USD", actualInterval: "1d", points: closes,
  } }));
}

test.describe("expectations timing", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  for (const [zone, time] of [["Europe/London", "21:05"], ["Asia/Shanghai", "29 Jul, 04:05"]] as const) {
    test(`earnings times read on the reader's clock · ${zone}`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem("trading_max-locale", "en");
        localStorage.setItem("trading_max-time-zone", value);
      }, zone);
      await expectations(page, "2026-11-17");
      await page.goto("/research?ticker=SYNT&view=analyst&analystView=events");
      const events = page.getByRole("region", { name: "Earnings calendar" }).first();
      await expect(events).toContainText(time);
      await expect(events).not.toContainText(/GMT|UTC/);
    });
  }

  for (const [lastClose, late] of [["2026-11-17", false], ["2026-11-16", true]] as const) {
    test(`price history through ${lastClose} is ${late ? "late" : "current"} against Wednesday's price`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
      await expectations(page, lastClose);
      await page.goto("/research?ticker=SYNT&view=analyst");
      const note = page.getByText(/^Price history through \d{1,2} Nov/);
      await expect(note).toHaveText(new RegExp(`^Price history through ${Number(lastClose.slice(8))} Nov`));
      if (late) await expect(note).not.toHaveAttribute("data-tone", "muted");
      else await expect(note).toHaveAttribute("data-tone", "muted");
    });
  }
});

for (const locale of ["en", "zh"] as const) {
  test(`disclose a floored valuation and distinguish an unverified share unit · ${locale}`, async ({ page, isMobile }) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
    await synthetic(page, false);
    let error: string | undefined;
    let raw = -3;
    await page.route("**/SYNT/valuation-preview*", route => {
      if (error) return route.fulfill({ status: 422, json: { detail: error } });
      const p = preview("SYNT", 100, "2026-11-04T15:40:00Z", false, {});
      const base = p.scenarios.base;
      base.operatingValue = raw - 1;
      base.terminalPresentValue = 1;
      base.equityFloorAdjustment = Math.max(0, -raw);
      base.value = Math.max(0, raw);
      base.upside = base.value / p.basis.spot - 1;
      return route.fulfill({ json: { ...p, formulaVersion: "statement-equity-v2" } });
    });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const row = page.locator(".mx-valuation-readout .mx-metric").last();
    const cards = page.locator(".mx-scenario-cards button");
    const reason = locale === "en" ? "Negative equity value floored at zero" : "股权估值为负，按零计";
    const readout = row.locator(".mx-number-value");
    await expect(readout).toContainText("US$0.00");
    await expect(row.getByText(reason, { exact: true })).toBeVisible();
    await expect(cards.nth(1)).toContainText(locale === "en" ? "Zero floor" : "按零计");
    await expect(cards.first()).not.toContainText(locale === "en" ? "Zero floor" : "按零计");
    for (raw of [0, 0.003]) {
      await page.reload();
      await expect(readout).toContainText("US$0.00");
      await expect(row).not.toContainText(reason);
      await expect(cards.nth(1)).not.toContainText(locale === "en" ? "Zero floor" : "按零计");
    }
    const panel = page.locator("#valuation-assumptions");
    error = "listed-share-unit-unverified";
    await page.reload();
    const missingUnit = locale === "en" ? "Share unit unverified for this listing" : "上市股数口径未核实";
    await expect(panel).toContainText(missingUnit);
    await expect(row).toContainText(missingUnit);
    error = "receipt-ratio-unverified";
    await page.reload();
    const ratio = locale === "en" ? "Ordinary shares per receipt unverified" : "存托凭证换股比例未核实";
    await expect(panel).toContainText(ratio);
    await expect(row).toContainText(ratio);
    error = "complete-ttm-currency-and-share-count-required";
    await page.reload();
    await expect(panel).toContainText(locale === "en"
      ? "Matching statements, a quote and verified listing shares are required" : "此模型缺少完整同期报表、报价或上市股数");
  });
}

for (const locale of ["en", "zh"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`switch valuation family and inspect ROE · ${locale} · ${scheme}`, async ({ page }, info) => {
      test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
      await page.setViewportSize(
        info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      );
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
      await synthetic(page, false);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let residualGets = 0;
      await page.route(/\/SYNT\/valuation-preview/, async (route) => {
        const req = route.request();
        const family =
          new URL(req.url()).searchParams.get("family") ??
          (req.method() === "POST" ? req.postDataJSON().family : undefined) ??
          "cash-flow";
        if (family === "residual-income" && req.method() === "GET") {
          residualGets++;
          await gate;
        }
        const p = preview("SYNT", 100, "2026-11-04T15:40:00Z", false, {});
        const projections = Object.fromEntries(
          Object.entries(p.scenarios).map(([key, value]) => [
            key,
            {
              ...value,
              ...(family === "residual-income" && { terminalPremiumPresentValue: 0, terminalContribution: 1 }),
              inputs: { ...value.inputs, rampYears: 4, initialRoe: 0.15, payout: 0, terminalPb: 1 },
            },
          ]),
        );
        return route.fulfill({
          json: {
            ...p,
            scenarios: projections,
            formulaVersion: "statement-equity-v2",
            basis: {
              ...p.basis,
              family,
              bookPerShare: 25,
              commonEarnings: 150,
              periodId: "annual:2025-12-31",
              reportingCurrency: "USD",
              fxRate: 1,
            },
            reverseMetric: family === "residual-income" ? "initial-roe" : "revenue-growth",
            reverseValue: 0.18,
          },
        });
      });
      await page.goto("/research?ticker=SYNT&view=valuation");
      const select = page.locator("#valuation-assumptions").getByRole("combobox", {
        name: locale === "en" ? "Valuation model" : "估值模型",
        exact: true,
      });
      const cash = locale === "en" ? "Equity cash flow" : "股权现金流";
      const name = locale === "en" ? "Residual income" : "剩余收益";
      const roe = page.getByLabel(locale === "en" ? "Year-one ROE" : "第一年 ROE", { exact: true });
      const firstScenario = page.getByRole("group", { name: locale === "en" ? "Edit scenario" : "编辑情景" })
        .getByRole("button", { name: locale === "en" ? "Bear" : "保守", exact: true });
      await expect(select).toHaveValue(cash);
      async function choose(direction: "ArrowUp" | "ArrowDown") {
        await select.focus();
        await page.keyboard.press(direction);
        await expect(select).toHaveAttribute("aria-expanded", "true");
        await page.keyboard.press(direction);
        await page.keyboard.press("Enter");
      }
      for (const cached of [false, true]) {
        // The dark cases exercise the reader scrolling away with the selector still focused.
        let readerScroll: number | undefined;
        await choose("ArrowUp");
        await expect(select).toHaveValue(name);
        if (!cached) {
          await expect.poll(() => residualGets).toBe(1);
          await expect(select).toBeFocused();
          await expect(select).toBeInViewport();
          const heading = page.locator("#valuation-assumptions .mx-panel-heading");
          await expect.soft(heading.locator(".mx-info")).toBeHidden({ timeout: 500 });
          await expect.soft(heading.locator('a[href="#valuation-results"]')).toBeHidden({ timeout: 500 });
          if (scheme === "dark") {
            readerScroll = await page.evaluate(() => new Promise<number>(resolve => {
              window.addEventListener("scroll", () => resolve(window.scrollY), { once: true });
              window.scrollBy({ top: -420, behavior: "instant" });
            }));
          }
          release();
        }
        await expect(roe).toBeVisible();
        await expect(select).toBeFocused();
        if (readerScroll !== undefined) {
          expect(Math.abs(await page.evaluate(() => window.scrollY) - readerScroll)).toBeLessThan(1);
        } else {
          await expect(select).toBeInViewport();
        }
        await page.keyboard.press("Tab");
        // WebKit on iOS tabs directly to the next editable field.
        await expect(info.project.name === "mobile" ? roe : firstScenario).toBeFocused();
        if (!cached) {
          await choose("ArrowDown");
          await expect(select).toHaveValue(cash);
          await expect(page.getByLabel(locale === "en" ? "Revenue growth · years 1–5" : "前五年营收增长", { exact: true })).toBeVisible();
        }
      }
      expect(residualGets).toBe(1);
      const readout = page.locator(".mx-valuation-readout");
      await expect(readout.getByText(locale === "en" ? "Year-one ROE implied by price" : "现价隐含的第一年 ROE", { exact: true })).toBeVisible();
      await expect(readout).toContainText("18.0%");
      await expect(readout).toContainText("15.0%");
      const reference = page.locator(".mx-model-reference-grid");
      await expect(reference.getByText(locale === "en" ? "Book value per share" : "每股净资产", { exact: true })).toBeVisible();
      await expect(reference.getByText("2025-12-31", { exact: false })).toBeVisible();
      await expect(page.getByRole("heading", {
        name: locale === "en" ? "Revenue-growth reference" : "营收增长参考",
      })).toHaveCount(0);
      const dir = process.env.VALUATION_QA_SCREENSHOTS_DIR;
      if (dir) {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await expect(readout).toBeInViewport();
        await page.screenshot({ scale: "css", path: join(dir, `residual-income-${info.project.name}-${locale}-${scheme}.png`) });
      }
      await page.getByRole("link", { name: locale === "en" ? "Worksheet" : "计算底稿", exact: true }).click();
      await expect(page.getByText(locale === "en" ? "Discounted terminal premium" : "期末溢价现值", { exact: true })).toBeVisible();
      await expect(page.getByRole("row", {
        name: locale === "en" ? /Discounted exit price \/ value/ : /期末卖出价现值占每股价值/,
      })).toContainText("100.0%");
      await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

for (const example of ["bounded-margin", "ambiguous-margin"] as const) {
  test(`the valuation readout uses the published ${example} result`, async ({ page, isMobile }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const ticker = "CASH";
    const state = await synthetic(page, false);
    await page.route("**/api/backend/research/shell", route => route.fulfill({ json: {
      status: { runId: state.publication, overall: "fresh", artifacts: [] }, watchlistCategories: [],
      instruments: [instrument(ticker, 1, false, state.broker)],
    } }));
    await page.route(`**/research/${ticker}/lens/*`, route => {
      const view = new URL(route.request().url()).pathname.split("/").at(-1)!;
      return route.fulfill({ json: { ...lens(ticker, view, 55), trailingPeHistory: peHistory() } });
    });
    await page.route(`**/research/${ticker}/valuation-preview*`, route => {
      const p = preview(ticker, 55, "2026-11-03T21:00:03Z", false, {});
      return route.fulfill({ json: {
        ...p, formulaVersion: "statement-equity-v2",
        basis: { ...p.basis, family: "cash-flow", revenue: 1000, startMargin: -0.05 },
        reverseMetric: "target-margin", reverseLimits: [-1, 1], reverseValue: null,
        reverseReason: example === "ambiguous-margin" ? "target-margin-not-unique" : null,
        reverseBound: example === "bounded-margin" ? "above" : null,
      } });
    });
    await page.goto(`/research?ticker=${ticker}&view=valuation`);
    const row = page.locator(".mx-valuation-readout");
    const reverse = row.locator(".mx-metric").filter({ hasText: "Target margin implied by price" });
    const expected = example === "bounded-margin" ? ">100.0%" : "—";
    await expect(reverse.locator(".mx-number-value")).toHaveText(expected);
    await expect(reverse).toContainText("15.0%");
    if (example === "ambiguous-margin") await expect(reverse).toContainText("No unique estimate");
    await expect(page.locator("#valuation-assumptions").getByRole("combobox", { name: "Valuation model" })).toBeVisible();
    const dir = process.env.VALUATION_QA_SCREENSHOTS_DIR;
    if (dir) await page.screenshot({ scale: "css", path: join(dir, `${example}-${info.project.name}.png`) });
  });
}

for (const locale of ["en", "zh"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`delayed zero-revenue reading reserves space · ${locale} · ${scheme}`, async ({ page, isMobile }, info) => {
      test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
      await synthetic(page, false);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let value: number | null = 1_149_132_000_123.45;
      await page.route("**/SYNT/valuation-preview*", async route => {
        await gate;
        await route.fulfill({ json: zeroRevenue("SYNT", 100, "2026-11-04T15:40:00Z", value) });
      });
      await page.goto("/research?ticker=SYNT&view=valuation");
      const history = page.locator("#research-history");
      await expect(history).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const top = (await history.boundingBox())!.y;
      release();
      const label = locale === "en" ? "Year-five revenue implied by price" : "现价隐含的第五年营收";
      const row = page.locator(".mx-valuation-readout");
      const reverse = row.locator(".mx-metric").filter({ hasText: label });
      await expect(reverse.locator(".mx-number-value")).toHaveText(/1,149b/);
      await expect(reverse).toContainText("15.0%");
      await expect(reverse).toContainText("15×");
      await expect(row.locator(".mx-metric").last().locator(".mx-number-value")).toHaveText("—");
      expect(Math.abs((await history.boundingBox())!.y - top)).toBeLessThan(1);
      const detail = page.locator("#valuation-assumptions");
      await expect(detail).toContainText("1,149,132,000,123.45");
      await expect(detail).toContainText(locale === "en" ? "Last fiscal year · 2025-12-31" : "上一财年 · 2025-12-31");
      await expect(detail).not.toContainText("annual:");
      await expect(detail).not.toContainText(locale === "en" ? "Target margin" : "目标利润率");
      await expect(detail).not.toContainText(locale === "en" ? "Exit multiple" : "退出倍数");
      await expect(page.locator("#research-sensitivity, #research-worksheet")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
      const dir = process.env.VALUATION_QA_SCREENSHOTS_DIR;
      if (dir) await page.screenshot({ scale: "css", path: join(dir, `zero-revenue-${info.project.name}-${locale}-${scheme}.png`) });

      value = null;
      await page.reload();
      await expect(reverse.locator(".mx-number-value")).toHaveText("—");
      await expect(reverse).toContainText(locale === "en" ? "Margin and multiple must be positive" : "利润率与倍数须为正");
    });
  }
}

test("set and clear a saved valuation baseline from its journal", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await synthetic(page, false);
  const journal = {
    ticker: "SYNT",
    notes: [],
    baselineModelId: null as string | null,
    models: [
      {
        id: "model-one",
        savedAt: "2026-10-20T12:00:00Z",
        reason: "Synthetic baseline",
        preview: preview("SYNT", 100, "2026-10-20", false, {}),
      },
    ],
  };
  await page.route("**/research/SYNT/journal", (r) => r.fulfill({ json: journal }));
  await page.route("**/research/SYNT/models/baseline", (r) => {
    expect(r.request().method()).toBe("PUT");
    journal.baselineModelId = r.request().postDataJSON().modelId;
    return r.fulfill({ json: journal });
  });
  await page.goto("/research?ticker=SYNT&view=ledger&notebook=models");
  await page.getByRole("button", { name: "Set as baseline" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Clear baseline" })).toHaveAttribute("aria-pressed", "true");
  expect(journal.baselineModelId).toBe("model-one");
  await page.getByRole("button", { name: "Clear baseline" }).click();
  await expect(page.getByRole("button", { name: "Set as baseline" })).toHaveAttribute("aria-pressed", "false");
  expect(journal.baselineModelId).toBe(null);
});

const draftProposals = [
  { scenario: "base", field: "revenue_cagr", value: 0.19, category: "consensus", source: "consensus-growth", evidenceIds: ["estimate"] },
  { scenario: "base", field: "target_fcf_margin", value: 0.12, category: "derived", source: "statement-margin", evidenceIds: ["statement", "revenue"] },
  { scenario: "bear", field: "discount_rate", value: 0.12, category: "template", source: "sector-template", originId: "template", evidenceIds: [] },
];
const draftResponse = { phase: "complete", result: { id: "synthetic-draft", snapshotId:"synthetic-run", family:"cash-flow", familySelection:"automatic", proposals: draftProposals, deskReadings:{base:{value:183, upside:.83}, bear:{value:141,upside:.41}, bull:{value:150,upside:.5}},
  origins: { template: { source: "sector-template", inputs: { profile:"hardware", effectiveDiscountRate:.1, annualRevenueGrowth:.1,
    growthCap:.3, marginCap:.18, shareCagr:.01, exitMultiple:16, basis:{startMargin:.12} },
    scenarios:{bear:{discountRate:.12}}, evidenceIds:["statement"] } },
  evidence: {
    estimate: { locator: { dataset: "analyst" }, metric: "consensusRevenueGrowth", period: {kind:"forecast",forecastSlot:"+1y",end:"2026-12-31"},
      publishedAt:"2025-12-20", observedAt:"2026-11-03T21:00:00Z", value: 0.19, unit: "ratio" },
    statement: { locator: { dataset: "financials" }, metric: "freeCashflow", period: {kind:"annual",end:"2025-12-31"},
      observedAt:"2026-02-10T21:00:00Z", value: 120, unit: "currency", currency: "USD" },
    revenue: { locator: { dataset: "financials" }, metric: "revenue", period: {kind:"annual",end:"2025-12-31"},
      observedAt:"2026-02-10T21:00:00Z", value: 1000, unit: "currency", currency: "USD" },
  } } };

async function captureDraft(page: Page, project: string, locale: string, scheme: string, example: string, anchor = "#valuation-assumptions") {
  const dir = process.env.VALUATION_DRAFT_SCREENSHOTS_DIR;
  if (!dir) return;
  await page.locator(anchor).evaluate(el => {
    window.scrollBy({top: el.getBoundingClientRect().top - (window.innerWidth < 768 ? 140 : 75), behavior: "instant"});
  });
  if (project === "desktop") {
    await expect(page.locator("#valuation-results canvas").first()).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  await page.screenshot({scale: "css", path: join(dir, `${example}-${project}-${locale}-${scheme}.png`)});
}

for (const locale of ["en", "zh"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`stage a valuation draft field and review the changed basis · ${locale} · ${scheme}`, async ({ page }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    const en = locale === "en";
    await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
    await synthetic(page, false);
    await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:true}}));
    await page.route("**/SYNT/valuation-preview*", async route => {
      const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
      const p = preview("SYNT", 100, "2026-11-04T15:40:00Z", true, body?.scenarios ?? {});
      return route.fulfill({json: {...p, formulaVersion:"statement-equity-v2",
        scenarios:Object.fromEntries(Object.entries(p.scenarios).map(([key, scenario]) => [key, {
          ...scenario, inputs:{rampYears:3, ...scenario.inputs},
        }])), reverseMetric:"revenue-growth", reverseValue:p.impliedGrowth}});
    });
    let runs = 0;
    await page.route("**/SYNT/valuation-draft", route => {
      runs++;
      return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(draftResponse) + "\n" });
    });
    let saved: Record<string, unknown> | null = null;
    await page.route("**/SYNT/models", route => { saved = route.request().postDataJSON(); return route.fulfill({
      status: 409, json: { detail: "valuation-draft-review-required" },
    }); });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const editor = page.locator("#valuation-assumptions");
    const entry = editor.getByRole("button", { name: en ? "✦ Draft" : "✦ 起草", exact: true });
    await expect(entry).toBeVisible();
    expect(runs).toBe(0);
    await entry.click();
    const growth = en ? "Revenue growth · years 1–5" : "前五年营收增长";
    const margin = en ? "Target FCF margin" : "目标现金流率";
    const accept = editor.getByRole("button", {name: (en ? "Accept " : "接受 ") + growth, exact: true});
    await expect(page.locator(".mx-scenario-cards button[aria-pressed=true] .mx-draft-reading")).toContainText("183.00");
    await expect(page.locator(".mx-draft-reading")).toHaveCount(2);
    await accept.focus();
    await accept.press("Enter");
    await expect(accept).toHaveAttribute("aria-pressed","true");
    await expect(page.locator(".mx-scenario-cards button[aria-pressed=true] .mx-draft-reading")).toContainText("195.00");
    expect(saved).toBeNull();
    await expect(editor.getByRole("link", {name: en ? "Analysts" : "分析师", exact:true})).toHaveAttribute("href", "#draft-evidence-estimate");
    await expect(accept.locator("xpath=ancestor::div[contains(@class,'mx-draft-row')]")).toContainText(en ? "As of" : "截至");
    await captureDraft(page, info.project.name, locale, scheme, "cash-flow");
    await editor.getByRole("link", { name: en ? "Analysts" : "分析师", exact:true }).first().click();
    const evidence = page.locator("#draft-evidence-estimate");
    await expect(evidence).toContainText("19%");
    await expect(evidence).toContainText(en ? "Next fiscal year" : "下一财年");
    await expect(evidence).toContainText(en ? "As of 20 Dec 2025" : "截至 2025年12月20日");
    await expect(evidence.getByRole("link")).toHaveAttribute("href", /view=analyst/);
    await editor.getByRole("button", {name:(en ? "Reject " : "拒绝 ") + margin, exact:true}).click();
    await editor.getByRole("button", {name:en ? "Save model version" : "保存模型版本",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:en ? "Save version" : "保存版本",exact:true}).click();
    await expect(page.getByRole("dialog").getByRole("button",{name:en ? "Reload for review" : "重新载入并重审"})).toBeVisible();
    expect(saved).toMatchObject({scenarios:{base:{revenueCagr:0.19,targetFcfMargin:0.15}},
      draftReview:{decisions:{base:{revenue_cagr:"accepted",target_fcf_margin:"rejected"},bear:{discount_rate:"unreviewed"}}}});
    expect(runs).toBe(1);
  });
}

for (const locale of ["en", "zh"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`review a bank assumption and withhold an ambiguous reading · ${locale} · ${scheme}`, async ({page}, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    await page.setViewportSize(info.project.name === "mobile" ? {width:390, height:844} : {width:1440, height:900});
    await page.emulateMedia({colorScheme:scheme, reducedMotion:"reduce"});
    await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
    await synthetic(page, false);
    await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:true}}));
    let withheld = false;
    let runs = 0;
    await page.route("**/SYNT/valuation-preview*", route => {
      const post = route.request().method() === "POST" ? route.request().postDataJSON() : undefined;
      const p = preview("SYNT", 100, "2026-11-04T15:40:00Z", false, {});
      return route.fulfill({json: {...p, formulaVersion:"statement-equity-v2",
        basis:{...p.basis, family:withheld ? "cash-flow" : "residual-income", bookPerShare:25, commonEarnings:150},
        scenarios: Object.fromEntries(Object.entries(p.scenarios).map(([k,v]) => [k,{...v,
          inputs: post?.scenarios[k] ?? {...v.inputs, initialRoe:0.15, payout:0.3, terminalPb:1, rampYears:3}}])),
        reverseMetric: withheld ? "target-margin" : "initial-roe", reverseValue: withheld ? null : 0.18,
        reverseReason: withheld ? "target-margin-not-unique" : null,
      }});
    });
    await page.route("**/SYNT/valuation-draft", route => {
      runs++;
      const evidence = {
        earnings: {...draftResponse.result.evidence.statement, metric:"netIncome", value:200},
        equity: {...draftResponse.result.evidence.revenue, metric:"commonEquity"},
      };
      return route.fulfill({contentType:"application/x-ndjson", body:JSON.stringify({phase:"complete", result:{
        id:"bank-draft", deskReadings:{base:{value:175,upside:.75}}, snapshotId:"synthetic-run", family:"residual-income", familySelection:"automatic", origins:{}, evidence,
        proposals:[{scenario:"base", field:"initial_roe", category:"derived", source:"common-roe",
          value:0.2, evidenceIds:["earnings","equity"]}],
      }})+"\n"});
    });
    const en = locale === "en";
    const editor = page.locator("#valuation-assumptions");
    const entry = editor.getByRole("button", {name: en ? "✦ Draft" : "✦ 起草"});
    await page.goto("/research?ticker=SYNT&view=valuation");
    await entry.click();
    await expect(editor.locator(".mx-draft-row")).toHaveCount(1);
    const accept = editor.getByRole("button", {name:en ? "Accept Year-one ROE" : "接受 第一年 ROE"});
    await accept.click();
    await expect(accept).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mx-draft-reading")).not.toContainText("…");
    await captureDraft(page, info.project.name, locale, scheme, "residual-income");
    await editor.getByRole("button", {name:en ? "Discard draft" : "放弃草稿"}).click();
    withheld = true;
    await page.reload();
    await expect(entry).toBeDisabled();
    await expect(editor.locator("#valuation-draft-block")).toContainText(en ? "unique target margin" : "唯一的目标利润率");
    await expect(editor.locator(".mx-draft-row")).toHaveCount(0);
    await captureDraft(page, info.project.name, locale, scheme, "withheld");
    expect(runs).toBe(1);
  });
}

test("a missing valuation basis disables drafting without starting a run", async ({page}) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await synthetic(page, false);
  await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:true}}));
  await page.route("**/SYNT/valuation-preview*", route => route.fulfill({status:422,json:{detail:"complete-ttm-currency-and-share-count-required"}}));
  let runs = 0;
  await page.route("**/SYNT/valuation-draft", route => { runs++; return route.abort(); });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor=page.locator("#valuation-assumptions");
  await expect(editor.getByRole("button",{name:"✦ Draft"})).toBeDisabled();
  await expect(editor.locator("#valuation-draft-block")).toContainText("verified listing shares");
  expect(runs).toBe(0);
});

test("cancel a valuation draft and discard a late proposal", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await synthetic(page, false);
  await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:true}}));
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/SYNT/valuation-draft", async route => {
    await delayed;
    await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(draftResponse) + "\n" }).catch(() => {});
  });
  await page.route("**/SYNT/valuation-preview*", route => route.fulfill({
    json:{...preview("SYNT",100,"2026-11-04T15:40:00Z",true,{}),defaultSource:"saved-model"},
  }));
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const entry = editor.getByRole("button",{name:"✦ Draft",exact:true});
  await expect(entry).toHaveAccessibleDescription("");
  await expect(entry).not.toHaveAttribute("title", /.+/);
  const status = editor.locator('[role="status"][aria-atomic="true"]');
  await expect(status).toHaveText("");
  await status.evaluate(el => el.setAttribute("data-original-region", "true"));
  await entry.click();
  await expect(status).toContainText("Reading valuation basis");
  await editor.getByRole("button",{name:"Cancel draft",exact:true}).click();
  await expect(status).toContainText("Draft cancelled");
  await expect(status).toHaveAttribute("data-original-region","true");
  release();
  await expect(editor.getByRole("button",{name:"✦ Draft",exact:true})).toBeVisible();
  await expect(editor.locator(".mx-draft-row")).toHaveCount(0);
  await expect(editor.getByLabel("Revenue growth · years 1–5")).toHaveValue("10%");
  await entry.click();
  await expect(status).toContainText("proposed");
  await expect(status).toHaveAttribute("data-original-region","true");
});

async function reviewDraft(page: Page) {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const state = await synthetic(page, false);
  await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:true}}));
  let calls = 0;
  await page.route("**/SYNT/valuation-draft", route => { calls++; return route.fulfill({
    contentType:"application/x-ndjson", body:JSON.stringify(draftResponse)+"\n",
  }); });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const entry = editor.getByRole("button", {name:"✦ Draft",exact:true});
  await expect(entry).toBeVisible();
  return {state, editor, entry, calls:() => calls};
}

// Locate the painted stroke between its endpoint dots, in CSS pixels. Exclude the
// left-hand labels and inspect each settled row near the centre of its category.
async function settledStroke(plot: Locator, scenario: "bear" | "bull") {
  return plot.locator("canvas").first().evaluate((canvas: HTMLCanvasElement, key) => {
    const ratio = canvas.width / canvas.clientWidth;
    const left = Math.ceil(canvas.width / 3);
    const top = Math.round(canvas.height * (key === "bear" ? 0.25 : 0.69));
    const band = canvas.getContext("2d")!.getImageData(left, top, canvas.width - left, Math.ceil(15 * ratio));
    let longest = {start:0, end:0, y:0};
    for (let y = 0; y < band.height; y++) {
      let start = 0;
      for (let x = 0; x < band.width; x++) {
        const alpha = band.data[(y * band.width + x) * 4 + 3];
        if (alpha < 24) start = x + 1;
        else if (x - start > longest.end - longest.start) longest = {start,end:x,y};
      }
    }
    if (longest.end - longest.start < 10 * ratio) throw new Error("Settled scenario line missing");
    return {start:(left + longest.start) / ratio, end:(left + longest.end) / ratio, y:(top + longest.y) / ratio};
  }, scenario);
}

async function pendingBaseReview(page: Page) {
  const {editor, entry} = await reviewDraft(page);
  await page.route("**/SYNT/valuation-draft", route => route.fulfill({contentType:"application/x-ndjson",
    body:JSON.stringify({...draftResponse, result:{...draftResponse.result, proposals:[
      ...draftProposals, {...draftProposals[0],scenario:"bull"},
    ], deskReadings:{bear:{value:141,upside:.41},base:{value:345,upside:2.45},bull:{value:210,upside:1.1}}}})+"\n"}));
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release=resolve;});
  await page.route("**/SYNT/valuation-preview*", async route => {
    if (route.request().method() === "POST") await hold;
    await route.fallback();
  });
  await entry.click();
  const comparison = page.locator(".mx-scenario-comparison");
  const readings = comparison.locator(".mx-draft-reading");
  const plot = comparison.getByRole("group", {name:/Scenario valuations relative to current price/});
  await expect(readings).toHaveText([/141.00/,/345.00/,/210.00/]);
  await comparison.scrollIntoViewIfNeeded();
  await expect(plot).toHaveAttribute("data-tm-chart-ready","true");
  async function accept() {
    const pending = page.waitForRequest(req => req.method() === "POST" && req.url().includes("/SYNT/valuation-preview"));
    await editor.getByRole("button",{name:"Accept Revenue growth · years 1–5"}).click();
    await pending;
    await expect(plot).toHaveAccessibleName(/Base · Pending/);
  }
  return {comparison, readings, plot, accept, release};
}

test.describe("frozen draft review", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  test("discard explicitly before redrafting accepted values", async ({page}) => {
    const {editor, entry, calls} = await reviewDraft(page);
    await entry.click();
    await editor.getByRole("button",{name:"Accept Revenue growth · years 1–5",exact:true}).click();
    await expect(page.locator(".mx-scenario-cards button[aria-pressed=true] .mx-draft-reading")).toContainText("195.00");
    await editor.getByRole("button",{name:"Discard draft",exact:true}).click({timeout:1800});
    await expect(editor.getByLabel("Revenue growth · years 1–5")).toHaveValue("10%");
    expect(calls()).toBe(1);
    await entry.click();
    await expect(editor.getByRole("button",{name:"Accept Revenue growth · years 1–5",exact:true})).toHaveAttribute("aria-pressed","false");
  });

  test("a new publication suspends review and preserves manual edits on reload", async ({page}) => {
    await page.clock.install();
    const {state, editor, entry} = await reviewDraft(page);
    await editor.getByLabel("Revenue growth · years 1–5").fill("14");
    await expect.poll(() => state.posts.at(-1)?.scenarios.base.revenueCagr).toBe(.14);
    await entry.click();
    const accept = editor.getByRole("button",{name:"Accept Revenue growth · years 1–5",exact:true});
    await expect(accept).toBeVisible();
    state.publication = "synthetic-reviewed-two";
    const fresh = page.waitForResponse(response => response.url().includes("/research/shell") && response.ok());
    await page.clock.fastForward(60_000);
    await fresh;
    await expect(accept).toBeDisabled({timeout:1500});
    await editor.getByRole("button",{name:"Reload for review"}).click();
    await expect(editor.getByRole("textbox", {name:"Revenue growth · years 1–5", exact:true})).toHaveValue("14%");
    await expect(editor.locator(".mx-draft-row")).toHaveCount(0);
  });

  test("each scenario moves from its offered reading to its reviewed inputs independently", async ({page}) => {
    const {editor, entry} = await reviewDraft(page);
    await entry.click();
    const base = page.locator(".mx-scenario-cards button[aria-pressed=true]");
    const bear = page.locator(".mx-scenario-cards button").first();
    await expect(base.locator(".mx-draft-reading")).toContainText("183.00");
    await editor.getByRole("button",{name:"Reject Target FCF margin",exact:true}).click();
    await expect(base.locator(".mx-draft-reading")).toContainText("150.00");
    await expect(bear.locator(".mx-draft-reading")).toContainText("141.00");
    await editor.getByRole("button",{name:"Accept Revenue growth · years 1–5",exact:true}).click();
    await expect(base.locator(".mx-draft-reading")).toContainText("195.00");
    await editor.getByRole("button",{name:"Reject Revenue growth · years 1–5",exact:true}).click();
    await expect(base.locator(".mx-draft-reading")).toHaveCount(0);
    await expect(base.locator("strong")).toContainText("150.00");
    await expect(bear.locator(".mx-draft-reading")).toContainText("141.00");
  });

  test("a pending base review keeps settled bear and bull readings visible", async ({page}, info) => {
    const {comparison, readings, plot, accept, release} = await pendingBaseReview(page);
    const reading = comparison.getByRole("status");
    const lines = () => Promise.all([settledStroke(plot, "bear"), settledStroke(plot, "bull")]);
    const offered = await lines();
    await captureDraft(page, info.project.name, "en", "light", "base-offered", ".mx-scenario-comparison");
    try {
      await accept();
      await expect.poll(lines).toEqual(offered);
      await expect(readings).toHaveText([/141.00/,/Draft …/,/210.00/]);
      await expect(plot).toHaveAccessibleName(/Bear · Draft.*Base · Pending.*Bull · Draft/);
      await plot.press("End");
      await expect(reading).toContainText("Bear · Draft: +41%");
      await expect(reading).toContainText("Bull · Draft: +110%");
      await expect(reading).not.toContainText("Base");
      await captureDraft(page, info.project.name, "en", "light", "base-pending", ".mx-scenario-comparison");
    } finally {
      release();
    }
    await expect(readings).toHaveText([/141.00/,/195.00/,/210.00/]);
    await expect(plot).toHaveAccessibleName(/Base · Draft/);
    await expect(reading).toContainText("Base · Draft: +95%");
    await expect.poll(async () => (await settledStroke(plot, "bull")).end).toBeGreaterThan(offered[1].end);
  });

  test("a newly settled Bear endpoint fits while Base is still pending", async ({page}, info) => {
    await page.clock.install();
    const {editor, entry} = await reviewDraft(page);
    const {result} = draftResponse;
    await page.route("**/SYNT/valuation-draft", route => route.fulfill({contentType:"application/x-ndjson",
      body:JSON.stringify({...draftResponse, result:{...result,
        proposals:[...result.proposals, {...draftProposals[0], scenario:"bear", value:.82, evidenceIds:["bear-growth"]}],
        evidence:{...result.evidence, "bear-growth":{...result.evidence.estimate, value:.82}},
        deskReadings:{...result.deskReadings, bear:{value:210, upside:1.1}},
      }})+"\n"}));
    await entry.click();
    const comparison = page.locator(".mx-scenario-comparison");
    const plot = comparison.getByRole("group", {name:/Scenario valuations relative to current price/});
    await comparison.scrollIntoViewIfNeeded();
    await expect(plot).toHaveAttribute("data-tm-chart-ready","true");
    const originalBull = await settledStroke(plot, "bull");
    const bear = Promise.withResolvers<Route>();
    const base = Promise.withResolvers<Route>();
    await page.route("**/SYNT/valuation-preview*", route => {
      if (route.request().method() !== "POST") return route.fallback();
      const request = route.request().postDataJSON();
      (request.scenarios.base.revenueCagr === defaults.revenueCagr ? bear : base).resolve(route);
    });
    const accept = editor.getByRole("button", {name:"Accept Revenue growth · years 1–5"});
    await editor.getByRole("button", {name:"Bear", exact:true}).click();
    await accept.click();
    const first = await bear.promise;
    await editor.getByRole("button", {name:"Base", exact:true}).click();
    // Deliver Bear after the Base edit but before its debounce switches requests.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    await accept.press("Enter");
    const delivered = page.waitForResponse(response => response.request() === first.request());
    await first.fallback();
    await (await delivered).finished();
    await page.clock.runFor(64);
    await page.clock.resume();
    const second = await base.promise;
    await expect(plot).toHaveAccessibleName(/Bear · Draft.*Base · Pending/);
    await plot.press("End");
    await expect(comparison.getByRole("status")).toContainText("Bear · Draft: +410%");
    await expect(comparison.locator(".mx-draft-reading").first()).toContainText("+410.00%");
    await expect.poll(async () => (await settledStroke(plot, "bull")).end).toBeLessThan(originalBull.end);
    const overlap = await settledStroke(plot, "bear");
    await captureDraft(page, info.project.name, "en", "light", "overlap", ".mx-scenario-comparison");
    await second.fallback();
    await expect(plot).toHaveAccessibleName(/Base · Draft/);
    await expect.poll(async () => Math.abs((await settledStroke(plot, "bear")).end - overlap.end)).toBeLessThanOrEqual(1);
  });

  test("hovering settled line bodies and endpoints highlights their own cards", async ({page, isMobile}, info) => {
    test.skip(isMobile, "Continuous mouse hover is verified on desktop.");
    const {comparison, plot, accept, release} = await pendingBaseReview(page);
    async function checkHover() {
      for (const key of ["bear","bull"] as const) {
        const line = await settledStroke(plot, key);
        const card = comparison.getByRole("button", {name:key === "bear" ? /^Bear/ : /^Bull/});
        for (const x of [(line.start + line.end) / 2, line.end - 3]) {
          await plot.hover({position:{x:2,y:5}});
          await plot.hover({position:{x,y:line.y}});
          await expect(card).toHaveAttribute("data-hover","true");
        }
      }
    }
    try {
      await checkHover();
      await accept();
      await checkHover();
      const screenshots = process.env.VALUATION_DRAFT_SCREENSHOTS_DIR;
      if (screenshots) {
        const bull = await settledStroke(plot, "bull");
        await plot.hover({position:{x:(bull.start + bull.end) / 2, y:bull.y}});
        await expect(comparison.getByRole("button", {name:/^Bull/})).toHaveAttribute("data-hover","true");
        await comparison.screenshot({path:join(screenshots, `bull-hover-${info.project.name}.png`), scale:"css"});
      }
    } finally {
      release();
    }
  });

  test("calculating reserves the English phone result header height", async ({page, isMobile}) => {
    test.skip(!isMobile, "The result actions wrap on phones.");
    const {accept, release} = await pendingBaseReview(page);
    const results = page.locator("#valuation-results");
    async function offsets() {
      const values = [];
      for (const width of [320, 390, 404, 430]) {
        await page.setViewportSize({width, height:844});
        values.push(await results.evaluate(el =>
          el.querySelector(".mx-scenario-spot")!.getBoundingClientRect().top - el.getBoundingClientRect().top));
      }
      return values;
    }
    const settled = await offsets();
    try {
      await accept();
      await expect(results.locator(".mx-preview-status")).toHaveText("Calculating…");
      expect(await offsets()).toEqual(settled);
    } finally {
      release();
    }
  });

  test("template fields link to the frozen inputs used for this scenario", async ({page}) => {
    const {editor, entry} = await reviewDraft(page);
    await entry.click();
    await editor.getByRole("button", {name:"Bear", exact:true}).click();
    await editor.getByRole("link", {name:"Template source", exact:true}).click();
    const origin = page.locator("#draft-origin-template");
    await expect(origin).toContainText("hardware");
    await expect(origin).toContainText("Exit multiple 16×");
    await expect(origin).toContainText("Bear · Cost of equity 12%");
    await origin.getByRole("link").click();
    await expect(page.locator("#draft-evidence-statement")).toContainText("120 USD");
  });

  test("reject and edit retain keyboard focus and name both values", async ({page}) => {
    const {editor, entry} = await reviewDraft(page);
    await entry.click();
    const reject = editor.getByRole("button",{name:"Reject Target FCF margin",exact:true});
    await reject.focus();
    await reject.press("Enter");
    await expect(editor.getByRole("button",{name:/^Target FCF margin/})).toBeFocused({timeout:1000});
    const edit = editor.getByRole("button",{name:"Edit Revenue growth · years 1–5",exact:true});
    const row = edit.locator("xpath=ancestor::div[contains(@class,'mx-draft-row')]");
    await expect(row.getByText("Previous value",{exact:true})).toBeAttached();
    await expect(row.getByText("Proposed value",{exact:true})).toBeAttached();
    await edit.focus();
    await edit.press("Enter");
    await expect(editor.getByLabel("Revenue growth · years 1–5",{exact:true})).toBeFocused();
  });

  test("proposal rows keep the grid stable and name the staged chart series", async ({page}) => {
    const {editor, entry} = await reviewDraft(page);
    await page.emulateMedia({reducedMotion:"reduce"});
    let release!: () => void;
    const delivery = new Promise<void>(resolve => { release=resolve; });
    await page.route("**/SYNT/valuation-draft", async route => {
      await delivery;
      await route.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({
        ...draftResponse, result:{...draftResponse.result, proposals:[
          ...draftResponse.result.proposals,
          ...(["discount_rate","exit_fcf_multiple","share_cagr"] as const).map((field,i) => ({
            scenario:"base", field, value:[.09,18,-.02][i], category:"template", source:"sector-template",
            originId:"template", evidenceIds:[],
          })),
        ]},
      })+"\n"});
    });
    const width = (await editor.boundingBox())!.width;
    await entry.click();
    const top = () => page.locator("#research-sensitivity").evaluate(el => el.getBoundingClientRect().top + scrollY);
    await expect(editor.getByRole("status")).toContainText("Reading valuation basis");
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    const pending = await top();
    release();
    await expect(editor.getByRole("status")).toContainText("proposed");
    expect(Math.abs(await top() - pending)).toBeLessThanOrEqual(1);
    if (page.viewportSize()!.width >= 1200) {
      const results = (await page.locator("#valuation-results").boundingBox())!;
      const review = (await editor.boundingBox())!;
      expect(results.x + results.width).toBeLessThanOrEqual(review.x);
      expect(Math.abs(results.y - review.y)).toBeLessThanOrEqual(1);
    }

    await editor.getByRole("button",{name:"Accept Revenue growth · years 1–5",exact:true}).click();
    await expect(page.locator(".mx-scenario-cards button[aria-pressed=true] .mx-draft-reading")).toContainText("195.00");
    expect((await editor.boundingBox())!.width).toBe(width);
    await expect(page.locator(".mx-scenario-cards button[aria-pressed=true]")).toContainText("+95.00%");
    await expect(page.getByLabel(/Scenario valuations relative to current price.*Base.*Draft/i)).toBeAttached();
  });
});

test("explicitly choosing the displayed model preserves edited saved assumptions on reopen", async ({page}, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await synthetic(page,false);
  let stored = {familySelection:"automatic", scenarios:{base:{...defaults, revenueCagr:0.22}}};
  const selections: (string | null)[] = [];
  await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:true}}));
  await page.route("**/SYNT/valuation-preview*", route => {
    const family = new URL(route.request().url()).searchParams.get("family");
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : undefined;
    if (!body) selections.push(family);
    const configured = {base:{...defaults, revenueCagr:0.1111}};
    const p = preview("SYNT", 100, "2026-11-04T15:40:00Z", true, body?.scenarios ?? (family ? configured : stored.scenarios));
    return route.fulfill({json:{...p, familySelection:family ? "override" : stored.familySelection,
      defaultSource:family ? "configured-scenarios" : "saved-model"}});
  });
  await page.route("**/SYNT/models", route => {
    stored = route.request().postDataJSON();
    return route.fulfill({json:{models:[]}});
  });
  await page.route("**/SYNT/valuation-draft", route => route.fulfill({contentType:"application/x-ndjson",
    body:JSON.stringify({...draftResponse,result:{...draftResponse.result,familySelection:"override"}})+"\n"}));
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const select = editor.getByRole("combobox",{name:"Valuation model"});
  await expect(select).toHaveValue("Equity cash flow");
  const growth = editor.getByLabel("Revenue growth · years 1–5", {exact:true});
  await expect(growth).toHaveValue("22%");
  await growth.fill("23");
  await select.click();
  await page.getByRole("option",{name:"Equity cash flow",exact:true}).click();
  await expect(growth).toHaveValue("23%");
  await editor.getByRole("button",{name:"Save model version",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Save version",exact:true}).click();
  await expect.poll(() => stored.familySelection).toBe("override");
  expect(stored.scenarios.base.revenueCagr).toBe(0.23);
  expect(selections).toEqual([null]);
  await page.reload();
  await expect(select).toHaveValue("Equity cash flow");
  await expect(growth).toHaveValue("23%");
  await captureDraft(page, info.project.name, "en", "light", "same-family-reopened");
  await editor.getByRole("button",{name:"✦ Draft",exact:true}).click();
  await expect(editor.getByRole("button",{name:"Accept Revenue growth · years 1–5"})).toBeVisible();
  expect(selections.at(-1)).toBeNull();
});

test("cold disabled valuation stays dormant and cross-tab withdrawal clears shell and review", async ({page,context}) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await context.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const state = await synthetic(page, false);
  let enabled = false;
  let hold = false;
  let release!: () => void;
  const refresh = new Promise<void>(resolve => { release = resolve; });
  const scripts: Promise<string>[] = [];
  const requests: string[] = [];
  page.on("response", response => {
    if (response.request().resourceType() === "script")
      scripts.push(response.text().catch(() => ""));
  });
  page.on("request", request => { requests.push(request.url()); });
  await page.route("**/api/backend/profile", async route => {
    if (hold) await refresh;
    await route.fulfill({json:{assistantEnabled:enabled, accountLabels:{}}});
  });
  await page.route("**/api/backend/assistant/status", route => route.fulfill({json:{ready:enabled, code:null}}));
  await page.route("**/api/backend/assistant/conversations", route => route.fulfill({json:[]}));
  await page.route("**/SYNT/valuation-draft", route => route.fulfill({
    contentType:"application/x-ndjson", body:JSON.stringify(draftResponse)+"\n",
  }));
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const entry = editor.getByRole("button", {name:"✦ Draft", exact:true});
  const growth = editor.getByLabel("Revenue growth · years 1–5", {exact:true});
  await expect(growth).toHaveValue("10%");
  const hasScript = async (text: string) => (await Promise.all(scripts)).some(s => s.includes(text));
  const renderer = "Divides common earnings by common equity", streamReader = "assistant_interrupted";
  expect(await hasScript(renderer)).toBe(false);
  expect(await hasScript(streamReader)).toBe(false);
  expect(requests.filter(url => /settings\/assistant|valuation-draft|assistant\/(status|conversations|chat)/.test(url))).toEqual([]);
  await expect(entry).toHaveCount(0);
  await growth.fill("14");
  await expect.poll(() => state.posts.at(-1)?.scenarios.base.revenueCagr).toBe(.14);
  async function consent(value: boolean) {
    enabled = value;
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {key:"trading_max-assistant-settings-revision"})));
  }
  await consent(true);
  await entry.click();
  expect(await hasScript(renderer)).toBe(true);
  expect(await hasScript(streamReader)).toBe(true);
  await editor.getByRole("button",{name:"Accept Revenue growth · years 1–5",exact:true}).click();
  await expect(page.locator(".mx-scenario-cards button[aria-pressed=true] .mx-draft-reading")).toContainText("195.00");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.locator("textarea")).toBeVisible();
  const other = await context.newPage();
  const settings = {enabled:true, revision:1, route:"openai/model-a", acceptedConsentRevision:2,
    consentRevision:2, acceptedAt:"2026-01-01", providers:[], integrations:[]};
  await other.route("**/api/backend/settings/assistant", route => {
    if (route.request().method() === "PUT") {
      enabled = false;
      hold = true;
      return route.fulfill({json:{...settings,enabled:false,revision:2,acceptedConsentRevision:null}});
    }
    return route.fulfill({json:settings});
  });
  try {
    await other.goto("/settings?tab=assistant");
    const checkingConsent = page.waitForRequest(request =>
      hold && new URL(request.url()).pathname === "/api/backend/profile");
    await other.getByRole("button",{name:"Withdraw consent"}).click();
    await checkingConsent;
    await page.bringToFront();
    await expect(panel).toContainText("Checking connection");
    await expect(panel.locator("textarea")).toBeHidden();
    await expect(editor.locator(".mx-draft-row")).toHaveCount(0);
    await expect(page.locator(".mx-draft-reading")).toHaveCount(0);
  } finally {
    release();
    await other.close();
  }
  await expect(panel.getByRole("link",{name:"Open Settings"})).toBeVisible();
  await expect(panel.locator("textarea")).toHaveCount(0);
  await panel.getByRole("button",{name:"Close sidebar"}).click();
  await expect(growth).toHaveValue("14%");
  await expect(entry).toHaveCount(0);
  await expect(editor.locator(".mx-draft-row")).toHaveCount(0);
  await expect(page.locator(".mx-draft-reading")).toHaveCount(0);
  await expect(page.locator(".mx-scenario-cards button[aria-pressed=true] strong")).toContainText("170.00");
});

for (const locale of ["en", "zh"] as const) {
  test(`saved worksheets distinguish floored and exact zeros · ${locale}`, async ({ page, isMobile }) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
    await synthetic(page, false);
    const models = [3, 0].map((adjustment, index) => {
      const savedAt = `2026-10-${20 - index}T12:00:00Z`;
      const p = preview("SYNT", 100, savedAt, false, {});
      Object.assign(p.scenarios.base, { operatingValue: -adjustment, terminalPresentValue: 0,
        equityFloorAdjustment: adjustment, value: 0, upside: -1 });
      return { id: `model-${index}`, savedAt, preview: p };
    });
    await page.route("**/research/SYNT/journal", r => r.fulfill({ json: { ticker: "SYNT", notes: [], models } }));
    await page.goto("/research?ticker=SYNT&view=ledger&notebook=models");
    const table = page.getByRole("region", { name: locale === "en" ? "Saved model comparison" : "冻结模型对比" });
    const cells = table.getByRole("row").filter({ hasText: locale === "en" ? "Base value" : "中性估值" }).getByRole("cell");
    const note = locale === "en" ? "Negative equity value floored at zero" : "股权估值为负，按零计";
    await expect.soft(cells.first()).toContainText(note, { timeout: 1500 });
    await expect(cells.nth(1)).toHaveText("US$0.00");
    for (const index of [0, 1]) {
      await table.getByRole("button", { name: locale === "en" ? "Open worksheet" : "查看底稿" }).nth(index).click();
      const drawer = page.getByRole("dialog");
      const total = drawer.locator("p").filter({ hasText: locale === "en" ? "Value per share" : "每股价值" });
      await expect(total).toContainText("US$0.00");
      if (index === 0) await expect.soft(total).toContainText(note, { timeout: 1500 });
      else await expect(total).not.toContainText(note);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    }
  });
}
