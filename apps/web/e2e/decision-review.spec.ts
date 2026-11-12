import { expect, test, type Page } from "@playwright/test";
import type { components } from "../lib/api-schema";

// A synthetic account with two scored decisions and three that a link can open; between fetches
// only their context changes.
const asOf = "2026-10-20T12:00:00Z";
type Context = { benchmark: number; events: boolean; failing?: boolean; healthFailing?: boolean; twin?: boolean; settled?: boolean; renamed?: boolean; observations?: boolean };

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
      ...scored, date: "2026-09-02", ticker: "SYNB", name: "Synthetic Beta", side: "buy", kind: "B", amountGbp: 800,
      effectHorizonGbp: 60, effectToDateGbp: 70, returnHorizon: 0.09, returnToDate: 0.1,
      events: events ? [
        { date: "2026-09-05", kind: "news", title: "Synthetic Beta opens a second plant in a long-named industrial district" },
        { date: "2026-09-09", kind: "initiate", firm: "Example Securities International", toGrade: "buy" },
        { date: "2026-09-14", kind: "upgrade", firm: "Another Example Research Partners", toGrade: "outperform" },
      ] : [],
    },
    ...linked(context),
  ];
}

function observations(account?: string): components["schemas"]["InvestmentReviewEvidence"] {
  const before = { largestHolding: 0.28, cash: 0.24, usdExposure: 0.31 };
  const after = { largestHolding: 0.26, cash: 0.21, usdExposure: 0.34 };
  const invest: components["schemas"]["AccountReviewEvidence"] = {
    coverage: "complete", asOf,
    holdingMoves: [{ date: "2026-10-16", ticker: "SYNB", quoteCurrency: "USD", change: -0.068 }],
    cashSpans: [{ start: "2026-09-30", end: "2026-10-16", sessions: 13, peakShare: 0.24, averageShare: 0.19 }],
    weightDrifts: [{ start: "2026-09-30", end: "2026-10-16", ticker: "SYNB", before: 0.2, after: 0.26 }],
    fillEffects: [
      { filledAt: "2026-10-19T17:22:00Z", ticker: "SYNE", side: "buy", quantity: 0.5, before, after },
      { filledAt: "2026-10-19T17:21:00Z", ticker: "SYNA", side: "sell", quantity: 2, before: after, after: before },
    ],
  };
  return {
    // A different threshold proves the help uses the response, not its own copy.
    rules: { cashMinSessions: 10, cashShare: 0.12, evidenceDays: 90, recentFillLimit: 8,
      sessionMoveShare: 0.05, weightDriftDays: 30, weightDriftShare: 0.03 },
    accounts: { ...(account !== "B" ? { A: invest } : {}), ...(account !== "A" ? { B: { coverage: "partial" } as const } : {}) },
  };
}

