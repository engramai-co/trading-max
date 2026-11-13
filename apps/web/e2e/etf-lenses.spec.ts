import { expect, test, type Page } from "@playwright/test";
import { prepareHistory } from "../lib/portfolio/prepared";

const runId = "synthetic-etf-lenses";
const date = "2026-11-11";
const stamp = date + "T16:30:00Z";
const isin = "ZZ0000000011";
const peerIsin = "ZZ0000000022";
const evidence = { coverage: "available", sourceUrl: "https://issuer.example/etf", effectiveAt: date, fetchedAt: stamp, parserVersion: "fixture" };
const reading = {
  isin, tickers: ["EQQQ"], name: "Synthetic Nasdaq ETF", issuer: "Synthetic issuer", indexName: "Synthetic Nasdaq Index (Net)",
  expenseRatio: 0.003, feeBasis: "OCF", incomeUse: "Distributing", domicile: "Ireland",
  hedging: "unhedged", holdingsState: "available",
  tracking: { state: "available", differencePp: -0.50, periodEnd: "2026-10-31", currency: "USD", benchmarkCurrency: "USD", navHedging: "unhedged", benchmarkHedging: "unhedged", evidence },
  overlap: { state: "available", value: 0.51, fundCoverage: 0.98, restCoverage: 0.95, fundHoldingsDate: date, restHoldingsDates: [date], datesValid: true, portfolioAsOf: stamp },
  evidence: { expense_ratio: evidence, share_class_size: evidence },
  shareClassSize: { amount: 90_000_000, currency: "USD" },
};
const holding = {
  ticker: "EQQQ", researchTicker: "EQQQ.L", name: "Synthetic Nasdaq ETF", isFund: true, fundIsin: isin, listingMarket: "LSE", account: "A",
  quantity: 25, currentPrice: 60_000, priceCurrency: "GBX", currentValueGbp: 15_000, costGbp: 20_000,
  pnlGbp: -5_000, pnlPct: -0.25, allocationPct: 0.375,
  dayChangeGbp: 150, dayChangePct: 0.01, dayChangeDate: date,
};
const stock = { ...holding, ticker: "TEST", researchTicker: "TEST", name: "Synthetic stock", isFund: false, fundIsin: null, account: "B", pnlPct: 0.25, pnlGbp: 5_000 };
const accounts = ["A", "B"].map((code) => ({ code, name: code === "A" ? "Invest" : "ISA", isInvestable: true, totalValueGbp: 20_000, cashGbp: 1_000, asOf: stamp }));
const technical = {
  ticker: holding.researchTicker, asOf: date, currency: "GBP", price: 600, score: 28, state: "弱势/趋势破坏",
  rsi: 22, scoreExplanationState: "verified", atrPct: 0.03, bollingerWidth: 0.14, historyCoverage: {},
  scoreBreakdown: { score: 28, baseScore: 50, rawScore: 28, clampAdjustment: 0, availableSignals: 2, totalSignals: 12,
    groups: [{ key: "trend", contribution: -22, factors: [{ key: "sma200", value: 600, reference: 650, contribution: -22 }] }] },
};
const summary = { runId, technical: [technical], brokerAsOf: stamp, totalValueGbp: 40_000, totalCashGbp: 2_000, holdings: [holding, stock], accounts };
const history = prepareHistory({ ...summary, dataRevision: "synthetic" }, { range: "1D", scope: "total" }).chart;
const holdings = {
  ticker: "EQQQ", fundIsin: isin, asOf: date, fetchedAt: stamp, issuer: reading.issuer, state: "available",
  holdings: [
    { isin: "US0000000001", ticker: "AAA", name: "Synthetic issuer A", weightPct: 62, country: "United States", industry: "Technology", assetClass: "Equity", currency: "USD" },
    { isin: "US0000000002", ticker: "BBB", name: "Synthetic issuer B", weightPct: 38, country: "Canada", industry: "Utilities", assetClass: "Equity", currency: "CAD" },
  ],
  countryWeights: { "United States": 62, Canada: 38 }, industryWeights: { Technology: 62, Utilities: 38 }, currencyWeights: { USD: 62, CAD: 38 },
  evidence: { holdings: evidence, currency_weights: evidence, country_weights: evidence, industry_weights: evidence },
};
const matches = [{ securityId: "ISIN:US0000000001", name: "Synthetic issuer A", fundWeight: 0.62, restDirectWeight: 0.18, restViaFund: { IE00BYVTMW98: 0.33 }, overlap: 0.51 }];
const fund = {
  ticker: "EQQQ", isin, issuer: reading.issuer, fetchedAt: stamp, sourceUrl: evidence.sourceUrl, indexName: reading.indexName,
  expenseRatio: reading.expenseRatio, incomeUse: "Distributing", hedging: "unhedged", shareCurrency: "USD", baseCurrency: "USD", domicile: "Ireland",
  profile: { evidence: reading.evidence, shareClassSize: reading.shareClassSize, rebalanceFrequency: "Quarterly", feeBasis: "OCF" },
  reading, matches, holdings, holdingsState: "available", returnCurrency: "USD",
  returnBasis: "Synthetic NAV and benchmark total returns", annualReturns: [{ year: 2025, navReturn: 0.12, benchmarkReturn: 0.125, trackingDifference: -0.005 }],
  disclosures: [{ kind: "holdings", value: date, observedAt: stamp, effectiveAt: date, sourceUrl: evidence.sourceUrl }],
};
const ukReportingFund = { state: "reporting", publicationDate: date, effectiveFrom: "2025-01-01", evidence };
const peerComparison = {
  benchmark: reading.indexName, domicile: reading.domicile, hedging: reading.hedging, incomeUse: reading.incomeUse, publishedAt: stamp,
  funds: [
    { isin, name: reading.name, sourceUrl: evidence.sourceUrl, heldTicker: "EQQQ", fee: { value: 0.003, basis: "OCF", evidence }, tracking: reading.tracking, overlap: reading.overlap },
    { isin: peerIsin, name: "Synthetic peer ETF", sourceUrl: evidence.sourceUrl, fee: { value: 0.004, basis: "OCF", evidence } },
  ],
  ranks: { fee: { percentile: 0, count: 2, comparableIsins: [isin, peerIsin] } },
};
const benchmarkChange = {
  kind: "index-change", value: reading.indexName, previousValue: "Synthetic legacy index",
  observedAt: stamp, sourceUrl: evidence.sourceUrl, evidence, previousEvidence: evidence,
};
const points = Array.from({ length: 12 }, (_, index) => ({
  date: "2026-10-" + String(12 + index).padStart(2, "0"), close: 110 + index, open: 109 + index,
  high: 111 + index, low: 108 + index, volume: 1000, sma20: null, sma50: null, sma200: null,
}));
const markers = [{ ticker: "EQQQ", date: points[3].date, kind: "B", accounts: ["invest"], buyOrders: 1, buyQuantity: 1, sellOrders: 0, sellQuantity: 0, buyAveragePrice: 110, sellAveragePrice: null }];
/** Fifteen-minute bars: the prior session's last bar, then the clock's session from the open. */
const sessionBars = [
  { date: "2026-11-10T16:15:00", close: 120 },
  ...Array.from({ length: 6 }, (_, index) => ({ date: `${date}T${String(8 + index).padStart(2, "0")}:00:00`, close: 120 + index })),
];

