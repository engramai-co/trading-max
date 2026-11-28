import { captureCitation, previewCitation } from "./citation-preview";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import type { components } from "../lib/api-schema";
import { backendFixture } from "../tests/loading/fixtures";
import { tapRecordsBottom } from "./chart-records";

// Two synthetic accounts. Invest has two scored decisions and three young ones a link can open; Stocks ISA, when
// present, has a buy that helped more than any in Invest and a sale that cost. Between fetches only their context changes.
const asOf = "2026-10-20T12:00:00Z";
type Context = {
  benchmark: number; events: boolean; failing?: boolean; healthFailing?: boolean; twin?: boolean; settled?: boolean;
  habitsConsented?: boolean; unpricedBasket?: boolean; renamed?: boolean; observations?: boolean; cluster?: boolean; empty?: boolean; isa?: boolean;
  /** Both accounts carry one display name, and Stocks ISA also sold SYND.AS on Invest's day. */
  namesake?: boolean;
  tradeCoverage?: { count: number; reason: string };
  cfdMissingFx?: boolean;
};

// Inside their first 20 trading days: a sale of a dotted ticker, a buy with no close after it yet, and a T.
// A twin is another security sold the same day under the same ticker; settled, the sale's 20 days are done.
function linked({ benchmark, twin, settled }: Context) {
  const young = { horizonComplete: false, effectHorizonGbp: null, returnHorizon: null, marketReturnHorizon: null, events: [] };
  const done = { horizonComplete: true, observedDays: 20, effectHorizonGbp: 15, returnHorizon: -0.05, marketReturnHorizon: benchmark };
  return [
    {
      ...young, date: "2026-10-14", ticker: "SYND.AS", name: "Synthetic Delta", side: "sell", kind: "S", amountGbp: 300,
      observedDays: 4, effectToDateGbp: 21, returnToDate: -0.07, marketReturnToDate: benchmark,
      ...(settled ? done : {}),
    },
    ...(twin ? [{
      ...young, date: "2026-10-14", ticker: "SYND.AS", name: "Synthetic Delta Holdings", side: "sell", kind: "S", amountGbp: 120,
      observedDays: 4, effectToDateGbp: -3, returnToDate: 0.02, marketReturnToDate: benchmark,
    }] : []),
    {
      ...young, date: "2026-10-20", ticker: "SYNE", name: "Synthetic Epsilon", side: "buy", kind: "B", amountGbp: 200,
      observedDays: 0, effectToDateGbp: 0, returnToDate: 0, marketReturnToDate: null,
    },
    {
      ...young, date: "2026-10-01", ticker: "SYNG", name: "Synthetic Gamma", side: "buy", kind: "T", amountGbp: 90,
      observedDays: 13, effectToDateGbp: -6, returnToDate: -0.06, marketReturnToDate: benchmark,
    },
  ];
}

function decisions(context: Context) {
  const { benchmark, events, renamed } = context;
  const scored = { observedDays: 34, horizonComplete: true, marketReturnHorizon: benchmark, marketReturnToDate: benchmark };
  return [
    {
      // Renamed, the broker has corrected the security's name.
      ...scored, date: "2026-09-01", ticker: "SYNA", name: renamed ? "Synthetic Alpha Holdings" : "Synthetic Alpha", side: "sell", kind: "S", amountGbp: 500,
      effectHorizonGbp: -40, effectToDateGbp: -55, returnHorizon: 0.08, returnToDate: 0.11, events: [],
    },
    {
      ...scored, beforeEarnings:true, basketBuy:true, date: "2026-09-02", ticker: "SYNB", name: "Synthetic Beta", side: "buy", kind: "B", amountGbp: 800,
      effectHorizonGbp: 60, effectToDateGbp: 70, returnHorizon: 0.09, returnToDate: 0.1,
      events: events ? [
        { date: "2026-09-05", kind: "news", title: "Synthetic Beta opens a second plant in a long-named industrial district" },
        { date: "2026-09-09", kind: "initiate", firm: "Example Securities International", toGrade: "buy" },
        { date: "2026-09-14", kind: "upgrade", firm: "Another Example Research Partners", toGrade: "outperform" },
      ] : [],
    },
    ...linked(context),
    ...(context.cluster ? Array.from({ length: 4 }, (_, i) => ({
      ...scored, date: "2026-09-02", ticker: "SYNC" + (i + 1), name: "Synthetic cluster " + (i + 1),
      side: "buy", kind: "B", amountGbp: 100 * (i + 1), effectHorizonGbp: 10,
      effectToDateGbp: 12, returnHorizon: 0.1, returnToDate: 0.12, events: [],
    })) : []),
  ];
}

/** Stocks ISA's own decisions: a buy that helped more than any in Invest, and a sale that cost. */
function isa({ benchmark, namesake }: Context) {
  const scored = { observedDays: 30, horizonComplete: true, marketReturnHorizon: benchmark, marketReturnToDate: benchmark, events: [] };
  return [
    ...(namesake ? [{
      ...scored, date: "2026-10-14", ticker: "SYND.AS", name: "Synthetic Delta", side: "sell", kind: "S", amountGbp: 75,
      effectHorizonGbp: -12, effectToDateGbp: -12, returnHorizon: 0.03, returnToDate: 0.03,
    }] : []),
    {
      ...scored, date: "2026-09-03", ticker: "SYNI", name: "Synthetic Iota", side: "buy", kind: "B", amountGbp: 400,
      effectHorizonGbp: 90, effectToDateGbp: 80, returnHorizon: 0.2, returnToDate: 0.18,
    },
    {
      ...scored, date: "2026-09-10", ticker: "SYNK", name: "Synthetic Kappa", side: "sell", kind: "S", amountGbp: 250,
      effectHorizonGbp: -25, effectToDateGbp: -30, returnHorizon: 0.1, returnToDate: 0.12,
    },
  ];
}

function observations(account?: string): components["schemas"]["InvestmentReviewEvidence"] {
  const before = { largestHolding: 0.28, cash: 0.24, usdExposure: 0.31 };
  const after = { largestHolding: 0.26, cash: 0.21, usdExposure: 0.34 };
  const invest: components["schemas"]["AccountReviewEvidence"] = {
    coverage: "complete", asOf,
    holdingMoves: [{ date: "2026-10-16", ticker: "SYNB", quoteCurrency: "USD", change: -0.068, hypotheticalHorizonGbp:14, hypotheticalToDateGbp:-9, basis: "short_history", priorReturns: 19, threshold: 0.05 }],
    cashSpans: [{ start: "2026-09-30", end: "2026-10-16", sessions: 13, peakShare: 0.24, averageShare: 0.19 }],
    weightDrifts: [{ start: "2026-09-30", end: "2026-10-16", ticker: "SYNB", before: 0.2, after: 0.26 }],
    fillEffects: [
      // The buy moved cash and USD exposure by three points each, and the largest holding by two.
      { filledAt: "2026-10-19T17:22:00Z", ticker: "SYNE", side: "buy", quantity: 0.5, before, after },
      // The sale moved no share by a whole point.
      { filledAt: "2026-10-14T14:30:00Z", ticker: "SYND.AS", side: "sell", quantity: 2,
        before: { largestHolding: 0.3, cash: 0.2, usdExposure: 0.3 }, after: { largestHolding: 0.302, cash: 0.205, usdExposure: 0.296 } },
    ],
  };
  return {
    // A different threshold proves the help uses the response, not its own copy.
    rules: { cashMinSessions: 10, cashShare: 0.12, evidenceDays: 90, recentFillLimit: 8,
      sessionMoveShare: 0.05, sessionMoveVolatility: { multiple: 2.75, lookbackSessions: 62, minReturns: 21, maxRowsPerHolding: 4 }, weightDriftDays: 30, weightDriftShare: 0.03 },
    accounts: { ...(account !== "B" ? { A: invest } : {}), ...(account !== "A" ? { B: { coverage: "partial" } as const } : {}) },
  };
}

async function serve(page: Page, context: () => Context) {
  await page.route("**/api/backend/**", (route) => {
    const url = new URL(route.request().url());
    const { pathname: path } = url;
    const current = context();
    const account = url.searchParams.get("account") ?? undefined;
    // Invest also made two same-day round trips, and sold one holding below its best close.
    const review = (rows: unknown[], trips = false) => ({
      status: "available", asOf, horizonDays: 20, observingCount: 1, decisions: rows,
      ...(current.unpricedBasket && trips ? { unpricedBasketBuys: [{
        date: "2026-09-02", side: "buy", ticker: "UNPRICED", name: "Unpriced listing", amountGbp: 140,
        quantity: 2, kind: "B", unpriced: true, basketBuy: true,
      }] } : {}),
      ...(trips ? {
        roundTripSummary: { count: 2, favourable: 1, resultGbp: 12, ranged: 2, rangeGbp: 40, rangedResultGbp: 12 },
        roundTrips: [
          { date: "2026-09-15", ticker: "SYNB", matchedQuantity: 2, buyAverageGbp: 100, sellAverageGbp: 109, resultGbp: 18, rangeGbp: 24 },
          { date: "2026-10-01", ticker: "SYNG", matchedQuantity: 3, buyAverageGbp: 30, sellAverageGbp: 28, resultGbp: -6, rangeGbp: 16 },
        ],
        closedTrades: [{ ticker: "SYNA", start: "2026-06-01", end: "2026-09-01", actualGbp: 120, bestExitGbp: 180, worstCloseGbp: -30, givenBackGbp: 60 }],
      } : {}),
    });
    if (path.includes("/dashboard/lens/")) return current.failing ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: {
      runId: "synthetic-decision-context", brokerAsOf: asOf, reviewAsOf: asOf,
      reviewHabitsConsented: current.habitsConsented, totalValueGbp: 2000, totalCashGbp: 100, holdings: [], nav: [],
      accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2000 }],
      // Enough of the account review for its highlights: a realized gain and a loss to open.
      selectedAccountReview: current.empty ? null : current.tradeCoverage ? {
        coverage: { closedCampaignCount: current.tradeCoverage.count },
        attribution: { status: "unavailable", unavailableReason: current.tradeCoverage.reason },
        realisedTradeQuality: { status: "unavailable", unavailableReason: current.tradeCoverage.reason, tradeCount: current.tradeCoverage.count },
      } : { attribution: { by_instrument: { buckets: [{ key: "SYNA", netResultGbp: 120 }, { key: "SYNB", netResultGbp: -40 }] } } },
      selectedCfdReview: current.empty ? null : { moneyOutcome: {
        endingRealisedCashEquityProxyGbp: 1500, netRealisedPnlGbp: -200, maxRealisedPnlDrawdownGbp: -300, accountCashFlowGbp: 1700,
      }, ...(current.cfdMissingFx ? {
        coverage: { closedCampaignCount: 99 },
        attribution: { status: "unavailable", unavailableReason: "fx_unavailable" },
        tradeQuality: {
          status: "unavailable", unavailableReason: "fx_unavailable", tradeCount: 4,
          sameDayCount: 3, underOneHourCount: 2, averageDurationHours: 4, medianDurationHours: 1.5,
        },
      } : {}) },
      selectedAccountDecisions: current.empty ? null : account === "B"
        ? review(current.isa ? isa(current) : [])
        : review(decisions(current), true),
      // The review across accounts plots every decision of each.
      decisionReviews: { A: review(decisions(current), true), ...(current.isa ? { B: review(isa(current)) } : {}) },
      risk: { A: { twr: 0.084 }, B: { twr: -0.012 } },
      ...(current.observations ? { reviewEvidence: observations(account) } : {}),
    } });
    if (path.endsWith("/health")) return current.healthFailing
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { service: "trading_max-api", status: "ok", latestRunId: "synthetic-decision-context" } });
    // The desktop app's status, and an empty CFD ledger for the import screen.
    if (path.endsWith("/health/details")) return route.fulfill({ json: { checkedAt: asOf, health: null, readiness: null, refresh: null, jobs: [], errors: [] } });
    if (path.endsWith("/imports/trading212/cfd")) return route.fulfill({ json: {
      schemaVersion: 1, parserVersion: "synthetic", files: [], importedFiles: 0, totalRawRows: 0, uniqueEvents: 0, duplicateEvents: 0,
      coverageStartDate: null, coverageEndDate: null, latestEventAt: null, lastImportedAt: null, staleAfterDays: 14, isStale: false,
      accountStatus: "active", staleRemindersEnabled: true, warnings: [],
    } });
    return route.fulfill({ json: path.endsWith("/profile")
      ? { accountLabels: current.namesake ? { A: "Shared", B: "Shared" } : {}, assistantEnabled: true } : {} });
  });
}

/** The connection drops and returns once the lens has gone stale, so it is fetched again. */
async function reconnect(page: Page) {
  await page.clock.fastForward(31_000);
  await page.context().setOffline(true);
  await page.context().setOffline(false);
}

/** A panel by its title. */
function panel(page: Page, title: string) {
  return page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: title, level: 2, exact: true }) });
}

/** One day's entry in the recent record. */
function entry(page: Page, date: string) {
  return page.locator("li.mx-journal-item").filter({ has: page.locator('time[datetime="' + date + '"]') });
}

/**
 * Where a decision's point sits: across the time axis at its day, then down the plot until its reading shows.
 * The plot's grid starts 64px from the chart's left and 40px from its top, and ends 18px from its right and
 * 30px from its bottom; the first and last days are its edges.
 */
