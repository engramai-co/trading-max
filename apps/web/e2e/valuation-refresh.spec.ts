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
    await expect(chart).toHaveAccessibleName(/28\.4×.*Historical percentile/);
    await expect(section.getByRole("button", { name: "P25–P75" })).toHaveAttribute("aria-pressed", "true");

    await peScreenshot(page, "trailing-gap", testInfo.project.name);

    await chart.focus();
    await chart.press("Home");
    for (let i = 0; i < 132; i++) await chart.press("ArrowRight");
    const reading = section.getByRole("status");
    await expect(reading).toContainText("Not meaningful");
    await expect(reading).toContainText("EPS (TTM) -0.25 USD");
    const deviation = section.getByRole("button", { name: "Mean ±1σ" });
    await deviation.click();
    await expect(deviation).toHaveAttribute("aria-pressed", "true");
    await chart.focus();
    await chart.press("End");
    await expect(reading).toContainText("Close 142 USD · Yahoo");
    await expect(reading).toContainText("EPS (TTM) 5 USD · SEC Companyfacts");
    await expect(reading).toContainText("Includes inferred Q4");
    await expect(reading).toContainText("Effective");
    await chart.press("Escape");
    await expect(reading).toHaveText("");
    await expect(page.getByText("Historical valuation reference", { exact: true })).toBeVisible();
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
    await page.getByRole("button", { name: "Next security" }).click();
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
    const modes = section.getByRole("group", { name: "P/E basis" });
    const ntm = modes.getByRole("button", { name: isMobile ? "NTM" : "NTM P/E", exact: true });
    await ntm.click();
    await expect(ntm).toHaveAttribute("aria-pressed", "true");
    const chart = section.getByRole("group", { name: /^NTM P\/E history/ });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await expect(chart).toHaveAccessibleName(/Historical percentile \d+%/);
    await expect(section.getByRole("button", { name: "P25–P75" })).toHaveAttribute("aria-pressed", "true");
    await peScreenshot(page, "ntm-ranked", testInfo.project.name);
    await section.getByRole("button", { name: "Mean ±1σ" }).click();
    await expect(section.getByRole("button", { name: "Mean ±1σ" })).toHaveAttribute("aria-pressed", "true");
    await chart.focus();
    await chart.press("Home");
    const reading = section.getByRole("status");
    await expect(reading).toContainText("Yahoo forwardPE (fallback)");
    await expect(reading).toContainText("Recovered publication");
    await chart.press("End");
    await expect(reading).toContainText("EPS (NTM)");
    await expect(reading).toContainText("Effective (archive)");
    await expect(reading).toContainText("Quoted");
    await expect(reading).toContainText("Yahoo FY1 / FY2 consensus");
    expect(extra).toBe(0);
    const controls = (await modes.boundingBox())!;
    const bounds = (await section.boundingBox())!;
    expect(controls.x + controls.width).toBeLessThan(bounds.x + bounds.width);
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
    await peScreenshot(page, "ntm-short", testInfo.project.name);
    await section.getByRole("button", { name: isMobile ? "TTM" : "滚动 P/E" }).click();
    await expect(section.getByText("暂无可计算的滚动 P/E")).toBeVisible();
  });

});
