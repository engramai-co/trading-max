import { expect, test, type Page, type Route } from "@playwright/test";
import { join } from "node:path";
import type { ResearchLensSnapshot } from "../lib/types";

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
    return { date, pe, close: pe === null ? 105 : pe * earnings[earningsIndex].eps, earningsIndex };
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

  test("the readout keeps its space and shows the signed gap for a large base value", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await synthetic(page, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/SYNT/valuation-preview*", async (route) => {
      await gate;
      const model = preview("SYNT", 150000, "2026-11-04", true, {});
      model.basis.currency = "JPY";
      model.scenarios.base.value = 135956.78;
      model.scenarios.base.upside = model.scenarios.base.value / model.basis.spot - 1;
      await route.fulfill({ json: model });
    });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const history = page.locator("#research-history");
    await expect(history).toBeVisible();
    const before = await history.boundingBox();
    release();
    const readout = page.locator(".mx-valuation-readout");
    await expect(readout).toContainText("135,956.78");
    await expect.soft(readout).toContainText(/[-−]9.4%/);
    expect.soft(Math.abs((await history.boundingBox())!.y - before!.y)).toBeLessThan(1);
    if (isMobile) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      const metrics = await readout.locator(".mx-metric").evaluateAll((items) => items.map((node) => node.getBoundingClientRect().top));
      expect(metrics[1]).toBeGreaterThan(metrics[0]);
    }
  });

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

  test("a failed quote refresh labels the retained year-five revenue and retries inline", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const state = await synthetic(page);
    await page.route("**/SYNT/valuation-preview*", route => {
      if (state.defaultsDown) return route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
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
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect(reverse).toContainText("US$120k");
    await expect(failure).toHaveCount(0);
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

});

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
        await choose("ArrowUp");
        await expect(select).toHaveValue(name);
        if (!cached) {
          await expect.poll(() => residualGets).toBe(1);
          await expect(select).toBeFocused();
          await expect(select).toBeInViewport();
          release();
        }
        await expect(roe).toBeVisible();
        await expect(select).toBeFocused();
        await expect(select).toBeInViewport();
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
      if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.addInitScript(value => localStorage.setItem("trading_max-locale", value), locale);
      await synthetic(page, false);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let value: number | null = 132_000_123.45;
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
      await expect(reverse.locator(".mx-number-value")).toHaveText(/132m/);
      await expect(reverse).toContainText("15.0%");
      await expect(reverse).toContainText("15×");
      await expect(row.locator(".mx-metric").last().locator(".mx-number-value")).toHaveText("—");
      expect(Math.abs((await history.boundingBox())!.y - top)).toBeLessThan(1);
      const detail = page.locator("#valuation-assumptions");
      await expect(detail).toContainText("132,000,123.45");
      await expect(detail).toContainText(locale === "en" ? "Last fiscal year · 2025-12-31" : "上一财年 · 2025-12-31");
      await expect(detail).not.toContainText("annual:");
      await expect(detail).not.toContainText(locale === "en" ? "Target margin" : "目标利润率");
      await expect(detail).not.toContainText(locale === "en" ? "Exit multiple" : "退出倍数");
      await expect(page.locator("#research-sensitivity, #research-worksheet")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