async function pointOf(page: Page, chart: Locator, [first, day, last]: [string, string, string], reading: RegExp) {
  const box = (await chart.boundingBox())!;
  const x = box.x + 64 + (box.width - 64 - 18) * (Date.parse(day) - Date.parse(first)) / (Date.parse(last) - Date.parse(first));
  const shown = () => page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".mx-decision-review .mx-reading-tooltip");
    return card && getComputedStyle(card).visibility === "visible" && getComputedStyle(card).display !== "none" ? card.textContent ?? "" : "";
  });
  for (let y = box.y + 40; y <= box.y + box.height - 30; y += 3) {
    await page.mouse.move(x, y);
    if (reading.test(await shown())) return { x, y };
  }
  throw new Error("No point reads " + reading);
}

test.describe("decision review", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  let context: Context;
  test.beforeEach(async ({ page }) => {
    context = { benchmark: 0.021, events: true };
    await page.clock.install({ time: new Date(asOf) });
    await serve(page, () => context);
  });

  test("the decision a link opens keeps keyboard focus when a refetch updates its benchmark", async ({ page }) => {
    await page.goto("/review?account=A&decision=2026-09-01.sell.SYNA");
    const row = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Alpha/ });
    await expect(row).toBeFocused();
    await expect(row).toContainText("标普 500 同期 +2.1%");
    context = { benchmark: 0.034, events: true };
    await reconnect(page);
    await expect(row).toContainText("标普 500 同期 +3.4%");
    await expect(row).toBeFocused();
  });

  test("the decision a link opens keeps keyboard focus when a refetch corrects its security's name", async ({ page }) => {
    await page.goto("/review?account=A&decision=2026-09-01.sell.SYNA");
    const row = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Alpha/ });
    await expect(row).toBeFocused();
    context = { ...context, renamed: true };
    await reconnect(page);
    await expect(row).toContainText("Synthetic Alpha Holdings");
    await expect(row).toBeFocused();
  });

  test("a line keeps keyboard focus when a refetch corrects its security's name", async ({ page }) => {
    // The decision is open, so its card shows when the corrected name arrives.
    await page.goto("/review?account=A&decision=2026-09-01.sell.SYNA");
    const row = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Alpha/ });
    const line = panel(page, "代价最大").locator("a.mx-review-line").filter({ hasText: "SYNA" });
    await expect(row).toBeFocused();
    await line.focus();
    context = { ...context, renamed: true };
    await reconnect(page);
    await expect(row).toContainText("Synthetic Alpha Holdings");
    await expect(line).toBeFocused();
  });

  test("a line keeps keyboard focus when a refetch adds another beside it", async ({ page }) => {
    await page.goto("/review?account=A");
    const helped = panel(page, "帮你最多").locator("a.mx-review-line");
    await expect(helped).toHaveCount(1);
    const line = helped.filter({ hasText: "SYNB" });
    await line.focus();
    // The sale's 20 trading days are done, so it joins the decisions that helped.
    context = { ...context, settled: true };
    await reconnect(page);
    await expect(helped).toHaveCount(2);
    await expect(helped.nth(1)).toContainText("SYND.AS");
    await expect(line).toBeFocused();
  });

  test("\"+N\" keeps focus while its line stays crowded, then hands it to the row once all of it fits", async ({ page }) => {
    // At a laptop's width the card has room for the benchmark and one or two of the three events.
    if (page.viewportSize()!.width > 1024) await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto("/review?account=A&decision=2026-09-02.buy.SYNB");
    const entry = page.locator(".mx-decision-focus .mx-decision-entry");
    await expect(entry.getByRole("link")).toBeFocused();
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

  for (const locale of ["zh", "en"] as const) {
    test("the horizon switch's help says how each window is measured, in " + locale, async ({ page }) => {
      const zh = locale === "zh";
      await page.addInitScript((lang) => localStorage.setItem("trading_max-locale", lang), locale);
      await page.goto("/review?account=A");
      const help = page.locator(".mx-horizon-switch").getByRole("button", { name: zh ? "对照时点说明" : "Compare at explained" });
      await help.click();
      const card = page.getByRole("dialog", { name: zh ? "对照时点" : "Compare at" });
      for (const words of zh ? [
        "每笔买卖都和“不做这笔交易”比",
        "按英镑计、含分红的总回报",
        "买入后总回报为正记为赚，为负记为亏；卖出后总回报为正记为少赚，为负记为少亏",
        "“20 个交易日后”从决定当天的收盘算到之后第 20 个交易日的收盘",
        "“至今”算到最近一个收盘",
        "结果还不可得的决定不计入成绩，在时间轴上是零线上的空心点",
        "还不满 20 个交易日（“至今”则是之后还没有收盘），或还在等待价格、汇率或分红的最终值",
        "“最近”里的金额不随切换变化，总是按至今计算",
      ] : [
        "Each buy or sell is compared with not making that trade",
        "by its total return in GBP over the window, dividends included",
        "after a sell, a positive return is a gain given up and a negative one a loss avoided",
        "“20 trading days” runs from the close on the day of the decision to the close 20 trading days later",
        "“To date” runs to the latest close",
        "A decision whose result is not available yet is not scored and sits as a hollow point on the timeline’s zero line",
        "or one still waiting for the final value of a price, exchange rate or dividend",
        "Amounts under “Recently” do not follow the switch",
      ]) await expect(card).toContainText(words);
      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(help).toBeFocused();
    });
  }
});