async function synthetic(page: Page, late?: Promise<void>, fixture = summary, publishReadings = true, fundPending = false) {
  const requests: string[] = [];
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL!).origin;
  await page.clock.install({ time: new Date(stamp) });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== "GET") return route.abort();
    if (url.pathname.startsWith("/api/company-logo/")) return route.fulfill({ status: 204 });
    if (!url.pathname.startsWith("/api/backend/")) return route.continue();
    const path = url.pathname.slice("/api/backend".length);
    requests.push(path);
    if (path === "/dashboard/etfs") {
      if (late) await late;
      return route.fulfill({ json: { runId, funds: publishReadings ? [reading, {
        ...reading, isin: "IE00BYVTMW98", tickers: ["EQGB"], hedging: "GBP",
        tracking: { state: "incomparable", currency: "GBP", benchmarkCurrency: "USD" },
      }] : [] } });
    }
    if (path === "/dashboard/etfs/" + isin) return route.fulfill({ json: { runId, reading, holdings, matches } });
    if (path === "/dashboard/history") return route.fulfill({ json: history });
    if (path.startsWith("/dashboard/lens/")) return route.fulfill({ json: fixture });
    if (path === "/research/shell") return route.fulfill({ json: {
      status: { runId, overall: "fresh", artifacts: [] }, watchlistCategories: [],
      instruments: [holding, stock].map((item, order) => ({
        ticker: item.researchTicker, name: item.name, exchange: "LSE", status: item.isFund && fundPending ? "pending" : "ready", order, lastRunId: runId,
        held: true, isFund: item.isFund, exposureGbp: item.currentValueGbp, directValueGbp: item.currentValueGbp,
      })),
    } });
    if (path.includes("/lens/")) {
      const ticker = path.split("/")[2];
      const view = path.split("/").at(-1);
      const isFund = ticker === holding.researchTicker;
      return route.fulfill({ json: {
        ticker, view, runId, generatedAt: stamp, fundamentals: { metrics: {} },
        technical: isFund && view === "technical" ? technical : null,
        technicalSummary: isFund && view === "overview" ? technical : null,
        context: { quote: { ticker, price: 600, currency: "GBP", asOf: stamp, source: "synthetic", exchange: "LSE" },
          assetType: isFund ? "ETF" : "EQUITY", capabilities: [], datasets: [] },
        nextEarningsDate: ticker === "TEST" ? "2026-11-19" : null,
      } });
    }
    if (path.endsWith("/fund")) {
      const detail = url.searchParams.get("detail");
      if (detail === "peers") return route.fulfill({ json: { ...fund, peerComparison } });
      if (detail === "journal") return route.fulfill({ json: { ...fund, disclosures: [...fund.disclosures, benchmarkChange] } });
      return route.fulfill({ json: { ...fund, ukReportingFund } });
    }
    if (path.endsWith("/journal")) return route.fulfill({ json: { ticker: "EQQQ", notes: [], models: [] } });
    if (path.endsWith("/prices")) return route.fulfill({ json: url.searchParams.get("interval") === "15m" ? {
      ticker: "EQQQ", requestedInterval: "15m", actualInterval: "15m", asOf: stamp,
      currency: "GBP", points: sessionBars, tradeMarkers: [], availableSessions: 2,
    } : {
      ticker: "EQQQ", requestedInterval: "1d", actualInterval: "1d", asOf: stamp,
      currency: "GBP", points, tradeMarkers: markers, availableSessions: points.length,
    } });
    if (path === "/health") return route.fulfill({ json: { service: "trading_max-api", status: "ok", latestRunId: runId } });
    if (path === "/profile") return route.fulfill({ json: { accountLabels: {} } });
    return route.fulfill({ json: {} });
  });
  return requests;
}