async function serve(page: Page, context: () => Context) {
  await page.route("**/api/backend/**", (route) => {
    const url = new URL(route.request().url());
    const { pathname: path } = url;
    if (path.includes("/dashboard/lens/")) return context().failing ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: {
      runId: "synthetic-decision-context", brokerAsOf: asOf, reviewAsOf: asOf,
      totalValueGbp: 2000, totalCashGbp: 100, holdings: [], nav: [],
      accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2000 }],
      // Enough of the account review for its highlights: a realized gain and a loss to open.
      selectedAccountReview: { attribution: { by_instrument: { buckets: [{ key: "SYNA", netResultGbp: 120 }, { key: "SYNB", netResultGbp: -40 }] } } },
      selectedAccountDecisions: { status: "available", asOf, horizonDays: 20, observingCount: 1, decisions: decisions(context()) },
      decisionReviews: { A: { status: "available", horizonDays: 20, observingCount: 1, decisions: linked(context()) } },
      ...(context().observations ? { reviewEvidence: observations(url.searchParams.get("account") ?? undefined) } : {}),
    } });
    if (path.endsWith("/health")) return context().healthFailing
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { service: "trading_max-api", status: "ok", latestRunId: "synthetic-decision-context" } });
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

  test("a row keeps keyboard focus when a refetch corrects its security's name", async ({ page }) => {
    const row = page.getByRole("link", { name: /Synthetic Alpha/ });
    await row.focus();
    context = { ...context, renamed: true };
    await reconnect(page);
    await expect(row).toContainText("Synthetic Alpha Holdings");
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

test.describe("a link to one decision", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  const sale = "/account-analysis?account=A&reviewView=decisions&decision=2026-10-14.sell.SYND.AS";
  let context: Context;
  test.beforeEach(async ({ page }) => {
    context = { benchmark: 0.021, events: true };
    await page.clock.install({ time: new Date(asOf) });
    await serve(page, () => context);
  });

  test("the review index links each recent decision to itself", async ({ page }) => {
    await page.goto("/review");
    const recent = page.getByRole("link", { name: /SYND\.AS/ });
    await expect(recent).toHaveAttribute("href", sale);
    // A T day says what its excess did, as on the account's review.
    await expect(page.getByRole("link", { name: /SYNG/ })).toContainText("做 T 后净买入 £90");
    await recent.click();
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
    await page.goto("/account-analysis?account=A&reviewView=decisions&decision=2026-10-20.buy.SYNE");
    const observing = page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Epsilon/ });
    await expect(observing).toBeFocused();
    await expect(observing).toContainText("观察中");
    await expect(observing).not.toContainText("£0");
    await page.goto("/account-analysis?account=A&reviewView=decisions&decision=2026-10-01.buy.SYNG");
    await expect(page.locator(".mx-decision-focus").getByRole("link", { name: /Synthetic Gamma/ })).toContainText("做 T 后净买入 £90");
  });

  test("keeps the angle in the address for refresh and Back", async ({ page }) => {
    await page.goto(sale);
    await expect(page.locator(".mx-decision-focus").getByRole("link")).toBeFocused();
    await page.getByRole("tab", { name: "投资结果" }).click();
    await expect(page).toHaveURL(/reviewView=outcome/);
    await expect(page).toHaveURL(/decision=2026-10-14\.sell\.SYND\.AS/);
    await page.reload();
    await expect(page.getByRole("tab", { name: "投资结果" })).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect(page.getByRole("tab", { name: "买卖决定" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
  });

  test("its button lets the decision go and keeps the angle", async ({ page, browserName }) => {
    await page.goto(sale);
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await expect(page).toHaveURL(/reviewView=decisions/);
    await expect(page).not.toHaveURL(/decision=/);
    // Focus returns to the panel the decision led, whose help and horizon come next.
    await expect(page.getByRole("heading", { name: "买卖决定", level: 2 })).toBeFocused();
    // Safari's Tab skips buttons unless the reader turns that on, so only other engines check the next stop.
    if (browserName !== "webkit") {
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "买卖决定说明" })).toBeFocused();
    }
  });

  test("letting go of a decision near the top keeps focus below the sticky bar", async ({ page, browserName }) => {
    await page.goto(sale);
    const card = page.locator(".mx-decision-focus");
    await expect(card.getByRole("link")).toBeFocused();
    const barBottom = await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().bottom);
    // The card sits just under the bar, so its tools row is behind the bar.
    await card.evaluate((element, below) => window.scrollBy({ top: element.getBoundingClientRect().top - below - 4, behavior: "instant" }), barBottom);
    expect(await page.locator(".mx-decision-tools").evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(barBottom);
    await page.getByRole("button", { name: "取消选中这笔决定" }).click();
    await expect(page.getByRole("heading", { name: "买卖决定", level: 2 })).toBeFocused();
    const focusedTop = () => page.evaluate(() => document.activeElement?.getBoundingClientRect().top ?? -1);
    expect(await focusedTop()).toBeGreaterThanOrEqual(barBottom);
    if (browserName !== "webkit") {
      await page.keyboard.press("Tab");
      const help = page.getByRole("button", { name: "买卖决定说明" });
      await expect(help).toBeFocused();
      expect(await focusedTop()).toBeGreaterThanOrEqual(barBottom);
      // The next stop shows its focus ring.
      expect(await help.evaluate((element) => element.matches(":focus-visible") && getComputedStyle(element).outlineStyle)).toBe("solid");
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

  test("horizon choices outlive switching angles and coming back", async ({ page }) => {
    const horizon = page.getByRole("group", { name: "对照时点" });
    await page.goto(sale);
    await expect(horizon.getByRole("button", { name: "至今" })).toHaveAttribute("aria-pressed", "true");
    await horizon.getByRole("button", { name: "20 个交易日后" }).click();
    await page.getByRole("tab", { name: "投资结果" }).click();
    await expect(page).toHaveURL(/reviewView=outcome/);
    await page.goBack();
    await expect(page.locator(".mx-decision-focus")).toBeVisible();
    // The panel is drawn anew, and the decision keeps the horizon the reader chose for it.
    await expect(horizon.getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a highlight opens its evidence through the address, and Back returns", async ({ page }) => {
    await page.goto("/account-analysis?account=A");
    await page.getByRole("button", { name: /已实现盈利贡献/ }).click();
    await expect(page).toHaveURL(/reviewView=attribution/);
    await expect(page.getByRole("tab", { name: "盈亏归因" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "复盘证据" })).toBeFocused();
    await page.goBack();
    await expect(page.getByRole("tab", { name: "买卖决定" })).toHaveAttribute("aria-selected", "true");
  });

  test("a decision the data no longer has leaves the normal review", async ({ page }) => {
    await page.goto("/account-analysis?account=A&reviewView=decisions&decision=2026-10-15.buy.GONE");
    await expect(page.getByRole("link", { name: /Synthetic Alpha/ })).toBeVisible();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a link that fits two securities sharing a ticker leaves the normal review", async ({ page }) => {
    context = { ...context, twin: true };
    await page.goto(sale);
    await expect(page.getByRole("link", { name: /Synthetic Alpha/ })).toBeVisible();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "对照时点" }).getByRole("button", { name: "20 个交易日后" })).toHaveAttribute("aria-pressed", "true");
  });

  test("switching account keeps the angle and lets the decision go", async ({ page }) => {
    await page.goto("/account-analysis?account=A&reviewView=outcome&decision=2026-10-14.sell.SYND.AS");
    // The keyboard opens the list on the current account and steps to the next, alike on every device.
    const account = page.getByRole("combobox", { name: "复盘账户" });
    await account.focus();
    await account.press("ArrowDown");
    await expect(page.getByRole("option", { name: "Stocks ISA" })).toBeVisible();
    await account.press("ArrowDown");
    await account.press("Enter");
    await expect(page).toHaveURL(/account=B/);
    await expect(page).toHaveURL(/reviewView=outcome/);
    await expect(page).not.toHaveURL(/decision=/);
  });
});