test.describe("a link to one decision", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  const sale = "/review?account=A&decision=2026-10-14.sell.SYND.AS";
  let context: Context;
  test.beforeEach(async ({ page }) => {
    context = { benchmark: 0.021, events: true };
    await page.clock.install({ time: new Date(asOf) });
    await serve(page, () => context);
  });

  test("an earlier account review link opens the review in that account, on its decision", async ({ page }) => {
    await page.goto("/account-analysis?account=A&reviewView=decisions&decision=2026-10-14.sell.SYND.AS");
    // The decisions angle is the review itself now, so the address leaves it out and keeps the rest.
    await expect(page).toHaveURL((url) => url.pathname + url.search === sale);
    await expect(page.getByRole("group", { name: "复盘范围" }).getByRole("button", { name: "Invest" })).toHaveAttribute("aria-pressed", "true");
    const card = page.locator(".mx-decision-focus");
    await expect(card.getByRole("link", { name: /Synthetic Delta/ })).toBeFocused();
    await expect(card).toBeInViewport();
    // A link without an account opens Invest, on the angle it names.
    await page.goto("/account-analysis?reviewView=attribution");
    await expect(page).toHaveURL((url) => url.pathname === "/review" && url.searchParams.get("account") === "A" && url.searchParams.get("reviewView") === "attribution");
    await expect(page.getByRole("tab", { name: "盈亏归因" })).toHaveAttribute("aria-selected", "true");
    // The desktop app's own links do the same.
    await page.goto("/desktop/account-analysis?account=B&reviewView=decisions");
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/desktop/review?account=B");
    await expect(page.getByRole("group", { name: "复盘范围" }).getByRole("button", { name: "Stocks ISA" })).toHaveAttribute("aria-pressed", "true");
  });

  test("the review's recent record links each decision to itself", async ({ page }) => {
    await page.goto("/review");
    const recent = page.locator(".mx-review-journal").getByRole("link", { name: "卖出 SYND.AS" });
    await expect(recent).toHaveAttribute("href", sale + "&reviewWindow=to_date");
    // A T day says what its excess did, as on the account's review.
    await expect(page.locator(".mx-review-journal").getByRole("link", { name: /SYNG/ })).toHaveText("日内往返后净买入 SYNG");
    await recent.click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === sale + "&reviewWindow=to_date");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Delta/ })).toBeFocused();
  });

  test("opening a settled trade from the recent record keeps its to-date amount on reload and Back", async ({ page }) => {
    await page.goto("/review?account=A");
    const horizon = page.getByRole("group", { name: "对照时点" });
    await expect(horizon.getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
    const row = entry(page, "2026-09-02");
    await expect(row.locator(".mx-journal-figure")).toContainText("+£70");
    const link = row.getByRole("link", { name: "买入 SYNB" });
    await expect(link).toHaveAttribute("href", "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=to_date");
    await link.click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=to_date");
    const focus = page.locator(".mx-decision-focus");
    await expect(focus.locator(".mx-row-value")).toContainText("+£70");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£60");
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(focus.locator(".mx-row-value")).toContainText("+£70");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£60");
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A");
    await expect(focus).toHaveCount(0);
    await expect(row.locator(".mx-journal-figure")).toContainText("+£70");
  });

  test("ranked links and timeline picks keep each visit's comparison window across Back", async ({ page }) => {
    await page.goto("/review?account=A");
    const horizon = page.getByRole("group", { name: "对照时点" });
    const pressed = (name: string) => expect(horizon.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    const focus = page.locator(".mx-decision-focus");
    const ranked = () => panel(page, "帮你最多").locator("a.mx-review-line").filter({ hasText: "SYNB" });

    // Ranked link: 20 sessions -> clear -> To date -> Back twice restores 20 sessions.
    await pressed("20 个交易日后");
    await expect(ranked()).toContainText("+£60");
    await expect(ranked()).toHaveAttribute("href", "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=20_sessions");
    await ranked().click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=20_sessions");
    await expect(focus.locator(".mx-row-value")).toContainText("+£60");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£70");
    await pressed("20 个交易日后");

    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(focus).toHaveCount(0);
    await horizon.getByRole("button", { name: "至今" }).click();
    await expect(ranked()).toContainText("+£70");
    await expect(ranked()).toHaveAttribute("href", "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=to_date");
    await ranked().click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=to_date");
    await expect(focus.locator(".mx-row-value")).toContainText("+£70");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£60");
    await pressed("至今");

    await page.goBack();
    await expect(focus).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=20_sessions");
    await expect(focus.locator(".mx-row-value")).toContainText("+£60");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£70");
    await pressed("20 个交易日后");

    // Timeline pick: 20 sessions -> clear -> To date -> Back twice restores 20 sessions.
    await page.goto("/review?account=A");
    const timeline = page.locator(".mx-decision-review");
    const chart = timeline.getByRole("group", { name: "买卖决定的时间线" });
    const spoken = timeline.locator("[aria-live]:not([role])");
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await chart.press("Home");
    await chart.press("ArrowRight");
    await expect(spoken).toContainText("SYNB 买入 £800");
    await expect(spoken).toContainText("+£60");
    await chart.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=20_sessions");
    await expect(focus.locator(".mx-row-value")).toContainText("+£60");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£70");
    await pressed("20 个交易日后");

    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(focus).toHaveCount(0);
    await horizon.getByRole("button", { name: "至今" }).click();
    await chart.press("Home");
    await chart.press("ArrowRight");
    await expect(spoken).toContainText("SYNB 买入 £800");
    await expect(spoken).toContainText("+£70");
    await chart.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=to_date");
    await expect(focus.locator(".mx-row-value")).toContainText("+£70");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£60");
    await pressed("至今");

    await page.goBack();
    await expect(focus).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=20_sessions");
    await expect(focus.locator(".mx-row-value")).toContainText("+£60");
    await expect(focus.locator(".mx-row-value")).not.toContainText("+£70");
    await pressed("20 个交易日后");
  });

  test("opens on its decision, focused and in view, to date while its window is young", async ({ page }) => {
    await page.goto(sale);
    const card = page.locator(".mx-decision-focus");
    const row = card.getByRole("link", { name: /Synthetic Delta/ });
    await expect(row).toBeFocused();
    await expect(card).toBeInViewport();
    await expect(row).toContainText("卖出 £300");
    await expect(row).toContainText("+£21");
    await expect(page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "每笔决定至今的结果", level: 2 })).toBeVisible();
    // Later renders and refetches leave focus where the reader puts it.
    const help = page.getByRole("button", { name: "买卖决定说明" });
    await help.focus();
    context = { benchmark: 0.034, events: true };
    await reconnect(page);
    await expect(row).toContainText("标普 500 同期 +3.4%");
    await expect(help).toBeFocused();
  });

  test("names the valuation model saved by the end of the decision's day and opens it in the journal", async ({ page }, info) => {
    const days: string[] = [];
    await page.route("**/api/backend/research/SYND.AS/models/as-of*", (route) => {
      days.push(new URL(route.request().url()).searchParams.get("day") ?? "");
      return route.fulfill({ json: { day: "2026-10-14", model: {
        id: "synthetic-version", savedAt: "2026-10-13T16:20:00Z", family: "cash-flow", horizon: 5, currency: "EUR",
      } } });
    });
    await page.goto(sale);
    const card = page.locator(".mx-decision-focus");
    const model = card.getByRole("link", { name: /^当时的估值模型/ });
    await expect(model).toHaveText("当时的估值模型 · 10月13日保存");
    await expect(model).toHaveAttribute("href", "/research?ticker=SYND.AS&view=ledger&notebook=models&model=synthetic-version");
    expect(days).toEqual(["2026-10-14"]);
    // The decision keeps focus; the link follows it in the reading order.
    await expect(card.getByRole("link", { name: /Synthetic Delta/ })).toBeFocused();
    const dir = process.env.VALUATION_ALERTS_SCREENSHOTS_DIR;
    if (dir) await card.screenshot({ path: dir + "/" + info.project.name + "-review-model.png" });
  });

  test("a failed refetch and its recovery leave focus and the horizon where the reader put them", async ({ page }) => {
    await page.goto(sale);
    const row = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Delta/ });
    await expect(row).toBeFocused();
    const twenty = page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" });
    const failedStatus = page.getByRole("status").filter({ hasText: "投资复盘更新失败" });
    const recoveredStatus = page.getByRole("status").filter({ hasText: "投资复盘已恢复。" });
    await expect(failedStatus).toHaveCount(0);
    await expect(recoveredStatus).toHaveCount(0);
    await twenty.click();
    await row.focus();
    context = { ...context, failing: true };
    await reconnect(page);
    // Once the retry fails, report it beside the data time and keep the review mounted.
    await page.clock.fastForward(5_000);
    const failure = page.getByRole("button", { name: /更新失败 · 上次成功 \d{2}:\d{2} · 重试/ });
    await expect(failure).toBeVisible();
    await expect(failedStatus).toHaveCount(1);
    await expect(recoveredStatus).toHaveCount(0);
    await expect(row).toBeFocused();
    await expect(twenty).toHaveAttribute("aria-pressed", "true");
    context = { ...context, failing: false, benchmark: 0.034 };
    // Retry the failed lens itself, without moving focus to the retry button.
    const recovered = page.waitForResponse((response) =>
      response.ok() && new URL(response.url()).pathname.endsWith("/dashboard/lens/account-analysis"));
    await reconnect(page);
    await recovered;
    await expect(failure).toHaveCount(0);
    await expect(recoveredStatus).toHaveCount(1);
    await expect(failedStatus).toHaveCount(0);
    await expect(row).toBeFocused();
    await expect(twenty).toHaveAttribute("aria-pressed", "true");
  });

  test("two failed publication checks show a warning that clears when the same run is reachable", async ({ page }) => {
    const health = (status: number) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/backend/health" && response.status() === status);
    const first = health(200);
    await page.goto(sale);
    await first;
    const row = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Delta/ });
    const failure = page.getByRole("button", { name: /更新失败 · 上次成功 \d{2}:\d{2} · 重试/ });
    const failedStatus = page.getByRole("status").filter({ hasText: "投资复盘更新失败" });
    const recoveredStatus = page.getByRole("status").filter({ hasText: "投资复盘已恢复。" });
    await expect(row).toBeFocused();
    context = { ...context, healthFailing: true };
    const dropped = health(503);
    await page.clock.fastForward(61_000);
    await dropped;
    await expect(failure).toHaveCount(0);
    const outage = health(503);
    await page.clock.fastForward(61_000);
    await outage;
    await expect(failure).toBeVisible();
    await expect(failedStatus).toHaveCount(1);
    await expect(recoveredStatus).toHaveCount(0);
    await expect(row).toBeFocused();

    // The service can recover without publishing another snapshot.
    context = { ...context, healthFailing: false };
    const recovery = health(200);
    await page.clock.fastForward(121_000);
    await recovery;
    await expect(failure).toHaveCount(0);
    await expect(recoveredStatus).toHaveCount(1);
    await expect(failedStatus).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("an observing decision says so rather than showing £0, and a T names its net side", async ({ page }) => {
    await page.goto("/review?account=A&decision=2026-10-20.buy.SYNE");
    const observing = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Epsilon/ });
    await expect(observing).toBeFocused();
    await expect(observing).toContainText("观察中");
    await expect(observing).not.toContainText("£0");
    await page.goto("/review?account=A&decision=2026-10-01.buy.SYNG");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Gamma/ })).toContainText("日内往返后净买入 £90");
  });

  test("keeps the angle in the address for refresh and Back", async ({ page }) => {
    await page.goto(sale);
    await expect(page.locator(".mx-decision-focus").getByRole("link")).toBeFocused();
    await expect(page.getByRole("tab", { name: "投资结果" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "盈亏归因" }).click();
    await expect(page).toHaveURL(/reviewView=attribution/);
    await expect(page).toHaveURL(/decision=2026-10-14\.sell\.SYND\.AS/);
    await page.reload();
    await expect(page.getByRole("tab", { name: "盈亏归因" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("tab", { name: "投资结果" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
  });

  test("its button lets the decision go and keeps the scope and angle", async ({ page, browserName }) => {
    await page.goto("/review?account=A&reviewView=attribution&decision=2026-10-14.sell.SYND.AS");
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&reviewView=attribution");
    // Focus returns to the panel the decision led, whose timeline comes next.
    expect(await page.evaluate(() => ({
      name: document.activeElement?.textContent,
      panel: Boolean(document.activeElement?.closest(".mx-decision-review")),
    }))).toEqual({ name: "每笔决定至今的结果", panel: true });
    // Safari's Tab skips buttons unless the reader turns that on, so only other engines check the next stop.
    if (browserName !== "webkit") {
      await page.keyboard.press("Tab");
      await expect(page.locator(".mx-decision-review").getByRole("group", { name: "买卖决定的时间线" })).toBeFocused();
    }
  });

  test("letting go of a decision near the top keeps focus below the sticky bar", async ({ page, browserName }) => {
    await page.goto(sale);
    const card = page.locator(".mx-decision-focus");
    await expect(card.getByRole("link")).toBeFocused();
    const barBottom = await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().bottom);
    // The card sits just under the bar, so the panel's title is behind the bar.
    await card.evaluate((element, below) => window.scrollBy({ top: element.getBoundingClientRect().top - below - 4, behavior: "instant" }), barBottom);
    expect(await page.locator(".mx-decision-review h2").evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(barBottom);
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(card).toHaveCount(0);
    const focusedTop = () => page.evaluate(() => document.activeElement?.getBoundingClientRect().top ?? -1);
    expect(await focusedTop()).toBeGreaterThanOrEqual(barBottom);
    if (browserName !== "webkit") {
      await page.keyboard.press("Tab");
      const chart = page.locator(".mx-decision-review").getByRole("group", { name: "买卖决定的时间线" });
      await expect(chart).toBeFocused();
      expect(await focusedTop()).toBeGreaterThanOrEqual(barBottom);
      // The next stop shows its focus ring.
      expect(await chart.evaluate((element) => element.matches(":focus-visible") && getComputedStyle(element).outlineStyle)).toBe("solid");
    }
  });

  test("each decision keeps its own horizon, and the review without one keeps its own", async ({ page }) => {
    const horizon = page.getByRole("group", { name: "对照时点" });
    const pressed = (name: string) => expect(horizon.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    await page.goto(sale);
    await pressed("至今");
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    // Letting go leaves the review as it was; the choice that follows is the ordinary review's own.
    await pressed("至今");
    await horizon.getByRole("button", { name: "20 个交易日后" }).click();
    await page.goBack();
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
    // The young decision comes back to date, its own horizon.
    await pressed("至今");
    await page.goForward();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await pressed("20 个交易日后");
  });

  test("deselecting a settled decision opened to date keeps the account review to date", async ({ page }) => {
    await page.goto("/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=to_date");
    const horizon = page.getByRole("group", { name: "对照时点" });
    const focus = page.locator(".mx-decision-focus");
    const ranked = panel(page, "帮你最多").locator("a.mx-review-line").filter({ hasText: "SYNB" });
    await expect(focus.locator(".mx-row-value")).toContainText("+£70");
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await expect(ranked).toContainText("+£70");

    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A");
    await expect(focus).toHaveCount(0);
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await expect(ranked).toContainText("+£70");
    await expect(ranked).not.toContainText("+£60");
  });

  test("consecutive deselections keep the window each decision showed", async ({ page }) => {
    const horizon = page.getByRole("group", { name: "对照时点" });
    const pressed = (name: string) => expect(horizon.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    const focus = page.locator(".mx-decision-focus");
    const ranked = panel(page, "帮你最多").locator("a.mx-review-line").filter({ hasText: "SYNB" });
    await page.goto("/review?account=A&decision=2026-09-02.buy.SYNB&reviewWindow=20_sessions");
    await pressed("20 个交易日后");
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(focus).toHaveCount(0);
    await pressed("20 个交易日后");
    await expect(ranked).toContainText("+£60");
    // The recent record opens the same trade to date; letting it go keeps the review to date.
    await entry(page, "2026-09-02").getByRole("link", { name: "买入 SYNB" }).click();
    await pressed("至今");
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(focus).toHaveCount(0);
    await pressed("至今");
    await expect(ranked).toContainText("+£70");
    await expect(ranked).not.toContainText("+£60");
  });

  test("changing a decision's window on an older link writes it to the address", async ({ page }) => {
    const horizon = page.getByRole("group", { name: "对照时点" });
    await page.goto(sale);
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await horizon.getByRole("button", { name: "20 个交易日后" }).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === sale + "&reviewWindow=20_sessions");
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname + url.search === sale);
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await page.goForward();
    await expect(page).toHaveURL((url) => url.pathname + url.search === sale + "&reviewWindow=20_sessions");
    await expect(horizon.getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(horizon.getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a refetch that completes a decision's window keeps the horizon it shows", async ({ page }) => {
    await page.goto(sale);
    const card = page.locator(".mx-decision-focus");
    const toDate = page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "至今" });
    await expect(card.getByRole("link")).toBeFocused();
    await expect(toDate).toHaveAttribute("aria-pressed", "true");
    context = { ...context, benchmark: 0.034, settled: true };
    await reconnect(page);
    // The refetched figures arrive, and the review stays to date, where the reader was looking.
    await expect(card).toContainText("标普 500 同期 +3.4%");
    await expect(toDate).toHaveAttribute("aria-pressed", "true");
    await expect(card).toContainText("+£21");
  });

  test("horizon choices outlive switching scope and coming back", async ({ page }) => {
    const horizon = page.getByRole("group", { name: "对照时点" });
    const pressed = (name: string) => expect(horizon.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    await page.goto(sale);
    await pressed("至今");
    await horizon.getByRole("button", { name: "20 个交易日后" }).click();
    await page.getByRole("group", { name: "复盘范围" }).getByRole("button", { name: "全部" }).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review");
    await expect(page.locator(".mx-review-accounts")).toBeVisible();
    // Every account has a horizon of its own.
    await pressed("20 个交易日后");
    await horizon.getByRole("button", { name: "至今" }).click();
    await page.goBack();
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
    // The decision is drawn anew and keeps the horizon the reader chose for it.
    await pressed("20 个交易日后");
    await page.goForward();
    await expect(page.locator(".mx-review-accounts")).toBeVisible();
    await pressed("至今");
  });

  test("a highlight opens its evidence through the address, and Back returns", async ({ page }) => {
    await page.goto("/review?account=A");
    await page.getByRole("button", { name: /已实现盈利贡献/ }).click();
    await expect(page).toHaveURL(/reviewView=attribution/);
    await expect(page.getByRole("tab", { name: "盈亏归因" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "账户分析" })).toBeFocused();
    await page.goBack();
    await expect(page.getByRole("tab", { name: "投资结果" })).toHaveAttribute("aria-selected", "true");
  });

  test("an account's analysis keeps its angles, with round trips and best closes under trade quality", async ({ page }) => {
    await page.goto("/review?account=A");
    await expect(page.getByRole("region", { name: "账户要点" })).toBeVisible();
    // The decisions are the review itself, so no angle repeats them.
    await expect(page.getByRole("tablist", { name: "复盘角度" }).getByRole("tab"))
      .toHaveText(["投资结果", "盈亏归因", "交易质量", "行为分析", "策略风险", "阶段与事件", "期末风险"]);
    await expect(page.getByRole("heading", { name: "日内往返", level: 2 })).toHaveCount(0);
    await page.getByRole("tab", { name: "交易质量" }).click();
    await expect(page).toHaveURL(/reviewView=quality/);
    await expect(page.getByRole("heading", { name: "日内往返", level: 2 })).toBeVisible();
    await expect(page.getByRole("table", { name: "结果最大的日内往返" }).getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "与持有期最高收盘对照", level: 2 })).toBeVisible();
    await expect(page.getByRole("table", { name: "少赚最多的已结束交易" })).toContainText("SYNA");
  });

  test("arrows explore Review perspectives and Space commits one named panel", async ({ page }) => {
    await page.goto("/review?account=A");
    const angles = page.getByRole("tablist", { name: "复盘角度" });
    const outcomes = angles.getByRole("tab", { name: "投资结果" });
    const attribution = angles.getByRole("tab", { name: "盈亏归因" });
    await expect(outcomes).toHaveAttribute("aria-selected", "true");
    await outcomes.focus();
    const entries = await page.evaluate(() => history.length);
    await page.keyboard.press("ArrowRight");
    await expect(attribution).toBeFocused();
    await expect(outcomes).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await page.keyboard.press("Space");
    await expect(attribution).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "盈亏归因" })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(entries + 1);
    await expect(page).toHaveURL(/reviewView=attribution/);
    await expect(attribution).toHaveAttribute("tabindex", "0");
    await expect(outcomes).toHaveAttribute("tabindex", "-1");
    // The open angle is the tab stop: Tab leaves the list and Shift+Tab returns to it.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).not.toBe("tab");
    await page.keyboard.press("Shift+Tab");
    await expect(attribution).toBeFocused();
  });

  test("a decision the data no longer has leaves the normal review", async ({ page }) => {
    await page.goto("/review?account=A&decision=2026-10-15.buy.GONE");
    await expect(panel(page, "代价最大").locator("a.mx-review-line").filter({ hasText: "SYNA" })).toBeVisible();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a link that fits two securities sharing a ticker leaves the normal review", async ({ page }) => {
    context = { ...context, twin: true };
    await page.goto(sale);
    await expect(panel(page, "代价最大").locator("a.mx-review-line").filter({ hasText: "SYNA" })).toBeVisible();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("switching scope keeps the angle and lets the decision go", async ({ page }) => {
    await page.goto("/review?account=A&reviewView=attribution&decision=2026-10-14.sell.SYND.AS");
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
    // Each scope is a button, alike for the keyboard on every device.
    const isaScope = page.getByRole("group", { name: "复盘范围" }).getByRole("button", { name: "Stocks ISA" });
    await isaScope.focus();
    await isaScope.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&reviewView=attribution");
    await expect(isaScope).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("tab", { name: "盈亏归因" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
  });
});

test.describe("the review across accounts", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  let context: Context;
  test.beforeEach(async ({ page }) => {
    context = { benchmark: 0.021, events: false, isa: true };
    await page.clock.install({ time: new Date(asOf) });
    await serve(page, () => context);
  });

  test("the scope switch updates the address and what the review shows", async ({ page }) => {
    await page.goto("/review");
    const scope = page.getByRole("group", { name: "复盘范围" });
    const lead = page.getByRole("region", { name: "复盘结论" });
    const verdict = (label: string) => lead.locator(".mx-metric").filter({ hasText: label }).locator(".mx-number-value");
    await expect(scope.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    // Every account: the verdicts across both, then each account's own.
    await expect(verdict("买入后")).toHaveText("赚 £150");
    await expect(verdict("卖出后")).toHaveText("少赚 £65");
    await expect(verdict("日内往返")).toHaveText("赚 £12");
    await expect(lead.locator("a.mx-review-accounts-row")).toHaveCount(2);
    await expect(page.getByRole("tablist", { name: "复盘角度" })).toHaveCount(0);

    await scope.getByRole("button", { name: "Invest" }).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A");
    await expect(verdict("买入后")).toHaveText("赚 £60");
    await expect(verdict("卖出后")).toHaveText("少赚 £40");
    // One account adds its money beneath its verdicts.
    await expect(lead.locator(".mx-review-money dt")).toHaveText(["期末价值", "历史净盈亏", "最大盈亏回撤", "净入金"]);
    await expect(lead.locator(".mx-review-accounts")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "投资结果" })).toHaveAttribute("aria-selected", "true");

    await scope.getByRole("button", { name: "CFD" }).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=C");
    // CFD history has results but no decisions: its money, then its own analysis.
    await expect(lead).toContainText("已实现现金权益");
    await expect(lead.locator(".mx-metric").first().locator(".mx-number-value")).toHaveText("£1,500.00");
    await expect(page.locator(".mx-decision-review")).toHaveCount(0);
    await expect(page.locator(".mx-review-journal-panel")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "对照时点" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "导入记录" })).toBeVisible();

    await scope.getByRole("button", { name: "全部" }).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review");
    await expect(lead.locator("a.mx-review-accounts-row")).toHaveCount(2);
    // Each scope is a place in history.
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=C");
    await expect(scope.getByRole("button", { name: "CFD" })).toHaveAttribute("aria-pressed", "true");
  });

  test("each account's row reads its verdicts and opens its review", async ({ page, isMobile }) => {
    await page.goto("/review");
    const rows = page.locator("a.mx-review-accounts-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("href", "/review?account=A");
    await expect(rows.nth(1)).toHaveAttribute("href", "/review?account=B");
    // On a phone a row keeps the account, its two verdicts and its way in.
    // The account's name keeps its words together with a no-break space.
    if (isMobile) {
      await expect(rows.nth(0)).toHaveAccessibleName(/^Invest 买入后 赚 £60 卖出后 少赚 £40$/);
      await expect(rows.nth(1)).toHaveAccessibleName(/^Stocks\sISA 买入后 赚 £90 卖出后 少赚 £25$/);
    } else {
      await expect(rows.nth(0)).toHaveAccessibleName(/^Invest 买入后 赚 £60 卖出后 少赚 £40 日内往返 赚 £12 TWR \+8\.4%$/);
      await expect(rows.nth(1)).toHaveAccessibleName(/^Stocks\sISA 买入后 赚 £90 卖出后 少赚 £25 日内往返 — TWR -1\.2%$/);
    }
    await rows.nth(1).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B");
    await expect(page.getByRole("group", { name: "复盘范围" }).getByRole("button", { name: "Stocks ISA" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mx-review-money")).toBeVisible();
  });

  test("a decision that helped most opens in its account, focused", async ({ page }) => {
    await page.goto("/review");
    const helped = panel(page, "帮你最多").locator("a.mx-review-line");
    const cost = panel(page, "代价最大").locator("a.mx-review-line");
    // Buys and sales together, by what they did against not trading, each naming its account.
    await expect(helped).toHaveCount(2);
    await expect(helped.nth(0)).toContainText("SYNI");
    await expect(helped.nth(0)).toContainText("Stocks ISA");
    await expect(helped.nth(1)).toContainText("SYNB");
    await expect(helped.nth(1)).toContainText("Invest");
    await expect(cost).toHaveCount(2);
    await expect(cost.nth(0)).toContainText("SYNA");
    await expect(cost.nth(1)).toContainText("SYNK");
    await expect(helped.nth(0)).toHaveAttribute("href", "/review?account=B&decision=2026-09-03.buy.SYNI&reviewWindow=20_sessions");
    await helped.nth(0).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&decision=2026-09-03.buy.SYNI&reviewWindow=20_sessions");
    await expect(page.getByRole("group", { name: "复盘范围" }).getByRole("button", { name: "Stocks ISA" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Iota/ })).toBeFocused();
    await expect(page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("each reading names its account, and Enter opens its decision there", async ({ page }) => {
    await page.goto("/review");
    const timeline = page.locator(".mx-decision-review");
    const chart = timeline.getByRole("group", { name: "买卖决定的时间线" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const spoken = timeline.locator("[aria-live]:not([role])");
    await chart.press("Home");
    await expect(spoken).toHaveText(/Invest · SYNA 卖出 £500/);
    await chart.press("ArrowRight");
    await expect(spoken).toHaveText(/Invest · SYNB 买入 £800/);
    await chart.press("ArrowRight");
    await expect(spoken).toHaveText(/Stocks\sISA · SYNI 买入 £400/);
    await chart.press("Enter");
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&decision=2026-09-03.buy.SYNI&reviewWindow=20_sessions");
    await expect(timeline.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Iota/ })).toBeFocused();
    // Within one account the readings leave the account out.
    await chart.press("Home");
    await expect(spoken).toHaveText(/^9月3日 · SYNI 买入 £400/);
  });

  test("a click on a point opens its decision in its account", async ({ page, isMobile }) => {
    test.skip(isMobile, "Hovering finds the point; touch readings are covered by the chart reading specs.");
    await page.goto("/review");
    const chart = page.locator(".mx-decision-review").getByRole("group", { name: "买卖决定的时间线" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await chart.scrollIntoViewIfNeeded();
    const point = await pointOf(page, chart, ["2026-09-01", "2026-09-10", "2026-10-20"], /Stocks\sISA · SYNK 卖出 £250/);
    await page.mouse.click(point.x, point.y);
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&decision=2026-09-10.sell.SYNK&reviewWindow=20_sessions");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Kappa/ })).toBeFocused();
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });
    test("a tap pins the decision's reading in a closable strip, speaks it once and still opens the decision", async ({ page, isMobile }) => {
      test.skip(isMobile, "The point is found by hovering; phones use the same strip.");
      // Within one account and review window the timeline stays in place while the tapped decision
      // opens; a change of window reloads the review, and the opened decision then takes focus.
      await page.goto("/review?account=B&reviewWindow=20_sessions");
      const review = page.locator(".mx-decision-review");
      const chart = review.getByRole("group", { name: "买卖决定的时间线" });
      await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
      await chart.scrollIntoViewIfNeeded();
      const point = await pointOf(page, chart, ["2026-09-03", "2026-09-10", "2026-09-10"], /SYNK 卖出 £250/);
      await page.touchscreen.tap(point.x, point.y);
      await expect(page).toHaveURL((url) => url.searchParams.get("decision") === "2026-09-10.sell.SYNK"
        && url.searchParams.get("account") === "B" && url.searchParams.get("reviewWindow") === "20_sessions");
      const strip = page.locator(".mx-decision-review .mx-chart-strip");
      await expect(strip).toContainText(/SYNK 卖出 £250/);
      // The hover card gives way to the strip, and the live region speaks the tap once.
      await expect(page.locator(".mx-decision-review .mx-reading-tooltip")).toHaveCount(0);
      const spoken = page.locator(".mx-decision-review [aria-live]:not([role])");
      await expect(spoken).toHaveText(/SYNK 卖出 £250/);
      const close = strip.getByRole("button", { name: "关闭读数" });
      await expect(close).toHaveCSS("width", "44px");
      await close.tap();
      await expect(strip).toHaveCount(0);
      await expect(spoken).toHaveText("");
    });

    test("a tapped twin keeps its own reading when the review refreshes", async ({ page, isMobile }) => {
      test.skip(isMobile, "The point is found by hovering; phones use the same strip.");
      // Two securities sold the same day under one ticker: the pinned reading follows the published
      // ordinal into the refetched rows, never the first sale of that ticker.
      context = { ...context, twin: true };
      await page.goto("/review?account=A&reviewWindow=to_date");
      const chart = page.locator(".mx-decision-review").getByRole("group", { name: "买卖决定的时间线" });
      await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
      await chart.scrollIntoViewIfNeeded();
      const point = await pointOf(page, chart, ["2026-09-01", "2026-10-14", "2026-10-20"], /SYND\.AS 卖出 £120/);
      await page.touchscreen.tap(point.x, point.y);
      await expect(page).toHaveURL((url) => url.searchParams.get("decision") === "2026-10-14.sell.SYND.AS"
        && url.searchParams.get("reviewOrdinal") === "1");
      const strip = page.locator(".mx-decision-review .mx-chart-strip");
      await expect(strip).toContainText(/SYND\.AS 卖出 £120/);
      context = { ...context, benchmark: 0.034 };
      await reconnect(page);
      await expect(page.locator(".mx-decision-focus")).toContainText("+3.4%");
      await expect(strip).toContainText(/SYND\.AS 卖出 £120/);
      await expect(strip).not.toContainText("£300");
    });

    test("a tapped sale opens in its own account when two accounts share a name", async ({ page, isMobile }) => {
      test.skip(isMobile, "The point is found by hovering; phones use the same strip.");
      // Both accounts are called Shared and sold SYND.AS on 14 October: the tap follows the account's code.
      // Across accounts a tap opens the decision in its account, which reloads the timeline as a change
      // of window does; the decision card then holds the reading, and a refresh keeps the same sale.
      context = { ...context, namesake: true };
      await page.goto("/review?reviewWindow=to_date");
      const chart = page.locator(".mx-decision-review").getByRole("group", { name: "买卖决定的时间线" });
      await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
      await chart.scrollIntoViewIfNeeded();
      const point = await pointOf(page, chart, ["2026-09-01", "2026-10-14", "2026-10-20"], /SYND\.AS 卖出 £75/);
      await page.touchscreen.tap(point.x, point.y);
      await expect(page).toHaveURL((url) => url.searchParams.get("account") === "B"
        && url.searchParams.get("decision") === "2026-10-14.sell.SYND.AS");
      const opened = page.locator(".mx-decision-focus");
      await expect(opened).toContainText("£75");
      await expect(opened).not.toContainText("£300");
      context = { ...context, benchmark: 0.034 };
      await reconnect(page);
      await expect(opened).toContainText("+3.4%");
      await expect(opened).toContainText("£75");
      await expect(opened).not.toContainText("£300");
    });

    test("on a phone, a tapped reading docks below the top bar once its plot scrolls up", async ({ page, isMobile }) => {
      test.skip(isMobile, "The point is found by hovering; this sets the phone width itself.");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/review?account=B&reviewWindow=20_sessions");
      const chart = page.locator(".mx-decision-review").getByRole("group", { name: "买卖决定的时间线" });
      await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
      await chart.scrollIntoViewIfNeeded();
      const point = await pointOf(page, chart, ["2026-09-03", "2026-09-10", "2026-09-10"], /SYNK 卖出 £250/);
      await page.touchscreen.tap(point.x, point.y);
      const strip = page.locator(".mx-decision-review .mx-chart-strip");
      await expect(strip).toContainText(/SYNK 卖出 £250/);
      // The tap opens the decision, whose focus can scroll the page; read the strip once that settles.
      await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Kappa/ })).toBeFocused();
      // Scrolled until the space above the plot sits under the top bar, the strip stays in view.
      await chart.evaluate((plot) => window.scrollBy(0, plot.getBoundingClientRect().top - 40));
      await expect.poll(() => chart.evaluate((plot) => Math.round(plot.getBoundingClientRect().top))).toBeLessThan(60);
      await expect(strip).toHaveAttribute("data-docked", "");
      const docked = (await strip.boundingBox())!;
      const bar = (await page.locator(".mx-topbar").boundingBox())!;
      const tabs = page.locator(".mx-mobile-dock");
      const floor = await tabs.isVisible() ? (await tabs.boundingBox())!.y : page.viewportSize()!.height;
      expect(docked.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
      expect(docked.y + docked.height).toBeLessThanOrEqual(floor + 1);
      await expect(strip.getByRole("button", { name: "关闭读数" })).toBeInViewport();
      await strip.getByRole("button", { name: "关闭读数" }).tap();
      await expect(strip).toHaveCount(0);
    });
  });

  test("the recent record keeps a day's decisions in an account together, and each chip opens its own", async ({ page }) => {
    // Synthetic Beta and four more buys share 2 September in Invest.
    context = { ...context, cluster: true };
    await page.goto("/review?account=A");
    const day = entry(page, "2026-09-02");
    await expect(day).toHaveCount(1);
    await expect(day.locator(".mx-journal-act")).toHaveText("买入 5 笔");
    // Their results to date add up on the day's line.
    await expect(day.locator(".mx-journal-figure")).toHaveText("+£118");
    const chips = day.locator(".mx-journal-chips").getByRole("link");
    await expect(chips).toHaveCount(5);
    await expect(chips.first()).toHaveAccessibleName("买入 SYNB £800");
    // A day with one decision makes its action the link.
    await expect(entry(page, "2026-10-14").getByRole("link")).toHaveText("卖出 SYND.AS");
    // At most four lines a side.
    await expect(panel(page, "帮你最多").locator("a.mx-review-line")).toHaveCount(4);
    const chip = chips.filter({ hasText: "SYNC3" });
    await expect(chip).toHaveAttribute("href", "/review?account=A&decision=2026-09-02.buy.SYNC3&reviewWindow=to_date");
    await chip.click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNC3&reviewWindow=to_date");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic cluster 3/ })).toBeFocused();
  });

  test("twin decisions keep chips of their own", async ({ page }) => {
    context = { ...context, twin: true };
    // React reports rows that share a key in development builds.
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (/same key/i.test(message.text())) warnings.push(message.text());
    });
    await page.goto("/review");
    const day = entry(page, "2026-10-14");
    await expect(day.locator(".mx-journal-act")).toHaveText("卖出 2 笔");
    const twins = day.getByRole("link", { name: /SYND\.AS/ });
    await expect(twins).toHaveCount(2);
    for (const [ordinal, twin] of (await twins.all()).entries()) {
      await expect(twin).toHaveAttribute("href", "/review?account=A&decision=2026-10-14.sell.SYND.AS&reviewOrdinal=" + ordinal + "&reviewWindow=to_date");
    }
    await twins.nth(1).click();
    const focus = page.locator(".mx-decision-focus").getByRole("link");
    await expect(focus).toContainText("£120");
    await expect(focus).toBeFocused();
    expect(warnings).toEqual([]);
  });

  test("switching accounts waits for the selected account and never displays another account's figures", async ({ page }) => {
    let holdB = false;
    let heldB = new Promise<void>(() => {});
    let releaseB = () => {};
    let routeB: Promise<unknown> = Promise.resolve();
    let finishRouteB: (error?: unknown) => void = () => {};
    const money: Record<string, object> = {
      A: { ending_value_gbp: 2000, net_pnl_gbp: 250, max_pnl_drawdown_gbp: -100, net_external_flows_gbp: 1750 },
      B: { ending_value_gbp: 3500, net_pnl_gbp: -120, max_pnl_drawdown_gbp: -200, net_external_flows_gbp: 3620 },
    };
    await page.route("**/api/backend/dashboard/lens/account-analysis*", async (route) => {
      const account = new URL(route.request().url()).searchParams.get("account") ?? "A";
      const held = account === "B" && holdB;
      try {
        if (held) await heldB;
        await route.fulfill({
          json: {
            runId: "synthetic-decision-context",
            brokerAsOf: asOf,
            reviewAsOf: asOf,
            totalValueGbp: account === "B" ? 3500 : 2000,
            totalCashGbp: 100,
            holdings: [],
            nav: [],
            accounts: [{ code: account, isInvestable: true, totalValueGbp: account === "B" ? 3500 : 2000 }],
            selectedAccountReview: { moneyOutcome: money[account] ?? money.A },
            selectedAccountDecisions: {
              status: "available",
              asOf,
              horizonDays: 20,
              observingCount: account === "B" ? 0 : 1,
              decisions: account === "B" ? isa(context) : decisions(context),
            },
            risk: { A: { twr: 0.084 }, B: { twr: -0.012 } },
          },
        });
        if (held) finishRouteB();
      } catch (error) {
        if (held) finishRouteB(error);
        throw error;
      }
    });
    const scope = page.getByRole("group", { name: "复盘范围" });
    const lead = page.getByRole("region", { name: "复盘结论" });
    const verdict = (label: string) => lead.locator(".mx-metric").filter({ hasText: label }).locator(".mx-number-value");
    const delayB = () => {
      holdB = true;
      ({ promise: heldB, resolve: releaseB } = Promise.withResolvers<void>());
      ({ promise: routeB, resolve: finishRouteB } = Promise.withResolvers<unknown>());
    };
    const releaseAndVerifyB = async () => {
      holdB = false;
      releaseB();
      const routeError = await routeB;
      if (routeError) throw routeError;
    };
    const settled = (request: Request) => new Promise<void>((resolve) => {
      const done = (req: Request) => {
        if (req !== request) return;
        page.off("requestfinished", done);
        page.off("requestfailed", done);
        resolve();
      };
      page.on("requestfinished", done);
      page.on("requestfailed", done);
    });

    try {
      await page.goto("/review?account=A");
      await expect(scope.getByRole("button", { name: "Invest" })).toHaveAttribute("aria-pressed", "true");
      await expect(verdict("买入后")).toHaveText("赚 £60");
      await expect(lead.locator(".mx-review-money")).toContainText("£2,000.00");
      await expect(page.getByText("£3,500.00")).toHaveCount(0);

      // A → B while B is delayed: Invest's figures leave and Stocks ISA shows its loading state.
      delayB();
      const requestedB = page.waitForRequest((req) =>
        req.url().includes("/dashboard/lens/account-analysis") && new URL(req.url()).searchParams.get("account") === "B");
      await scope.getByRole("button", { name: "Stocks ISA" }).click();
      const settledB = settled(await requestedB);
      await expect(scope.getByRole("button", { name: "Stocks ISA" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("status").filter({ hasText: /正在读取 Stocks\sISA 复盘…/ })).toBeVisible();
      await expect(page.locator(".mx-loading-message")).toHaveText(/正在读取 Stocks\sISA 复盘…/);
      await expect(page.locator(".mx-loading-message")).toBeVisible();
      await expect(lead).toHaveCount(0);
      await expect(page.getByText("£2,000.00")).toHaveCount(0);
      await expect(page.getByText("赚 £60")).toHaveCount(0);

      // B resolves with Stocks ISA's figures, then B → A restores Invest's figures.
      await releaseAndVerifyB();
      await settledB;
      await expect(verdict("买入后")).toHaveText("赚 £90");
      await expect(lead.locator(".mx-review-money")).toContainText("£3,500.00");
      await expect(page.getByText("£2,000.00")).toHaveCount(0);
      await expect(page.getByText("赚 £60")).toHaveCount(0);

      await scope.getByRole("button", { name: "Invest" }).click();
      await expect(scope.getByRole("button", { name: "Invest" })).toHaveAttribute("aria-pressed", "true");
      await expect(verdict("买入后")).toHaveText("赚 £60");
      await expect(lead.locator(".mx-review-money")).toContainText("£2,000.00");
      await expect(page.getByText("£3,500.00")).toHaveCount(0);

      // Fresh cache: A → B (delayed) → A mid-flight keeps Invest's figures even once the late B response resolves.
      // The snapshot cache persists in localStorage, so clear it once before the next document loads.
      await page.addInitScript((key) => {
        if (sessionStorage.getItem("fresh-review-cache")) return;
        localStorage.removeItem(key);
        sessionStorage.setItem("fresh-review-cache", "1");
      }, "trading_max-snapshot-cache");
      await page.goto("/review?account=A");
      await expect(verdict("买入后")).toHaveText("赚 £60");
      await expect(lead.locator(".mx-review-money")).toContainText("£2,000.00");
      delayB();
      const requestedMidFlightB = page.waitForRequest((req) =>
        req.url().includes("/dashboard/lens/account-analysis") && new URL(req.url()).searchParams.get("account") === "B");
      await scope.getByRole("button", { name: "Stocks ISA" }).click();
      const settledMidFlightB = settled(await requestedMidFlightB);
      await expect(page.getByRole("status").filter({ hasText: /正在读取 Stocks\sISA 复盘…/ })).toBeVisible();
      await expect(page.locator(".mx-loading-message")).toBeVisible();
      await expect(lead).toHaveCount(0);

      await scope.getByRole("button", { name: "Invest" }).click();
      await expect(scope.getByRole("button", { name: "Invest" })).toHaveAttribute("aria-pressed", "true");
      await expect(verdict("买入后")).toHaveText("赚 £60");
      await expect(lead.locator(".mx-review-money")).toContainText("£2,000.00");
      await releaseAndVerifyB();
      await settledMidFlightB;
      await expect(verdict("买入后")).toHaveText("赚 £60");
      await expect(lead.locator(".mx-review-money")).toContainText("£2,000.00");
      await expect(page.getByText("£3,500.00")).toHaveCount(0);
    } finally {
      holdB = false;
      releaseB();
    }
  });
});

test("the recent record shows what fills moved, what was left alone and each account's coverage", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  await serve(page, () => ({ benchmark: 0.02, events: false, observations: true }));
  await page.goto("/review");
  // The decisions lead, then the ones that mattered most, then the record.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["每笔决定 20 个交易日后的结果", "帮你最多", "代价最大", "最近"]);
  const journal = page.locator(".mx-review-journal-panel");
  await expect(journal).toContainText("覆盖不全");
  await expect(journal.locator(".mx-review-journal").first().locator(":scope > li")).toHaveCount(6);
  // A day whose fills moved the account's shares by a point or more says how far: the two largest moves.
  const buy = entry(page, "2026-10-20");
  await expect(buy.getByRole("link", { name: "买入 SYNE" })).toBeVisible();
  await expect(buy.locator(".mx-journal-shift")).toContainText("美元敞口 31.0% → 34.0%");
  await expect(buy.locator(".mx-journal-shift")).toContainText("现金 24.0% → 21.0%");
  await expect(buy.locator(".mx-journal-shift")).not.toContainText("最大持仓");
  await expect(entry(page, "2026-10-14").locator(".mx-journal-shift")).toHaveCount(0);
  // What moved with nothing done, a weight that drifted and cash that sat, each in its account.
  const quiet = entry(page, "2026-10-16");
  const moved = quiet.filter({ hasText: "没操作" });
  await expect(moved.getByRole("link", { name: "SYNB -6.8%" })).toHaveAttribute("href", "/research?ticker=SYNB&view=technical");
  await expect(quiet.filter({ hasText: "占比漂移 SYNB" })).toContainText("20.0% → 26.0%");
  await expect(quiet.filter({ hasText: "现金偏多" })).toContainText("高点 24.0%");
  await expect(quiet.filter({ hasText: "现金偏多" })).toContainText("13 个交易日 · Invest");
  await expect(moved).toContainText("Invest");
  await page.getByRole("button", { name: "最近的记录说明" }).click();
  await expect(page.getByText(/2\.75 倍/)).toBeVisible();
  await expect(page.getByText(/连续至少 10 个交易日达到 12%/)).toBeVisible();
  await expect(page.getByText(/最近 90 天，每个账户最多 8 笔成交/)).toBeVisible();
  await page.keyboard.press("Escape");
  // The rest of the record opens in place.
  await expect(entry(page, "2026-09-01")).toBeHidden();
  await journal.locator("summary").filter({ hasText: "更多记录" }).click();
  await expect(entry(page, "2026-09-01").getByRole("link", { name: "卖出 SYNA" })).toBeVisible();

  await page.goto("/review?account=B");
  await expect(page.locator(".mx-review-journal-panel")).toContainText("覆盖不全");
  await expect(page.locator(".mx-review-journal-panel")).toContainText("最近没有买卖或需要留意的变化");
  await expect(page.locator("li.mx-journal-item")).toHaveCount(0);
});

test("decisions sharing a day stay points of their own, read one at a time", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  // Synthetic Beta and four more buys share 2 September.
  await serve(page, () => ({ benchmark: 0.021, events: true, cluster: true }));
  const reviews: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).searchParams.get("lens") === "decision_review") reviews.push(request.url());
  });
  await page.goto("/review?account=A");
  const timeline = page.locator(".mx-decision-review");
  const chart = timeline.getByRole("group", { name: "买卖决定的时间线" });
  // The keys open readings once the chart has drawn.
  await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
  // The chart alone carries the day: no note or list of days beneath it.
  await expect(timeline).not.toContainText("同日多笔");
  await expect(page.getByRole("group", { name: "同日决定" })).toHaveCount(0);
  const card = timeline.locator(".mx-reading-tooltip");
  const spoken = timeline.locator("[aria-live]:not([role])");
  await chart.press("Home");
  await expect(spoken).toHaveText(/SYNA 卖出 £500/);
  for (const [ticker, amount] of [["SYNB", "£800"], ["SYNC1", "£100"], ["SYNC2", "£200"], ["SYNC3", "£300"], ["SYNC4", "£400"]]) {
    await chart.press("ArrowRight");
    await expect(spoken).toHaveText(new RegExp(ticker + " 买入 " + amount));
    await expect(card).toBeVisible();
    await expect(card).toContainText(ticker + " 买入 " + amount);
  }
  // Readings render through the React ReadingCard overlay rather than an ECharts HTML tooltip sink.
  await expect(timeline.locator(".mx-reading-tooltip > .mx-reading")).toHaveCount(1);
  await chart.press("Home");
  await chart.press("ArrowRight");
  const row = card.locator(".mx-reading-row").first();
  await expect(row).toBeVisible();
  const columns = await row.evaluate((element) => {
    const [label, value] = element.children;
    const range = document.createRange();
    range.selectNodeContents(label);
    return { label: label.getBoundingClientRect().width, naturalLabel: range.getBoundingClientRect().width,
      value: value.getBoundingClientRect().width, row: element.getBoundingClientRect().width,
      gap: Number.parseFloat(getComputedStyle(element).columnGap) };
  });
  expect(columns.label).toBeCloseTo(columns.naturalLabel, 0);
  expect(columns.label + columns.value + columns.gap).toBeCloseTo(columns.row, 0);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  const exact = timeline.getByRole("button", { name: "查看精确读数" });
  await expect(timeline.locator(".mx-panel-heading").getByRole("button", { name: "查看精确读数" })).toHaveCSS("position", "absolute");
  const height = () => timeline.evaluate((panel) => panel.getBoundingClientRect().height);
  const closedHeight = await height();
  await exact.press("Space");
  await expect(timeline.getByRole("table")).toBeVisible();
  expect(await height()).toBeGreaterThan(closedHeight);
  await exact.press("Enter");
  await expect(timeline.getByRole("table")).toBeHidden();
  await expect.poll(height).toBe(closedHeight);
  // The review no longer asks for an AI review.
  expect(reviews).toEqual([]);
});