const shot = (page: Page, project: string, name: string, theme: string) =>
  page.screenshot({ path: `/tmp/tm-etf-${project}-${name}-${theme}.png`, animations: "disabled", scale: "css", fullPage: name === "technical" });

test.describe("ETF surfaces from synthetic snapshots", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");
  test.beforeEach(async ({ page }, info) => {
    if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  });

  test("ETF cells arrive after the table and preserve the warning and loss dots", async ({ page }, info) => {
    let release!: () => void;
    const late = new Promise<void>((resolve) => { release = resolve; });
    await synthetic(page, late);
    await page.goto("/?range=1D");
    const ledger = page.locator(".mx-ledger-table:visible, .mx-ledger-list:visible");
    const stocks = ledger.locator('[data-asset-class="stocks"]');
    const funds = ledger.locator('[data-asset-class="funds"]');
    await expect(stocks).toContainText("股票");
    await expect(funds).toContainText("基金");
    const headings = ".mx-ledger-head, .mx-ledger-list-head";
    await expect(stocks.locator(headings)).toContainText("技术");
    await expect(stocks.locator(headings)).toContainText("模型空间");
    await expect(funds.locator(headings)).toContainText("跟踪差");
    await expect(funds.locator(headings)).toContainText("技术");
    await expect(funds.locator(headings)).not.toContainText("重叠");
    await expect(funds.locator('a.mx-ledger-link:visible, a.mx-ledger-item:visible')).toHaveAttribute("href", "/research?ticker=EQQQ.L&view=technical&technicalView=data");
    await expect(funds.locator('.mx-ledger-flag[title*="RSI 22"]')).toBeVisible();
    const etf = funds.locator(".mx-ledger-etf");
    const figures = etf.locator('> span[aria-hidden="true"]');
    try {
      await expect(etf).toHaveCount(1);
      await expect(figures).toHaveText(["—"]);
    } finally {
      release();
    }
    await expect(figures).toHaveText(["−0.50"]);
    const associatedHeadings = await etf.evaluateAll((cells) => cells.map((cell) => {
      const ids = cell.closest("td")?.getAttribute("headers");
      return ids ? document.getElementById(ids.split(" ").at(-1)!)?.textContent
        : cell.closest("dd")?.previousElementSibling?.textContent;
    }));
    expect(associatedHeadings).toEqual(["跟踪差"]);
    await expect(etf.first()).toHaveAttribute("aria-label", /2026-10-31/);
    await expect(ledger.locator(".mx-ledger-flag[data-tone=warning]")).toHaveCount(2);
    await expect(ledger.locator(".mx-ledger-flag[data-tone=down]")).toHaveCount(1);
    await ledger.evaluate((node) => node.closest(".mx-overview-holdings")?.scrollIntoView({ block: "center", behavior: "instant" }));
    await shot(page, info.project.name, "overview", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
    await shot(page, info.project.name, "overview", "dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("changing the account clears a pending reading from the previous view", async ({ page }) => {
    let release!: () => void;
    const late = new Promise<void>((resolve) => { release = resolve; });
    await synthetic(page, late);
    await page.goto("/?range=1D");
    const ledger = page.locator(".mx-ledger-table:visible, .mx-ledger-list:visible");
    try {
      await expect(ledger.locator(".mx-ledger-etf")).toHaveCount(1);
      await page.getByRole("combobox", { name: "组合账户" }).click();
      await page.getByRole("option", { name: "Stocks ISA" }).click();
      await expect(ledger.locator(".mx-ledger-etf")).toHaveCount(0);
    } finally {
      release();
    }
    await expect(ledger).toContainText("Synthetic stock");
    await expect(ledger.locator("[data-asset-class]")).toHaveCount(1);
    await expect(ledger.locator('[data-asset-class="stocks"]')).toBeVisible();
    await expect(ledger.locator(".mx-ledger-etf")).toHaveCount(0);
  });

  test("fund-only ledgers omit an empty group and keep unavailable readings as dashes", async ({ page }) => {
    await synthetic(page, undefined, { ...summary, technical: [], holdings: [holding] }, false);
    const readings = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/dashboard/etfs"));
    await page.goto("/?range=1D");
    expect(await (await readings).json()).toEqual({ runId, funds: [] });
    const ledger = page.locator(".mx-ledger-table:visible, .mx-ledger-list:visible");
    await expect(ledger.locator("[data-asset-class]")).toHaveCount(1);
    const funds = ledger.locator('[data-asset-class="funds"]');
    await expect(funds).toBeVisible();
    await expect(funds.locator('.mx-ledger-etf > span[aria-hidden="true"]')).toHaveText(["—"]);
  });

  test("overview previews the ledger’s session move; holdings previews the session’s path", async ({ page }) => {
    test.skip(!await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches), "Hover is pointer-only.");
    const requests = await synthetic(page);
    await page.goto("/?range=1D");
    await page.locator(".mx-ledger-table [data-asset-class=funds] .mx-peek-target").hover();
    const peek = page.locator(".mx-peek:visible");
    await expect(peek).toContainText("今日涨跌");
    await expect(peek).toContainText("+1.00%");
    await expect(peek.locator("svg.mx-sparkline")).toHaveCount(0);
    expect(requests.some((path) => path.endsWith("/prices"))).toBe(false);

    await page.goto("/holdings");
    await page.locator("button:visible").filter({ hasText: "EQQQ" }).first().locator(".mx-peek-target").hover();
    await expect(peek).toContainText("今日");
    await expect(peek).toContainText("+4.17%");
    await expect(peek.locator("svg.mx-sparkline")).toBeVisible();
    expect(requests.some((path) => path.endsWith("/prices"))).toBe(true);
  });

  test("drawer uses published ETF holdings and shows a stock event", async ({ page }, info) => {
    const requests = await synthetic(page);
    await page.goto("/holdings");
    await page.locator("button:visible").filter({ hasText: "EQQQ" }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toContainText(reading.indexName);
    await expect(drawer).toContainText("0.30%");
    await drawer.locator("summary").filter({ hasText: "基金底层持仓" }).click();
    await expect(drawer).toContainText("62.00%");
    expect(requests).toContain("/dashboard/etfs/" + isin);
    expect(requests.some((path) => path.endsWith("/fund"))).toBe(false);
    await shot(page, info.project.name, "drawer", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
    await shot(page, info.project.name, "drawer", "dark");
    await page.getByRole("button", { name: "关闭持仓明细" }).click();
    await page.locator("button:visible").filter({ hasText: "TEST" }).first().click();
    await expect(drawer).toContainText("下次财报");
  });

  test("an unresearched held fund stays pending, while an unknown ticker can be added", async ({ page }) => {
    await synthetic(page, undefined, summary, false, true);
    await page.goto("/research?ticker=EQQQ.L");
    await expect(page.getByRole("tablist", { name: "证券研究视角" }).getByRole("tab")).toHaveCount(7);
    await expect(page.getByText("正在读取证券研究…", { exact: true })).toBeAttached();
    await expect(page.getByText("EQQQ.L 还不在研究清单里")).toHaveCount(0);
    await page.goto("/research?ticker=UNKNOWN");
    await expect(page.getByText("UNKNOWN 还不在研究清单里")).toBeVisible();
  });

  test("research keeps seven fund lenses and links the overview score to its diagnosis", async ({ page }, info) => {
    await synthetic(page);
    await page.goto("/research?ticker=EQQQ.L&view=analyst");
    const lenses = page.getByRole("tablist", { name: "证券研究视角" });
    await expect(lenses.getByRole("tab")).toHaveCount(7);
    await expect(lenses.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".mx-etf-summary")).toContainText("跟踪质量");
    await expect(page.locator(".mx-tech-score-compact .mx-tech-number strong")).toHaveText("28");
    await page.getByRole("button", { name: "技术状态", exact: true }).click();
    await expect(page.locator("#technical-diagnosis")).toBeFocused();
    await expect(page.getByRole("heading", { name: "技术诊断" })).toBeVisible();
    await lenses.getByRole("tab", { name: "概览" }).click();
    await expect(page.getByText("已获批")).toBeVisible();
    await page.getByRole("button", { name: "英国申报基金状态说明" }).click();
    await expect(page.getByRole("link", { name: "HMRC 原始名单" })).toBeVisible();
    await page.keyboard.press("Escape");
    await shot(page, info.project.name, "research", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
    await shot(page, info.project.name, "research", "dark");
    await page.goto("/research?ticker=EQQQ.L&view=fundamentals&fundMode=tracking");
    await expect(lenses.getByRole("tab", { name: "指数与跟踪" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "年度净值与指数总回报" })).toBeVisible();
    await expect(page.getByText("日度净值历史")).toBeVisible();
    await shot(page, info.project.name, "tracking", "dark");
    await lenses.getByRole("tab", { name: "持仓与重叠" }).click();
    await expect(page.getByRole("region", { name: "前十大持仓" })).toBeVisible();
    await page.locator("summary").filter({ hasText: "重叠明细" }).click();
    await expect(page.getByRole("region", { name: "相同证券的直接及穿透权重" })).toContainText("IE00BYVTMW98");
    await shot(page, info.project.name, "holdings", "dark");
    await lenses.getByRole("tab", { name: "同类" }).click();
    await expect(page.getByRole("region", { name: "同类 ETF 对比" })).toContainText("Synthetic peer ETF");
    await page.getByText("本基金分位").click();
    await expect(page.getByText("第 0 分位")).toBeVisible();
    await expect(page.getByRole("button", { name: "同类说明" })).toBeVisible();
    await shot(page, info.project.name, "peers", "dark");
    await lenses.getByRole("tab", { name: "日志" }).click();
    await expect(page.getByRole("region", { name: "交易记录" })).toContainText("Invest");
    await expect(page.getByRole("region", { name: "发行商披露" })).toContainText(date);
    await expect(page.getByRole("region", { name: "发行商披露" })).toContainText(benchmarkChange.previousValue);
    await shot(page, info.project.name, "journal", "dark");
    await lenses.getByRole("tab", { name: "价格与技术面" }).click();
    await expect(page.locator(".mx-tech-main canvas").first()).toBeVisible();
    await expect(page.locator(".mx-tech-score .mx-tech-number strong")).toHaveText("28");
    await expect(page.getByRole("heading", { name: "技术诊断" })).toBeVisible();
    await shot(page, info.project.name, "technical", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
    await shot(page, info.project.name, "technical", "light");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto("/research?ticker=TEST");
    await expect(lenses.getByRole("tab")).toHaveCount(7);
  });
});
