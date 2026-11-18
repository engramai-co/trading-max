import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { components } from "../lib/api-schema";

// Two synthetic accounts. Invest has two scored decisions and three young ones a link can open; Stocks ISA, when
// present, has a buy that helped more than any in Invest and a sale that cost. Between fetches only their context changes.
const asOf = "2026-10-20T12:00:00Z";
type Context = {
  benchmark: number; events: boolean; failing?: boolean; healthFailing?: boolean; twin?: boolean; settled?: boolean;
  renamed?: boolean; observations?: boolean; cluster?: boolean; empty?: boolean; isa?: boolean;
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
function isa({ benchmark }: Context) {
  const scored = { observedDays: 30, horizonComplete: true, marketReturnHorizon: benchmark, marketReturnToDate: benchmark, events: [] };
  return [
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
      totalValueGbp: 2000, totalCashGbp: 100, holdings: [], nav: [],
      accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2000 }],
      // Enough of the account review for its highlights: a realized gain and a loss to open.
      selectedAccountReview: current.empty ? null : { attribution: { by_instrument: { buckets: [{ key: "SYNA", netResultGbp: 120 }, { key: "SYNB", netResultGbp: -40 }] } } },
      selectedCfdReview: current.empty ? null : { moneyOutcome: {
        endingRealisedCashEquityProxyGbp: 1500, netRealisedPnlGbp: -200, maxRealisedPnlDrawdownGbp: -300, accountCashFlowGbp: 1700,
      } },
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
    return route.fulfill({ json: path.endsWith("/profile") ? { accountLabels: {} } : {} });
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
    await expect(recent).toHaveAttribute("href", sale);
    // A T day says what its excess did, as on the account's review.
    await expect(page.locator(".mx-review-journal").getByRole("link", { name: /SYNG/ })).toHaveText("日内往返后净买入 SYNG");
    await recent.click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === sale);
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Delta/ })).toBeFocused();
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

  test("a failed refetch and its recovery leave focus and the horizon where the reader put them", async ({ page }) => {
    await page.goto(sale);
    const row = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Delta/ });
    await expect(row).toBeFocused();
    const twenty = page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" });
    await twenty.click();
    await row.focus();
    context = { ...context, failing: true };
    await reconnect(page);
    // Once the retry fails, report it beside the data time and keep the review mounted.
    await page.clock.fastForward(5_000);
    const failure = page.getByRole("button", { name: /更新失败 · 上次成功 \d{2}:\d{2} · 重试/ });
    await expect(failure).toBeVisible();
    await expect(row).toBeFocused();
    await expect(twenty).toHaveAttribute("aria-pressed", "true");
    context = { ...context, failing: false, benchmark: 0.034 };
    // Retry the failed lens itself, without moving focus to the retry button.
    const recovered = page.waitForResponse((response) =>
      response.ok() && new URL(response.url()).pathname.endsWith("/dashboard/lens/account-analysis"));
    await reconnect(page);
    await recovered;
    await expect(failure).toHaveCount(0);
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
    await expect(row).toBeFocused();

    // The service can recover without publishing another snapshot.
    context = { ...context, healthFailing: false };
    const recovery = health(200);
    await page.clock.fastForward(121_000);
    await recovery;
    await expect(failure).toHaveCount(0);
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
    await expect(helped.nth(0)).toHaveAttribute("href", "/review?account=B&decision=2026-09-03.buy.SYNI");
    await helped.nth(0).click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&decision=2026-09-03.buy.SYNI");
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
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&decision=2026-09-03.buy.SYNI");
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
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=B&decision=2026-09-10.sell.SYNK");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Kappa/ })).toBeFocused();
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
    await expect(chip).toHaveAttribute("href", "/review?account=A&decision=2026-09-02.buy.SYNC3");
    await chip.click();
    await expect(page).toHaveURL((url) => url.pathname + url.search === "/review?account=A&decision=2026-09-02.buy.SYNC3");
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
    // Both name the same link, which opens the normal review rather than guess between them.
    for (const twin of await twins.all()) {
      await expect(twin).toHaveAttribute("href", "/review?account=A&decision=2026-10-14.sell.SYND.AS");
    }
    expect(warnings).toEqual([]);
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
  await serve(page, () => ({ benchmark: 0.021, events: false, cluster: true }));
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
  // The review no longer asks for an AI review.
  expect(reviews).toEqual([]);
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
                    "持仓大跌当天没加仓 1 次，错过约 £14。",
                    "One untraded fall, about £14 in missed gains.",
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
        const openHabits = () =>
          (mobile ? page.locator(".mx-phone-habits") : page.locator(".mx-digest-head > button")).click();
        await openHabits();
        const chooseHabit = page.locator(".mx-habit-line > button").first();
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
          await page.locator(".mx-habit-line .mx-reading-source").first().click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.locator(".mx-review-filter")).toBeFocused();
        } else await chooseHabit.click();
        const filtered = page.locator(".mx-review-filter");
        await expect(filtered).toBeVisible();
        await expect(page.locator(".mx-review-expand-head > button")).toHaveCount(1);
        await expect(page.locator(".mx-journal-item")).toHaveCount(1);
        await page.getByRole("button", { name: zh ? "至今" : "To date", exact: true }).click();
        if (mobile) await openHabits();
        await expect(chooseHabit).toContainText("£70");
        if (mobile) await page.getByRole("button", { name: zh ? "关闭解读" : "Close reading" }).click();
        const row = page.locator(".mx-review-expand-head > button").first();
        await row.focus();
        await row.press("Enter");
        const reading = mobile ? page.getByRole("dialog") : page.locator(".mx-inline-reading");
        await expect(reading.locator(".mx-reading-line")).toHaveCount(2);
        await expect(reading.locator(".mx-reading-source").last()).toHaveAttribute(
          "href",
          /decision=2026-09-02.buy.SYNB/,
        );
        if (!mobile)
          await reading.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
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
        const sent = page.waitForRequest((r) => r.url().endsWith("/assistant/chat"));
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