test.describe("the review index", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  test("twin decisions keep rows of their own", async ({ page }) => {
    const context: Context = { benchmark: 0.021, events: true, twin: true };
    await serve(page, () => context);
    // React reports rows that share a key in development builds.
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (/same key/i.test(message.text())) warnings.push(message.text());
    });
    await page.goto("/review");
    const twins = page.getByRole("link", { name: /SYND\.AS/ });
    await expect(twins).toHaveCount(2);
    // Both name the same link, which opens the normal review rather than guess between them.
    for (const twin of await twins.all()) {
      await expect(twin).toHaveAttribute("href", "/account-analysis?account=A&reviewView=decisions&decision=2026-10-14.sell.SYND.AS");
    }
    expect(warnings).toEqual([]);
  });
});


test("review shows dated observations, comparable fills and account coverage", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  await serve(page, () => ({ benchmark: 0.02, events: false, observations: true }));
  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "交易副作用" })).toBeVisible();
  const headingNames = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headingNames.slice(0, 3)).toEqual(["最近的买卖决定", "没操作", "交易副作用"]);
  const noTrades = page.locator("section").filter({ has: page.getByRole("heading", { name: "没操作", exact: true }) });
  await expect(noTrades).toContainText("13 个交易日");
  await expect(noTrades).toContainText("24.0%");
  await expect(noTrades).toContainText("19.0%");
  await expect(noTrades).toContainText("20.0%");
  await expect(noTrades).toContainText("26.0%");
  await expect(noTrades).toContainText("-6.8%");
  await expect(noTrades).toContainText("覆盖不全");
  await page.getByRole("button", { name: "没操作说明" }).click();
  await expect(page.getByText(/达到 12%/)).toBeVisible();
  await page.keyboard.press("Escape");

  const first = page.getByRole("table", { name: /买入 SYNE/ });
  await expect(first.getByRole("row", { name: /美元计价敞口/ })).toContainText("31.0%");
  await expect(first.getByRole("row", { name: /美元计价敞口/ })).toContainText("34.0%");
  await page.locator("summary").filter({ hasText: "卖出 SYNA" }).click();
  await expect(page.getByRole("table", { name: /卖出 SYNA/ })).toBeVisible();

  await page.goto("/account-analysis?account=B&reviewView=decisions");
  await expect(page.getByText("暂无可重算的成交")).toBeVisible();
  await expect(page.getByRole("table", { name: /买入 SYNE/ })).toHaveCount(0);
});