test("the closed records disclosure preserves phone heading and plot geometry in English", async ({ page, isMobile }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL || !isMobile, "Requires the phone project and a local preview.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await serve(page, () => ({ benchmark: 0.021, events: true, cluster: true }));
  await page.goto("/review?account=A");
  const timeline = page.locator(".mx-decision-review");
  await expect(timeline.locator("[data-tm-chart-ready]")).toBeVisible();
  const records = timeline.getByRole("button", { name: "View exact values" });
  await expect(records).toHaveAttribute("aria-expanded", "false");
  const layout = await records.evaluate((button) => {
    const heading = button.parentElement!;
    const plot = heading.parentElement!.querySelector(".mx-plot")!;
    const help = heading.querySelector(".mx-panel-title button")!;
    const height = () => ({
      heading: heading.getBoundingClientRect().height,
      plot: plot.getBoundingClientRect().top,
      page: document.documentElement.scrollHeight,
    });
    const withRecords = height();
    const targetGap = button.getBoundingClientRect().left - help.getBoundingClientRect().right;
    button.removeAttribute("data-chart-records-heading");
    const withoutRecords = height();
    button.setAttribute("data-chart-records-heading", "true");
    return { withRecords, withoutRecords, targetGap };
  });
  expect(layout.withRecords).toEqual(layout.withoutRecords);
  expect(layout.targetGap).toBeGreaterThanOrEqual(0);
  await tapRecordsBottom(records);
  await expect(timeline.getByRole("table")).toBeVisible();
});