test("review keeps the painted timeline in place when consent resolves", async ({page}) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  await serve(page, () => ({benchmark:0.03, events:true}));
  let resolve!: () => void;
  const delayed = new Promise<void>(done => { resolve = done; });
  await page.route("**/api/backend/assistant/status", async route => {
    await delayed; await route.fulfill({json:{ready:true}});
  });
  await page.goto("/review");
  await expect(page.locator(".mx-review-money,.mx-review-lead").first()).toBeVisible();
  const timeline = page.getByRole("heading", {name:/每笔决定/}).first();
  const before = await timeline.count() && await timeline.isVisible() ? (await timeline.boundingBox())!.y : null;
  resolve();
  await expect(page.locator(".mx-digest").first()).toBeVisible();
  await expect(timeline).toBeVisible();
  if (before !== null) expect(Math.abs((await timeline.boundingBox())!.y - before)).toBeLessThan(2);
});

test("the ranked arrow and reading fallback lead to the selected twin", async ({page},info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated web build.");
  await serve(page, () => ({benchmark:0.02,events:false,twin:true}));
  await page.route("**/api/backend/assistant/status",route=>route.fulfill({json:{ready:true}}));
  await page.route("**/api/backend/assistant/roles/*/reading",route=>route.fulfill({contentType:"application/x-ndjson",body:'{"type":"error","code":"assistant_unavailable"}\n'}));
  await page.goto("/review?account=A&reviewWindow=to_date");
  const row = panel(page,"代价最大").locator(".mx-review-expand-head").filter({hasText:"SYND.AS"});
  await expect(row.getByRole("link")).toHaveAttribute("href",/reviewOrdinal=1/);
  await row.getByRole("button").click();
  const fallback = (info.project.name === "mobile" ? page.getByRole("dialog") : page.locator(".mx-inline-reading")).getByRole("link",{name:/查看这笔决定/});
  await expect(fallback).toHaveAttribute("href",/reviewOrdinal=1/);
  await fallback.click();
  await expect(page.locator(".mx-decision-focus")).toContainText("£120");
  await expect(page.locator(".mx-decision-focus").getByRole("link").first()).toBeFocused();
});