test("CFD without history offers prerequisites and the import screen", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await serve(page, () => ({ benchmark: 0, events: false, empty: true }));
  await page.goto("/review?account=C");
  await expect(page.getByText(/CFD 已平仓交易及费用|Closed CFD trades and fees/)).toBeVisible();
  await expect(page.getByText(/入金、出金与转账|Deposits, withdrawals and transfers/)).toBeVisible();
  await page.getByRole("button", { name: /导入 CFD 历史|Import CFD history/ }).click();
  await expect(page).toHaveURL(/reviewView=imports/);
  await expect(page.getByRole("tab", { name: "导入记录" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "CFD 历史账本", level: 2 })).toBeVisible();
});

for (const [count, reason, copy] of [
  [0, "no reliably reconstructed closed campaigns are available", "Complete opening and closing records are needed"],
  [3, "missing FX for closed campaigns", "Some transactions lack reliable historical exchange rates"],
] as const) {
  test(`unavailable attribution and trade quality retain the reason and count ${count}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await serve(page, () => ({ benchmark: 0.03, events: true, tradeCoverage: { count, reason } }));
    await page.goto("/review?account=A&reviewView=attribution");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("heading", { name: "Realised P&L attribution · GBP" })).toBeVisible();
    await expect(panel.getByText(copy, { exact: false })).toHaveCount(1);
    await expect(panel.getByText("Closed trades", { exact: true })).toHaveCount(1);
    await expect(panel.locator("dd").first()).toHaveText(String(count));
    await expect(panel.getByRole("combobox", { name: "Attribution dimension" })).toHaveCount(0);
    await expect(panel.getByRole("table")).toHaveCount(0);
    await panel.getByText("Diagnostic details", { exact: true }).click();
    await expect(panel.getByText(reason, { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Trade quality" }).click();
    await expect(panel.getByRole("heading", { name: "Understand the trading process" })).toBeVisible();
    await expect(panel.getByText(copy, { exact: false })).toHaveCount(1);
    await expect(panel.getByRole("heading", { name: "Distribution and tail risk" })).toHaveCount(0);
  });
}

test("CFD keeps verified durations, help and counts when FX evidence is missing", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await serve(page, () => ({ benchmark: 0.03, events: true, cfdMissingFx: true }));
  await page.goto("/review?account=C&reviewView=quality");
  const panel = page.getByRole("tabpanel");
  const quality = panel.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: "Understand the trading process" }) });
  await expect(quality.getByText(/Some transactions lack reliable historical exchange rates/)).toHaveCount(1);
  for (const [label, value] of [["Closed trades", "4"], ["Closed on the same day", "3"], ["Closed within one hour", "2"], ["Median holding duration", "1.5 hours"]]) {
    await expect(quality.locator("dt").filter({ hasText: label }).locator("..").locator("dd")).toHaveText(value);
  }
  await quality.getByRole("button", { name: /Understand the trading process explained/ }).click();
  await expect(page.getByText("Examine closed-trade distributions without inferring investment motives.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await quality.getByText("Diagnostic details", { exact: true }).click();
  await expect(quality.getByText("fx_unavailable", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Attribution" }).click();
  await expect(panel.locator("dt").filter({ hasText: "Closed trades" }).locator("..").locator("dd")).toHaveText("4");
  await expect(panel.getByRole("combobox", { name: "Attribution dimension" })).toHaveCount(0);
});

test.describe("review assistant", () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"),
    "Requires an isolated local build.",
  );
  for (const locale of ["zh", "en"])
    for (const theme of ["light", "dark"] as const) {
      test("habit filters and decision handoff " + locale + " " + theme, async ({ page }, info) => {
        const mobile = info.project.name === "mobile";
        const zh = locale === "zh";
        if (mobile) await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript((scheme) => localStorage.setItem("mantine-color-scheme-value", scheme), theme);
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((lang) => localStorage.setItem("trading_max-locale", lang), locale);
        await serve(page, () => ({ benchmark: 0.03, events: true, isa: true, observations: true }));
        await page.route("**/api/backend/assistant/status", (route) =>
          route.fulfill({ json: { ready: true } }),
        );
        await page.route("**/api/backend/assistant/roles/*/reading", (route) => {
          const body = route.request().postDataJSON();
          const digest = route.request().url().includes("/habits/");
          const tool = digest ? "review_patterns" : "decision_timing_and_habits";
          const lines = (
            digest
              ? [
                  [
                    "before_earnings",
                    "财报前一周买入 1 次，合计 £60。",
                    "One buy before earnings gained £60.",
                  ],
                  [
                    "untraded_fall",
                    "持仓大跌当天没加仓 1 次。事后看，假设加仓的净收益约 £14。",
                    "One untraded fall. In hindsight, the net hypothetical gain was about £14.",
                  ],
                  ["basket_buy", "同一天买入多只 2 次，合计 £80。", "Two same-day basket buys gained £80."],
                ]
              : [
                  [
                    "outcome",
                    "每股成交 £40。至今回报 +10.0%，同期标普 500 +3.0%。",
                    "The trade averaged £40 per share. Return to date was +10.0%, versus +3.0% for the S&P 500.",
                  ],
                  [
                    "hindsight",
                    "事后看，最佳买入收盘日为 9 月 3 日。按平均买单，差额约 £12。",
                    "In hindsight, the best closing buy was on 3 September. At the average purchase size, the gap was about £12.",
                  ],
                ]
          ).map(([section, zh, en]) => {
            const evidence = {
              source: "review",
              tool,
              evidenceId: "ev_synthetic",
              arguments: {
                ...(digest ? { habit: section } : {}),
                snapshotId: body.snapshotId,
                scope: digest ? "broker_total" : "invest",
                horizon: digest ? "20_sessions" : "to_date",
                ticker: digest ? "" : "SYNB",
                side: "buy",
                decision_date: "2026-09-02",
              },
            };
            return {
              section,
              zh,
              en,
              evidence,
              variants: digest
                ? { to_date: { zh: zh.replace("£60", "£70"), en: en.replace("£60", "£70"), evidence } }
                : {},
            };
          });
          expect(body.snapshotId).toBe("synthetic-decision-context");
          if (!digest) {
            expect(body.context).toMatchObject({
              page_scope: "broker_total",
              scope: "invest",
              habit: "before_earnings",
              horizon: "to_date",
              ticker: "SYNB",
            });
          }
          const event =
            !digest && body.cachedOnly
              ? { type: "empty" }
              : {
                  type: "result",
                  reading: {
                    role: digest ? "habits" : "decision",
                    version: "synthetic",
                    snapshotId: body.snapshotId,
                    asOf,
                    lines,
                  },
                };
          return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(event) + "\n" });
        });
        await page.route("**/api/logos/**", (route) => route.abort());
        await page.goto("/review");
        await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", theme);
        const openHabits = () =>
          (mobile ? page.locator(".mx-phone-habits") : page.locator(".mx-digest-toggle")).click();
        await openHabits();
        const sourceName = zh ? "复盘" : "Review";
        const expectedHabits = zh ? ["财报前一周买入", "持仓大跌当天没加仓", "同一天买入多只"]
          : ["Buys before earnings", "Large falls without a trade", "Same-day basket buys"];
        const habitSources = page.locator(".mx-habit-line .mx-reading-source");
        await expect(habitSources).toHaveCount(expectedHabits.length);
        for (const [index, habit] of expectedHabits.entries()) {
          await expect(habitSources.nth(index)).toHaveAccessibleName(new RegExp("^" + sourceName + ".*" + habit), {timeout:3000});
        }
        const chooseHabit = page.locator(".mx-habit-line > button[aria-pressed]").first();
        await expect(chooseHabit).toContainText("£60");
        const shots = process.env.REVIEW_SCREENSHOTS;
        async function capture(name: string) {
          if (shots)
            await page.screenshot({
              path: join(shots, [info.project.name, locale, theme, name].join("-") + ".png"),
            });
        }
        await capture("habits");
        if (mobile) {
          await (await previewCitation(page, page.locator(".mx-habit-line .mx-reading-source").first())).click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.locator(".mx-review-filter")).toBeFocused();
          await expect(page.locator(".mx-review-filter")).toBeInViewport({ ratio: 1 });
          await capture("habit-citation");
        } else await chooseHabit.click();
        const filtered = page.locator(".mx-review-filter");
        await expect(filtered).toBeVisible();
        await expect(page.locator(".mx-review-expand-head > button")).toHaveCount(1);
        await expect(page.locator(".mx-journal-item")).toHaveCount(1);
        await page.getByRole("button", { name: zh ? "至今" : "To date", exact: true }).click();
        if (mobile) await openHabits();
        await expect(chooseHabit).toContainText("£70");
        if (mobile) {
          await page.getByRole("button", { name: zh ? "关闭解读" : "Close reading" }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
        const row = page.locator(".mx-review-expand-head > button").first();
        if (mobile) await row.tap();
        else await row.press("Enter");
        const reading = mobile ? page.getByRole("dialog") : page.locator(".mx-inline-reading");
        await expect(reading.locator(".mx-reading-line")).toHaveCount(2);
        await expect(await previewCitation(page, reading.locator(".mx-reading-source").last())).toHaveAttribute(
          "href",
          /decision=2026-09-02.buy.SYNB/,
        );
        await page.keyboard.press("Escape");
        if (!mobile)
          await reading.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
        await captureCitation(page, reading.locator("button.mx-reading-source").last(), ["review",info.project.name,locale,theme].join("-"));
        await capture("decision");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(
          (
            await new AxeBuilder({ page })
              .include(mobile ? '[role="dialog"]' : ".mx-inline-reading")
              .analyze()
          ).violations,
        ).toEqual([]);
        const question = reading.locator(".mx-reading-actions button").first();
        const wording = await question.innerText();
        await question.click();
        const composer = page.locator("#mx-assistant-panel textarea");
        await expect(composer).toHaveValue(wording);
        const sent = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/assistant/chat"));
        await composer.press("Enter");
        expect((await sent).postDataJSON().context).toMatchObject({
          page: "review",
          scope: "invest",
          role: "decision",
          snapshotId: "synthetic-decision-context",
          object: {
            ticker: "SYNB",
            decision_date: "2026-09-02",
            horizon: "to_date",
            habit: "before_earnings",
            page_scope: "broker_total",
          },
        });
      });
    }
  test("opens the selected sale inside the cost ranking", async ({ page }, info) => {
    await serve(page, () => ({ benchmark: 0.03, events: true, isa: true, observations: true }));
    await page.route("**/api/backend/assistant/status", (route) => route.fulfill({ json: { ready: true } }));
    await page.route("**/api/backend/assistant/roles/*/reading", (route) => {
      const request = route.request().postDataJSON();
      const evidence = {
        evidenceId: "ev_synthetic",
        tool: "decision_timing_and_habits",
        source: "review",
        arguments: request.context,
      };
      const event = request.cachedOnly
        ? { type: "empty" }
        : {
            type: "result",
            reading: {
              role: "decision",
              snapshotId: request.snapshotId,
              version: request.snapshotId,
              asOf,
              lines: [
                {
                  section: "outcome",
                  zh: "卖出后 20 个交易日上涨 10%，同期标普 500 上涨 3%。",
                  en: "The security rose 10% in the 20 trading days after the sale. The S&P 500 rose 3%.",
                  evidence,
                },
                {
                  section: "hindsight",
                  zh: "事后对照：同一窗口的最佳收盘日资料不足。",
                  en: "Hindsight comparison: the best close in the same window is unavailable.",
                  evidence,
                },
              ],
            },
          };
      return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(event) + "\n" });
    });
    await page.goto("/review");
    const row = panel(page, "代价最大").getByRole("button", { name: /SYNK/ });
    const request = page.waitForRequest((r) => r.url().includes("/roles/decision/reading"));
    await row.click();
    expect((await request).postDataJSON().context).toMatchObject({
      scope: "isa",
      page_scope: "broker_total",
      horizon: "20_sessions",
      side: "sell",
      ticker: "SYNK",
    });
    const reading =
      info.project.name === "mobile" ? page.getByRole("dialog") : page.locator(".mx-inline-reading");
    await expect(reading.locator(".mx-reading-line")).toHaveCount(2);
    if (info.project.name === "desktop" && process.env.REVIEW_SCREENSHOTS) {
      await row.evaluate((el) =>
        el.closest(".mx-review-extremes")?.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      await page.screenshot({ path: join(process.env.REVIEW_SCREENSHOTS, "desktop-zh-unfiltered-sale.png") });
    }
  });
  test("untraded fall filters the rankings and journal at the selected horizon", async ({ page }) => {
    await serve(page, () => ({ benchmark: 0.02, events: true, isa: true, observations: true }));
    await page.route("**/api/backend/assistant/status", (route) => route.fulfill({ json: { ready: true } }));
    await page.goto("/review?habit=untraded_fall");
    const missed = panel(page, "事后错过的收益");
    const avoided = panel(page, "事后避开的亏损");
    await expect(missed).toContainText("£14");
    await expect(page.locator(".mx-journal-item")).toHaveCount(1);
    await expect(page.locator(".mx-journal-item")).toContainText("没操作");
    await page.getByRole("button", { name: "至今", exact: true }).click();
    await expect(avoided).toContainText("£9");
    await expect(missed).toContainText("暂无匹配记录");
    await page.locator(".mx-review-filter").click();
    await expect(panel(page, "帮你最多")).toBeVisible();
  });

  test("each grouped recent purchase opens its own reading and failure preserves the record", async ({
    page,
  }) => {
    await serve(page, () => ({ benchmark: 0.02, events: true, cluster: true }));
    await page.route("**/api/backend/assistant/status", (route) => route.fulfill({ json: { ready: true } }));
    await page.route("**/api/backend/assistant/roles/*/reading", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: '{"type":"error","code":"assistant_unavailable"}\n',
      }),
    );
    await page.goto("/review?account=A");
    const group = entry(page, "2026-09-02");
    const chip = group.getByRole("button", { name: /SYNC2/ });
    const payload = page.waitForRequest((r) => r.url().includes("/roles/decision/reading"));
    await chip.click();
    expect((await payload).postDataJSON().context).toMatchObject({
      ticker: "SYNC2",
      scope: "invest",
      decision_date: "2026-09-02",
    });
    await expect(page.getByText("暂时无法读取。", { exact: true }).last()).toBeVisible();
    const reading = page.getByRole("dialog");
    if (await reading.isVisible()) await reading.getByRole("button", { name: /关闭解读|Close reading/ }).click();
    await expect(group.getByRole("button", { name: /SYNC3/ })).toBeAttached();
  });

  test("off preserves decision links and sends no role requests", async ({ page }) => {
    await serve(page, () => ({ benchmark: 0.02, events: true, isa: true, observations: true }));
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/assistant/roles/")) requests.push(r.url());
    });
    await page.goto("/review?habit=before_earnings");
    await expect(page.locator(".mx-review-line").first()).toBeVisible();
    await expect(page.locator(".mx-review-line").first()).toHaveAttribute("href", /decision=/);
    await expect(page.locator(".mx-review-filter,.mx-digest,.mx-habit-list")).toHaveCount(0);
    expect(requests).toEqual([]);
  });
});

for (const expanded of [false, true]) {
  test(`the timeline stays in place while status and the ${expanded ? "expanded" : "collapsed"} habits brief resolve`, async ({ page }) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
    await serve(page, () => ({ benchmark: 0.03, events: true, habitsConsented: true }));
    if (expanded) await page.addInitScript(() => localStorage.setItem("tm-reading-review-habits", "open"));
    const { promise: status, resolve: consent } = Promise.withResolvers<void>();
    const { promise: publication, resolve: publish } = Promise.withResolvers<void>();
    await page.route("**/api/backend/assistant/status", async route => {
      await status;
      await route.fulfill({ json: { ready: true } });
    });
    await page.route("**/api/backend/assistant/roles/habits/reading", async route => {
      await publication;
      const line = { section: "basket_buy", zh: "同一天买入多只", en: "Same-day basket buys",
        evidence: { tool: "review_patterns", source: "review", evidenceId: "ev_brief", arguments: {habit: "basket_buy"} } };
      await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({
        type: "result", reading: { role: "habits", asOf, lines: [line] },
      }) + "\n" });
    });
    await page.goto("/review");
    await expect(page.locator(".mx-review-lead")).toBeVisible();
    const timeline = page.getByRole("heading", { name: /每笔决定/ }).first();
    await expect(timeline).toBeVisible();
    await expect(page.locator(".mx-digest")).toHaveCount(0);
    const top = (await timeline.boundingBox())!.y;
    consent();
    await expect(page.locator(".mx-digest")).toBeVisible();
    expect(Math.abs((await timeline.boundingBox())!.y - top)).toBeLessThan(2);
    publish();
    const displayedLine = expanded && page.viewportSize()!.width >= 768
      ? page.locator(".mx-habit-line > button[aria-pressed]") : page.locator(".mx-digest-summary");
    await expect(displayedLine).toHaveText("同一天买入多只");
    expect(Math.abs((await timeline.boundingBox())!.y - top)).toBeLessThan(2);
  });
}

test("the ranked arrow and reading fallback lead to the selected twin", async ({page},info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, () => ({benchmark:0.02,events:false,twin:true}));
  await page.route("**/api/backend/assistant/status",route=>route.fulfill({json:{ready:true}}));
  await page.route("**/api/backend/assistant/roles/*/reading",route=>route.fulfill({contentType:"application/x-ndjson",body:'{"type":"error","code":"assistant_unavailable"}\n'}));
  await page.goto("/review?account=A&reviewWindow=to_date");
  const row = panel(page,"代价最大").locator(".mx-review-expand-head").filter({hasText:"SYND.AS"});
  await expect(row.getByRole("link")).toHaveAttribute("href",/reviewOrdinal=1/);
  await row.getByRole("button").click();
  const fallback = (info.project.name === "mobile" ? page.getByRole("dialog") : page.locator(".mx-inline-reading")).getByRole("link",{name:/查看这笔决定/});
  await expect(fallback).toHaveAttribute("href",/reviewOrdinal=1/);
  await expect(fallback).toHaveAttribute("href", /snapshotId=synthetic-decision-context/);
  const originalSnapshot = page.waitForRequest(r => r.url().includes("/dashboard/lens/account-analysis") &&
    new URL(r.url()).searchParams.get("runId") === "synthetic-decision-context");
  await fallback.click();
  await originalSnapshot;
  await expect(page.locator(".mx-decision-focus")).toContainText("£120");
  await expect(page.locator(".mx-decision-focus").getByRole("link").first()).toBeFocused();
  if (process.env.REVIEW_SCREENSHOTS) {
    await page.screenshot({path: join(process.env.REVIEW_SCREENSHOTS, info.project.name + "-zh-selected-twin.png")});
  }
  await page.goBack();
  await row.getByRole("link").click();
  await expect(page.locator(".mx-decision-focus")).toContainText("£120");
  await row.getByRole("button").click();
  const reading = info.project.name === "mobile" ? page.getByRole("dialog") : page.locator(".mx-inline-reading");
  await reading.locator(".mx-reading-actions button").first().click();
  const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await page.locator("#mx-assistant-panel textarea").press("Enter");
  expect((await sent).postDataJSON().context).toMatchObject({scope:"invest", object:{ordinal:1, ticker:"SYND.AS"}});
});

test("an expired decision citation withholds the cached account review", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  await serve(page, () => ({ benchmark: 0.02, events: false, twin: true }));
  const account = "**/api/backend/dashboard/lens/account-analysis?**";
  const cited = "synthetic-decision-context";
  let expired = false;
  await page.route(account, route => {
    if (expired && new URL(route.request().url()).searchParams.get("runId") === cited) {
      return route.fulfill({ status: 404, json: { detail: "snapshot not found" } });
    }
    return route.fallback();
  });
  await page.goto("/review?account=A&decision=2026-10-14.sell.SYND.AS&reviewOrdinal=1&snapshotId=" + cited);
  const selection = page.locator(".mx-decision-focus");
  await expect(selection).toContainText("£120");
  expired = true;
  const missing = page.waitForResponse(r => r.status() === 404 && r.url().includes("runId=" + cited));
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await missing;
  await expect(page.getByText("引用的数据版本暂不可用", {exact:true})).toBeVisible();
  await expect(selection).toHaveCount(0);
});

test("a phone citation focuses a newly loaded fall timeline", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile" || !process.env.PLAYWRIGHT_BASE_URL, "Requires a phone and isolated build.");
  await serve(page, () => ({ benchmark: 0.02, events: false, observations: true }));
  await page.route("**/api/backend/assistant/status", route => route.fulfill({ json: { ready: true } }));
  await page.route("**/api/backend/assistant/roles/habits/reading", route => {
    const {snapshotId} = route.request().postDataJSON();
    const line = {section: "untraded_fall", zh: "持仓大跌当天没加仓", en: "Large falls without a trade",
      evidence: {tool: "review_patterns", source: "review", evidenceId: "ev_falls",
        arguments: {habitSection: "untraded_fall", snapshotId}}};
    return route.fulfill({contentType: "application/x-ndjson", body: JSON.stringify({
      type: "result", reading: {role: "habits", asOf, lines: [line]},
    }) + "\n"});
  });
  await page.goto("/review");
  await page.locator(".mx-phone-habits").click();
  await (await previewCitation(page, page.getByRole("dialog").getByRole("button", {name:/^复盘 /}))).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".mx-review-filter")).toBeFocused();
  await expect(page.locator(".mx-review-filter")).toBeInViewport({ratio: 1});
  await expect(panel(page, "事后错过的收益")).toContainText("£14");
});

test("basket review includes unpriced purchases and discloses their missing outcome", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  await serve(page, () => ({ benchmark: 0.02, events: false, unpricedBasket: true }));
  await page.route("**/api/backend/assistant/status", route => route.fulfill({json:{ready:true}}));
  await page.goto("/review?account=A&habit=basket_buy");
  const purchase = page.locator(".mx-journal-chips button").filter({hasText:"UNPRICED"});
  await expect(purchase).toContainText("行情缺失，未计入");
  await expect(purchase).toContainText("£140");
  await page.locator(".mx-review-filter").click();
  await expect(purchase).toHaveCount(0);
});

test("earnings and rating source words open their own research sections", async ({ page }, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, () => ({ benchmark: 0.03, events: true }));
  await page.route("**/api/backend/assistant/status", route => route.fulfill({json:{ready:true}}));
  await page.route("**/api/backend/research/**", route => {
    const url = new URL(route.request().url());
    let data = backendFixture(url);
    if (url.pathname.endsWith("/lens/analyst")) {
      url.pathname = url.pathname.replace(/analyst$/, "overview");
      data = { ...Object(backendFixture(url)), view: "analyst", analyst: {
        earningsEvents: [{ id: "synthetic-results", date: "2026-11-16", status: "reported",
          instant: "2026-11-16T12:00:00Z", timezone: "Europe/London" }],
        upgradesDowngrades: [{ GradeDate: "2026-08-31", Firm: "Synthetic Research", FromGrade: "Buy", ToGrade: "Hold", Action: "down" }],
      } };
    }
    return route.fulfill({json: data ?? {}});
  });
  await page.route("**/api/backend/assistant/roles/decision/reading", route => {
    const lines = [["财报", "financials", "events"], ["评级", "analysts", "actions"], ["消息", "publisher", ""]]
      .map(([zh, source, section]) => ({ section: section || "headline", zh, en: zh,
        evidence: { tool: "decision_timing_and_habits", evidenceId: "ev_selected", source,
          publisher: source === "publisher" ? "Synthetic Wire" : undefined,
          arguments: {scope:"invest", ticker:"SYNB", listing:"SYNT", lens:"analyst", analystView:section, snapshotId:"older-publication", date:"2026-08-28", calendarEventId:section === "events" ? "ev_0000000000000001" : "ev_0000000000000002",
            ...(source === "publisher" ? {url:"https://example.org/synthetic"} : {})} }}));
    return route.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({
      type:"result",reading:{role:"decision",asOf,lines},
    }) + "\n"});
  });
  let expired = false;
  await page.route("**/api/backend/publications/older-publication/events/upcoming?**", r => {
    const items = ["earnings","rating_change"].map((kind, i) => ({kind, ticker:"SYNT", date:"2026-08-28",
      local_date:"2026-08-28", snapshot_id:"older-publication", evidence_id:i ? "ev_0000000000000002" : "ev_0000000000000001", title_zh:i ? "评级变动" : "已公布",
      title_en:i ? "Rating change" : "Reported earnings", publisher:"Synthetic archive", firm:i ? "Synthetic Research" : undefined,
      to_grade:i ? "Hold" : undefined, actual_eps:i ? undefined : 1.75, currency:"USD"}));
    const query = new URL(r.request().url()).searchParams;
    const row = items.find(item => item.evidence_id === query.get("eventId") &&
      item.ticker === query.get("ticker") && item.kind === query.get("kind"));
    return r.fulfill({status: expired || !row ? 404 : 200,json: expired ? {} : row});
  });
  for (const [word, section, heading] of [["财报", "events", "财报事件"], ["分析师", "actions", "机构行动"]]) {
    await page.goto("/review?account=A");
    await panel(page, "帮你最多").getByRole("button", {name:/SYNB/}).click();
    await expect(await previewCitation(page, page.getByRole("button", {name:/^Synthetic Wire /}))).toHaveAttribute("href", "https://example.org/synthetic");
    await page.keyboard.press("Escape");
    await (await previewCitation(page, page.getByRole("button", {name:new RegExp("^" + word + " ")}))).click();
    await expect(page).toHaveURL(new RegExp("ticker=SYNT.*analystView=" + section + ".*#research-" + section));
    await expect(page).toHaveURL(/snapshotId=older-publication/);
    await expect(page).toHaveURL(/calendarEventId=ev_000000000000000/);
    const anchor = page.locator("#research-" + section);
    await expect(anchor).toHaveAttribute("data-assistant-evidence", "");
    await expect(anchor.getByRole("heading", {name:heading, exact:true})).toBeFocused();
    await expect(anchor.getByRole("heading", {name:heading, exact:true})).toBeInViewport({ratio:1});
    await expect(anchor).toContainText(section === "events" ? "已公布" : "Synthetic Research");
    await expect(anchor).toContainText("2026-08-28");
    if (section === "events") await expect(anchor).toContainText("1.75 USD");
    await expect(anchor).not.toContainText("2026-11-16");
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (process.env.REVIEW_SCREENSHOTS) {
      await page.screenshot({path: join(process.env.REVIEW_SCREENSHOTS, info.project.name + "-zh-" + section + "-citation.png")});
    }
    expired = true;
    const missing = page.waitForResponse(r => r.url().includes("/publications/older-publication/events/upcoming?") && r.status() === 404);
    await page.reload();
    await missing;
    await expect(page.getByText("引用的数据版本或事件暂不可用", {exact:true})).toBeVisible();
    if (process.env.REVIEW_SCREENSHOTS && section === "events") await page.screenshot({path:join(process.env.REVIEW_SCREENSHOTS, info.project.name+"-zh-expired-review-event.png")});
    expired = false;
  }
});

test("clearing a habit by keyboard focuses the restored timeline heading", async ({page}) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  await serve(page, () => ({ benchmark:0.03, events:true, observations:true }));
  await page.route("**/api/backend/assistant/status", r => r.fulfill({json:{ready:true}}));
  await page.goto("/review?habit=untraded_fall");
  await page.locator(".mx-review-filter").press("Enter");
  await expect(page.locator(".mx-decision-review h2").first()).toBeFocused();
});

for (const scope of ["all", "A"]) {
  test("clearing a pinned habit focuses the cold and cached timeline for " + scope, async ({page}) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await serve(page, () => ({benchmark:0.03, events:true, observations:true, isa:true}));
    await page.route("**/api/backend/assistant/status", route => route.fulfill({json:{ready:true}}));
    const lens = scope === "all" ? "review" : "account-analysis";
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    await page.route("**/api/backend/dashboard/lens/" + lens + "*", async route => {
      if (!new URL(route.request().url()).searchParams.has("runId")) await held;
      await route.fallback();
    });
    const params = new URLSearchParams({snapshotId:"synthetic-decision-context", habit:"untraded_fall", reviewWindow:"to_date"});
    if (scope !== "all") params.set("account", scope);
    const chip = page.getByRole("button", {name:/Clear filter/});
    const heading = page.getByRole("heading", {name:"Each decision to date"});
    try {
      await page.goto("/review?" + params);
      const live = page.waitForRequest(req => {
        const url = new URL(req.url());
        return url.pathname.endsWith("/dashboard/lens/" + lens) && !url.searchParams.has("runId");
      });
      await chip.press("Enter");
      await live;
      await expect(chip).toHaveCount(0);
      await expect(heading).toHaveCount(0);
    } finally { release(); }
    await expect(heading).toBeFocused();
    await page.goBack();
    await chip.press("Enter");
    await expect(heading).toBeFocused();
  });
}

for (const provider of ["ready", "unavailable"]) {
  test("expanded English habits keep the timeline fixed beside the sidebar when " + provider, async ({page,isMobile}, info) => {
    test.skip(isMobile || !process.env.PLAYWRIGHT_BASE_URL, "The sidebar shares space with the desktop review.");
    await page.addInitScript(() => {
      localStorage.setItem("trading_max-locale","en");
      localStorage.setItem("tm-reading-review-habits","open");
    });
    await serve(page, () => ({benchmark:0.02,events:true,habitsConsented:true}));
    const { promise: status, resolve: resolveStatus } = Promise.withResolvers<void>();
    const { promise: brief, resolve: resolveBrief } = Promise.withResolvers<void>();
    await page.route("**/api/backend/assistant/status", async r => {await status; await r.fulfill({json:{ready:provider === "ready"}});});
    const description = "In hindsight, the net hypothetical loss at each security’s average purchase size was about £94.52. Only four of the seven recorded purchases had a complete twenty-session outcome.";
    await page.route("**/api/backend/assistant/roles/habits/reading", async r => {
      await brief;
      const lines = ["basket_buy","before_earnings","untraded_fall"].map(section => ({section, en:description, zh:description,
        evidence:{tool:"review_patterns",source:"review",evidenceId:"ev_habit",arguments:{habitSection:section}}}));
      await r.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({type:"result",reading:{role:"habits",asOf,lines}})+"\n"});
    });
    await page.goto("/review");
    await page.locator("[data-assistant-trigger]").click();
    await expect(page.locator("#mx-assistant-panel")).toBeVisible();
    const heading = page.getByRole("heading",{name:/Each decision after/});
    await expect(heading).toBeVisible();
    const y = await heading.evaluate(node => node.getBoundingClientRect().top + scrollY);
    const result = page.waitForResponse(r => r.url().endsWith("/assistant/status"));
    resolveStatus(); await result;
    resolveBrief();
    if (provider === "ready") await expect(page.locator(".mx-habit-line")).toHaveCount(3);
    else await expect(page.getByText("The model is unavailable.", {exact:false})).toBeVisible();
    expect(Math.abs(await heading.evaluate(node => node.getBoundingClientRect().top + scrollY) - y)).toBeLessThan(2);
    if (process.env.REVIEW_SCREENSHOTS) await page.screenshot({path:join(process.env.REVIEW_SCREENSHOTS, info.project.name+"-en-habits-sidebar-"+provider+".png")});
  });
}

test("a pinned habit and horizon remain readable with MaxAI off", async ({page},info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  if (info.project.name === "mobile") await page.setViewportSize({width:390,height:844});
  await serve(page, () => ({ benchmark:0.03, events:true, unpricedBasket:true }));
  await page.route("**/api/backend/profile", r => r.fulfill({json:{accountLabels:{}, assistantEnabled:false}}));
  await page.goto("/review?account=A&habit=basket_buy&reviewWindow=to_date&snapshotId=synthetic-decision-context");
  await expect(page.locator(".mx-review-filter")).toContainText("同一天买入多只");
  await expect(page.getByRole("button",{name:"至今",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(panel(page,"帮你最多")).toContainText("£70");
  if (process.env.REVIEW_SCREENSHOTS) {
    await panel(page,"帮你最多").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:join(process.env.REVIEW_SCREENSHOTS, info.project.name+"-zh-pinned-review-off.png")});
  }
});

test("a consent change hides cached Review before the other tab's profile resolves", async ({page,context,isMobile}, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  if (isMobile) await page.setViewportSize({width:390,height:844});
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await serve(page, () => ({benchmark:0.03,events:true,habitsConsented:true}));
  let changed = false, enabled = true;
  const { promise: profileWait, resolve: resolveProfile } = Promise.withResolvers<void>();
  const { promise: statusWait, resolve: resolveStatus } = Promise.withResolvers<void>();
  const requests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (changed && path.includes("/api/backend/assistant/")) requests.push(path);
  });
  await page.route("**/api/backend/profile", async route => {
    if (changed) await profileWait;
    await route.fulfill({json:{accountLabels:{},assistantEnabled:enabled}});
  });
  await page.route("**/api/backend/assistant/status", async route => {
    if (changed) await statusWait;
    await route.fulfill({json:{ready:enabled, code:enabled ? null : "assistant_disabled"}});
  });
  await page.route("**/api/backend/assistant/roles/habits/reading", route => route.fulfill({
    contentType:"application/x-ndjson",body:JSON.stringify({type:"result",reading:{role:"habits",asOf,lines:[
      {section:"basket_buy",en:"Two recorded basket buys.",zh:"同日买入",evidence:{source:"review",tool:"review_patterns",evidenceId:"ev_habit",arguments:{habit:"basket_buy"}}},
    ]}})+"\n",
  }));
  await page.goto("/review?account=A");
  await expect(page.locator(".mx-digest")).toContainText("Two recorded basket buys.");
  const rank = panel(page,"Helped most");
  await expect(rank.getByRole("button",{name:/SYNB/})).toBeVisible();
  const other = await context.newPage();
  await other.goto("/favicon.ico");
  const fetching = page.waitForRequest(r => new URL(r.url()).pathname === "/api/backend/profile");
  changed = true;
  await other.evaluate(() => localStorage.setItem("trading_max-assistant-settings-revision","withdrew"));
  await fetching;
  try {
    await expect(page.locator(".mx-digest")).toHaveCount(0, {timeout:1500});
    await expect(rank.getByRole("button",{name:/SYNB/})).toHaveCount(0);
    await expect(rank.getByRole("link").first()).toBeVisible();
    expect(requests).toEqual([]);
    await page.locator("[data-assistant-trigger]").click();
    await expect(page.locator("#mx-assistant-panel")).toContainText("Checking connection");
    expect(requests).toEqual([]);
    enabled = false;
    resolveProfile();
    await expect(page.locator("#mx-assistant-panel")).toContainText("Enable MaxAI");
    await page.keyboard.press("Escape");
    await expect(page.locator(".mx-review-habits-space,.mx-digest")).toHaveCount(0);
    expect(requests).toEqual([]);
    if (process.env.REVIEW_SCREENSHOTS) await page.screenshot({path:join(process.env.REVIEW_SCREENSHOTS, info.project.name+"-en-withdrawn-review.png")});
  } finally {
    resolveProfile(); resolveStatus();
    await other.close();
  }
});

test("collapsed unavailable Habits keeps its footprint and opens MaxAI settings", async ({page,isMobile}, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  if (isMobile) await page.setViewportSize({width:390,height:844});
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await serve(page, () => ({benchmark:0.03,events:true,habitsConsented:true}));
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  await page.route("**/api/backend/assistant/status", async route => {
    await held;
    await route.fulfill({json:{ready:false,code:"model_unavailable"}});
  });
  await page.goto("/review");
  const timeline = page.getByRole("heading",{name:/Each decision after/});
  await expect(timeline).toBeVisible();
  const y = () => timeline.evaluate(el => el.getBoundingClientRect().top + scrollY);
  const before = await y();
  release();
  const settings = page.getByRole("link",{name:"MaxAI settings"});
  await expect(settings).toBeVisible();
  expect.soft(Math.abs(await y() - before)).toBeLessThan(1);
  await expect(settings).toHaveAttribute("href","/settings?tab=assistant");
  if (process.env.REVIEW_SCREENSHOTS) await page.screenshot({path:join(process.env.REVIEW_SCREENSHOTS, info.project.name+"-en-collapsed-unavailable.png")});
  await page.route("**/api/backend/settings/assistant", route => route.fulfill({json:{
    enabled:true,consentRevision:2,acceptedConsentRevision:2,revision:1,providers:[],integrations:[],
  }}));
  await settings.click();
  await expect(page).toHaveURL(/\/settings\?tab=assistant/);
  await expect(page.getByRole("tab",{name:/MaxAI|Assistant/})).toHaveAttribute("aria-selected","true");
});
