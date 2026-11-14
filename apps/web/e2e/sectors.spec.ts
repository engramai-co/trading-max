import path from "node:path";
import type { GlobalSectorBoard } from "../workspace/global-sectors";
import type { GlobalMarketContribution } from "../workspace/global-markets-data";
import type { IndexContext, IndexIdentity } from "../workspace/market-indices-data";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Entirely synthetic market data: invented tickers, weights and moves.
const SECTORS: Array<[string, string, number, number]> = [
  ["45", "Information Technology", 0.31, 0.0145],
  ["40", "Financials", 0.13, -0.0059],
  ["50", "Communication Services", 0.1, 0.0043],
  ["25", "Consumer Discretionary", 0.1, -0.0005],
  ["35", "Health Care", 0.09, -0.0006],
  ["20", "Industrials", 0.08, 0.0012],
  ["30", "Consumer Staples", 0.05, -0.0128],
  ["10", "Energy", 0.03, -0.0002],
  ["55", "Utilities", 0.025, -0.0039],
  ["60", "Real Estate", 0.02, -0.0068],
  ["15", "Materials", 0.02, -0.0073],
];

const NEW_MARKETS = [
  { code: "tw", zone: "Asia/Taipei", fund: "ITWN", universe: "MSCI Taiwan", names: /台股|Taiwan/, ids: ["taiex"], at: "2026-11-13T04:05:00Z" },
  { code: "in", zone: "Asia/Kolkata", fund: "NDIA", universe: "MSCI India", names: /印股|India/, ids: ["nifty-50", "sensex"], at: "2026-11-13T07:30:00Z" },
  { code: "ca", zone: "America/Toronto", fund: "CSCA", universe: "MSCI Canada", names: /加股|Canada/, ids: ["sp-tsx"], at: "2026-11-13T17:45:00Z" },
  { code: "au", zone: "Australia/Sydney", fund: "SAUS", universe: "MSCI Australia", names: /澳股|Australia/, ids: ["asx-200"], at: "2026-11-13T02:00:00Z" },
] as const;

const EUROPE_FIXTURE_TIME = Date.parse("2026-11-13T13:15:00Z");

function fixture(code = "us", now = Date.now()) {
  const open = new Date(code === "eu" && now === EUROPE_FIXTURE_TIME ? "2026-11-13T08:00:00Z" : now - 3 * 3600_000);
  const close = new Date(code === "eu" && now === EUROPE_FIXTURE_TIME ? "2026-11-13T16:30:00Z" : now + 3.5 * 3600_000);
  const day = open.toISOString().slice(0, 10);
  const times = Array.from({ length: code === "eu" && now === EUROPE_FIXTURE_TIME ? 64 : 36 },
    (_, index) => new Date(open.getTime() + index * 300_000).toISOString());
  const session = { date: day, open: open.toISOString(), close: close.toISOString(), breakStart: null, breakEnd: null };
  const europeWeights: Record<string, number> = {
    "40": 0.24, "20": 0.18, "35": 0.14, "30": 0.09, "45": 0.09, "10": 0.06,
    "25": 0.06, "15": 0.05, "55": 0.05, "50": 0.03, "60": 0.01,
  };
  const europeIndustries: Record<string, readonly [string, string]> = {
    "40": ["Banks", "Insurance"], "20": ["Capital Goods", "Transportation"],
    "35": ["Health Care Equipment & Services", "Pharmaceuticals, Biotechnology & Life Sciences"],
    "30": ["Consumer Staples Distribution & Retail", "Food, Beverage & Tobacco"],
    "45": ["Software & Services", "Semiconductors & Semiconductor Equipment"],
    "10": ["Energy Equipment & Services", "Oil, Gas & Consumable Fuels"],
    "25": ["Automobiles & Components", "Consumer Durables & Apparel"],
    "15": ["Materials", ""], "55": ["Utilities", ""],
    "50": ["Telecommunication Services", "Media & Entertainment"],
    "60": ["Equity Real Estate Investment Trusts (REITs)", "Real Estate Management & Development"],
  };
  const groups = SECTORS.map(([key, name, usWeight, change], index) => {
    const weight = code === "eu" ? europeWeights[key] : usWeight;
    const industries = code === "eu" ? europeIndustries[key] : ["Software & Services", "Semiconductors & Semiconductor Equipment"];
    const oneIndustry = !industries[1];
    const members = Array.from({ length: 6 }, (_, member) => ({
      symbol: "SYN" + key + member,
      name: "SYNTHETIC COMPANY " + key + member,
      // The last member has no industry group, so each sector also lists "Other".
      subgroup: member === 5 ? "" : key + (!oneIndustry && member % 2 ? "20" : "10"),
      change: change + (member - 2.5) * 0.004,
      weight: weight / 6,
      exposureGbp: member === 0 ? 1200 : 0,
      researchTicker: member === 0 ? "SYN" + key + member : null,
    }));
    return {
      key,
      name,
      nameZh: null,
      change,
      weight,
      breadth: { up: change > 0 ? 4 : 2, flat: 0, down: change > 0 ? 2 : 4 },
      memberCount: 6,
      leader: { symbol: members[5].symbol, name: members[5].name, change: members[5].change },
      path: times.map((_, step) => change * Math.sin(((step + 1) * 3) / times.length)),
      ranks: [index + 1, ((index + 3) % 11) + 1, ((index + 5) % 11) + 1, index < 3 ? 1 : 7, index + 1],
      streak: index === 0 ? 2 : 0,
      exposureGbp: 1200,
      subgroups: [
        ...industries.flatMap((name, i) => {
          if (!name) return [];
          const count = oneIndustry ? 5 : i === 0 ? 3 : 2;
          return [{
            key: key + (i + 1) * 10,
            name,
            change: change + (i === 0 ? 0.002 : -0.002),
            weight: weight * count / 6,
            breadth: { up: count - 1, flat: 0, down: 1 },
            memberCount: count,
            exposureGbp: i === 0 ? 1200 : 0,
          }];
        }),
        { key: "", name: "", change, weight: weight / 6, breadth: { up: 1, flat: 0, down: 0 }, memberCount: 1, exposureGbp: 0 },
      ],
      members,
    };
  });
  const market = (id: string, timezone: string) => ({
    market: id,
    calendar: "SYNTH",
    timezone,
    sessions: id === code ? [session] : [],
    sessionDate: id === code ? day : null,
    complete: false,
    asOf: id === code ? times.at(-1) : null,
    fetchedAt: id === code ? new Date(now).toISOString() : null,
    exposureGbp: 0,
    lastError: null,
    lastErrorAt: null,
  });
  return {
    market: code,
    markets: [market("us", "UTC"), market("uk", "Europe/London"), market("hk", "Asia/Hong_Kong"), market("kr", "Asia/Seoul"), market("jp", "Asia/Tokyo"), market("eu", "Europe/London"), ...NEW_MARKETS.map(({ code, zone }) => market(code, zone))],
    monitor: { enabled: true, phase: "idle", intervalSeconds: 600, nextRunAt: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null },
    board: {
      market: code,
      sessionDate: day,
      complete: false,
      asOf: times.at(-1),
      fetchedAt: new Date(now).toISOString(),
      times,
      rankSessions: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", day],
      memberCount: 66,
      pricedCount: 66,
      source: { universe: "Synthetic 66", fund: "Synthetic fund", fundTicker: "SYN", url: "https://example.invalid", asOf: day, prices: "Synthetic" },
      exposureGbp: 13200,
      exposureBasisGbp: 100000,
      groupings: [{ kind: "gics", groups }],
    },
  };
}

async function open(page: Page) {
  await page.route("**/api/backend/indices?**", async (route) => {
    const scope = new URL(route.request().url()).searchParams.get("scope") ?? "us";
    await route.fulfill({ json: { scope, quotes: [], refreshFailed: false } });
  });
  await page.route("**/api/backend/sectors**", async (route) => {
    const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
    // Hong Kong answers slowly, so a switch can be watched mid-flight.
    if (code === "hk") await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ json: fixture(code) });
  });
  await page.goto("/sectors?market=us");
}

async function selectMarket(page: Page, name: RegExp, extra = false) {
  const picker = page.getByRole("combobox", { name: /^(市场|Market)$/ });
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await picker.click();
    await page.getByRole("option", { name }).click();
  } else if (extra) {
    await page.getByRole("button", { name: /更多市场|More markets/ }).click();
    await page.getByRole("menuitem", { name }).click();
  } else {
    await page.getByRole("group", { name: /^(市场|Market)$/ }).getByRole("button", { name }).click();
  }
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}

test.describe("sector map", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");

  test("opens on the strongest sector and follows pointer and arrow keys", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await open(page);
    const map = page.getByRole("group", { name: /板块地图|sector map/ });
    await expect(map.locator(".mx-sector-block")).toHaveCount(11);
    const selected = map.locator('.mx-sector-block[aria-pressed="true"]');
    await expect(selected).toHaveAttribute("data-key", "45");
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/信息技术|Information Technology/);
    await selected.focus();
    await page.keyboard.press("ArrowRight");
    await expect(map.locator('.mx-sector-block[aria-pressed="true"]')).not.toHaveAttribute("data-key", "45");
    await expect(map.locator(".mx-sector-block:focus")).toHaveAttribute("aria-pressed", "true");
    await map.locator('[data-key="30"]').click();
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/日常消费品|Consumer Staples/);
    await expect(page).toHaveURL(/sector=30/);
    // A tile click opens its industry group in the detail.
    await map.locator('[data-key="45"] [data-subgroup="4510"]').click();
    await expect(page.locator('.mx-sector-subgroup[aria-expanded="true"]')).toHaveCount(1);
    // So does the "Other" tile, whose key is empty.
    await map.locator('[data-key="45"] [data-subgroup=""]').click();
    await expect(page.locator('.mx-sector-subgroup[aria-expanded="true"]')).toHaveText(/其他|Other/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await settle(page);
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  });

  test("a market switch never shows the previous board under the new name", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await open(page);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    await selectMarket(page, /港股|Hong Kong/, true);
    await expect(page).toHaveURL(/market=hk/);
    await expect(page.locator(".mx-sector-map")).toHaveCount(0);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /港股|Hong Kong/);
  });

  test("a failed refresh keeps the board on screen and says so", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    let served = 0;
    await page.route("**/api/backend/sectors**", async (route) => {
      served += 1;
      // The first answer arrives; every later refresh fails.
      if (served === 1) await route.fulfill({ json: fixture("us") });
      else await route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
    });
    await page.clock.install();
    await page.goto("/sectors?market=us");
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    // Selecting a sector names the market in the URL; the board it came from stays.
    await page.locator('.mx-sector-map [data-key="30"]').click();
    await expect(page).toHaveURL(/market=us/);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    // The next minute's refresh fails (with its one retry); the board stays and the clock says so.
    await page.clock.runFor(65_000);
    await page.clock.runFor(5_000);
    await expect(page.locator(".mx-sectors-clock")).toContainText(/刷新失败|Refresh failed/);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
  });

  test("a rejected market switch keeps the board on screen and offers a retry", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    let hongKongUp = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/sectors**", async (route) => {
      const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
      if (code === "hk" && !hongKongUp) await route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
      else {
        // Hong Kong's recovery is held back so the retry can be watched in flight.
        if (code === "hk") await held;
        await route.fulfill({ json: fixture(code) });
      }
    });
    await page.goto("/sectors?market=us");
    const markets = page.getByRole("group", { name: /市场|Market/ });
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    await selectMarket(page, /港股|Hong Kong/, true);
    const retry = page.locator(".mx-sectors-retry");
    await expect(retry).toBeVisible();
    // The US board stays, under its own name, and the switch says so.
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /美股|US/);
    await expect(markets.getByRole("button", { name: /美股|US/ })).toHaveAttribute("aria-pressed", "true");
    hongKongUp = true;
    await retry.click();
    // While the retry is in flight the fallback stays, and asking again waits for it.
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /美股|US/);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    release();
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /港股|Hong Kong/);
    await expect(retry).toHaveCount(0);
  });

  test("a fallback board ignores the failed market's sector on phones", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.route("**/api/backend/sectors**", async (route) => {
      const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
      if (code === "hk") await route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
      else await route.fulfill({ json: fixture(code) });
    });
    await page.goto("/sectors?market=us");
    const rows = page.locator(".mx-sector-list > li");
    await expect(rows).toHaveCount(11);
    // A link into a Hong Kong sector arrives while Hong Kong is unavailable.
    await page.evaluate(() => window.history.pushState(null, "", "/sectors?market=hk&sector=45"));
    await expect(page.locator(".mx-sectors-retry")).toBeVisible();
    // The US list stays, with the market switch, rather than opening a US sector under the link's name.
    await expect(page.locator(".mx-sector-detail")).toHaveCount(0);
    await expect(rows).toHaveCount(11);
    await expect(page.getByRole("combobox", { name: /^(市场|Market)$/ })).toHaveValue(/美股|US/);
  });

  test("phones read a ranked list and open a sector as its own step", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await open(page);
    const rows = page.locator(".mx-sector-list > li");
    await expect(rows).toHaveCount(11);
    await expect(rows.first()).toContainText(/信息技术|Information Technology/);
    await rows.first().getByRole("button").tap();
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/信息技术|Information Technology/);
    await expect(page.locator(".mx-sector-detail h2")).toBeFocused();
    await page.locator(".mx-sector-back").tap();
    await expect(rows).toHaveCount(11);
    await expect(rows.first().getByRole("button")).toBeFocused();
    // Forward reopens the sector, and the page's Back still returns to the list behind it.
    await page.goForward();
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/信息技术|Information Technology/);
    await page.locator(".mx-sector-back").tap();
    await expect(rows).toHaveCount(11);
    await expect(page).not.toHaveURL(/sector=/);
    // The browser's Back also returns focus to the row that opened the sector.
    await rows.nth(2).getByRole("button").tap();
    await expect(page.locator(".mx-sector-detail h2")).toBeFocused();
    await page.goBack();
    await expect(rows.nth(2).getByRole("button")).toBeFocused();
    // The focus target is spent: switching markets afterwards moves focus nowhere.
    await selectMarket(page, /英股|UK/);
    await expect(page.locator(".mx-sector-list button:focus")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.locator(".mx-sector-list button").evaluateAll((buttons) =>
      buttons.every((button) => button.getBoundingClientRect().height >= 44))).toBe(true);
  });
});

const fakeIndex = (
  id: string, scope: IndexIdentity["scope"], name: string, nameZh: string,
  symbol: string, currency: string | null, kind: IndexIdentity["kind"] = "index",
): IndexIdentity => ({
  id, scope, name, nameZh, symbol, currency, kind, compiler: "Synthetic fixture",
  compilerId: id, basis: kind === "volatility" ? "implied-volatility" : "price",
  calendar: "SYNTH", historyYears: 5, ranges: ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"], rights: "provider-terms", aliases: [],
  source: "Synthetic fixture",
});
const indices: IndexIdentity[] = [
  fakeIndex("sp-500", "us", "S&P 500", "标普 500", "^GSPC", "USD"),
  fakeIndex("nasdaq-100", "us", "Nasdaq 100", "纳斯达克 100", "^NDX", "USD"),
  fakeIndex("dow-jones", "us", "Dow Jones Industrial Average", "道琼斯工业平均指数", "^DJI", "USD"),
  fakeIndex("russell-2000", "us", "Russell 2000", "罗素 2000", "^RUT", "USD"),
  fakeIndex("vix", "us", "VIX", "VIX", "^VIX", null, "volatility"),
  fakeIndex("euro-stoxx-50", "eu", "EURO STOXX 50", "欧洲斯托克 50", "^SYN-STOXX50E", "EUR"),
  fakeIndex("stoxx-europe-600", "eu", "STOXX Europe 600", "斯托克欧洲 600", "^SYN-STOXX", "EUR"),
  fakeIndex("dax", "eu", "DAX", "德国 DAX", "^SYN-DAX", "EUR"),
  fakeIndex("cac-40", "eu", "CAC 40", "法国 CAC 40", "^SYN-CAC", "EUR"),
  fakeIndex("ftse-100", "uk", "FTSE 100", "富时 100", "^SYN-FTSE", "GBP"),
  fakeIndex("nikkei-225", "jp", "Nikkei 225", "日经 225", "^N225", "JPY"),
  fakeIndex("topix", "jp", "TOPIX ETF price", "TOPIX ETF 价格", "1306.T", "JPY", "etf-price"),
  fakeIndex("hang-seng", "hk", "Hang Seng", "恒生指数", "^SYN-HSI", "HKD"),
  fakeIndex("kospi", "kr", "KOSPI", "韩国综合指数", "^SYN-KS", "KRW"),
  fakeIndex("msci-world", "global", "MSCI World", "MSCI 世界", "^SYN-WORLD", "USD"),
  fakeIndex("msci-acwi", "global", "MSCI ACWI", "MSCI 全球", "^SYN-ACWI", "USD"),
  fakeIndex("msci-world-ex-usa", "global", "MSCI World ex USA", "MSCI 世界（除美国）", "^SYN-WORLD-XUS", "USD"),
  fakeIndex("msci-em", "global", "MSCI Emerging Markets", "MSCI 新兴市场", "^SYN-EM", "USD"),
  fakeIndex("msci-em-imi", "global", "MSCI Emerging Markets IMI", "MSCI 新兴市场 IMI", "^SYN-IMI", "USD"),
  fakeIndex("ftse-all-world-etf", "global", "FTSE All-World ETF price", "富时全球 ETF 价格", "SYN.L", "GBP", "etf-price"),
  { ...fakeIndex("ftse-all-world", "global", "FTSE All-World", "富时全球指数", "", "USD"), symbol: null, rights: "licensed-source-required" },
  { ...fakeIndex("csi-300", "cn", "CSI 300", "沪深 300", "000300.SS", "CNY"), historyYears: 0, ranges: ["1D", "1W", "1M"] },
  fakeIndex("sse-composite", "cn", "SSE Composite Index", "上证指数", "000001.SS", "CNY"),
  fakeIndex("shenzhen-component", "cn", "Shenzhen Component Index", "深证成指", "399001.SZ", "CNY"),
  { ...fakeIndex("chinext", "cn", "ChiNext Index", "创业板指", "399006.SZ", "CNY"), historyYears: 0, ranges: ["1D", "1W", "1M"] },
  fakeIndex("taiex", "tw", "TAIEX", "台湾加权指数", "^SYN-TWII", "TWD"),
  fakeIndex("nifty-50", "in", "Nifty 50", "印度 Nifty 50", "^SYN-NSEI", "INR"),
  fakeIndex("sensex", "in", "SENSEX", "印度 SENSEX", "^SYN-BSESN", "INR"),
  fakeIndex("sp-tsx", "ca", "S&P/TSX Composite", "标普多伦多综合指数", "^SYN-GSPTSE", "CAD"),
  fakeIndex("asx-200", "au", "S&P/ASX 200", "标普澳洲 200", "^SYN-AXJO", "AUD"),
  fakeIndex("smi", "ch", "SMI", "瑞士市场指数", "^SYN-SMI", "CHF"),
];

const globalFixture: GlobalMarketContribution = {
  acwiMove: -0.0044, acwiLevel: 1116.27, phase: "completed", referenceDate: "2026-11-12", asOf: "2026-11-12T19:00:00Z", weightsAsOf: "2026-11-11",
  weightsStale: false, pricesStale: false, state: "partial", residual: -0.0018,
  markets: [{ market: "us", move: -0.0035, notOpen: false }, { market: "jp", move: -0.007, notOpen: false }, { market: "ch", move: null, notOpen: false }, { market: "uk", move: 0, notOpen: true }, { market: "au", move: 0.0003, notOpen: false }, { market: "kr", move: 0.001, notOpen: false }],
  rows: [
    { market: "us", indexId: "sp-500", weight: 0.63, move: -0.0035, contribution: -0.0022, notOpen: false },
    { market: "jp", indexId: "nikkei-225", weight: 0.057, move: -0.007, contribution: -0.0004, notOpen: false },
    { market: "uk", indexId: "ftse-100", weight: 0.03, move: 0, contribution: 0, notOpen: true },
  ],
};

const chinaGlobal: GlobalMarketContribution = {
  ...globalFixture,
  otherWeight: 0.115,
  markets: ([
    ["us", 0.63, -0.0035], ["jp", 0.057, -0.007], ["eu", 0.07, 0.0075],
    ["uk", 0.034, 0], ["ca", 0.028, -0.0037], ["cn", 0.023, -0.0123],
    ["tw", 0.02, 0.0081], ["ch", 0.02, -0.0042], ["au", 0.018, 0.0003],
    ["in", 0.015, 0.0038], ["kr", 0.012, 0.001], ["hk", 0.009, 0.0088],
  ] as const).map(([market, weight, move]) => ({ market, weight, move, notOpen: market === "uk" })),
};

const depthFixture: Pick<IndexContext, "breadthHistory" | "vix" | "valuation" | "valuationReference"> = {
  breadthHistory: {
    fund: "SYN", holdingsUrl: "https://example.invalid/fund",
    holdingsAsOf: "2026-11-11", holdingsFetchedAt: "2026-11-12T10:00:00Z",
    pricesSource: "Synthetic quotes", pricesFetchedAt: "2026-11-12T22:01:00Z",
    asOf: "2026-11-12", calculatedAt: "2026-11-12T22:02:00Z", members: 503,
    points: Array.from({ length: 345 }, (_, i) => {
      const day = new Date(Date.UTC(2025, 11, 3 + i));
      const above50 = 0.56 + Math.sin(i * 0.075) * 0.16 + Math.sin(i * 1.35) * 0.035;
      const above200 = 0.59 + Math.sin(i * 0.045 + 2) * 0.14 + Math.cos(i * 0.42) * 0.016;
      return { date: day.toISOString().slice(0, 10), above50: i === 120 ? null : above50, above200,
        eligible50: i === 120 ? 201 : 500, eligible200: 488 };
    }).filter(({ date }) => ![0, 6].includes(new Date(date).getUTCDay())),
  },
  vix: {
    source: "Synthetic quotes", asOf: "2026-11-12", fetchedAt: "2026-11-12T22:01:00Z",
    sampleStart: "2021-11-12", sampleEnd: "2026-11-11", sampleSize: 1253,
    close: 18.37, percentile: 0.58, p10: 12.71, p90: 27.84,
  },
  valuationReference: { source: "Synthetic issuer", sourceUrl: "https://example.invalid/valuation", basis: "etf" },
  valuation: {
    source: "Synthetic issuer", sourceUrl: "https://example.invalid/valuation", basis: "etf",
    asOf: "2026-10-30", fetchedAt: "2026-11-01T13:00:00Z", pe: 26.52, forwardPe: 22.4,
  },
};

async function mockIndices(page: Page, { fail = false, now = Date.now(), global = globalFixture }:
  { fail?: boolean; now?: number; global?: GlobalMarketContribution } = {}) {
  const base = now - 3600_000;
  const europeLevels: Record<string, number> = {
    "euro-stoxx-50": 5700, "stoxx-europe-600": 590, dax: 23900, "cac-40": 8100,
  };
  const chinaLevels: Record<string, [number, number]> = {
    "csi-300": [4600, -0.0123], "sse-composite": [3700, 0.0042],
    "shenzhen-component": [11500, -0.0088], chinext: [2650, 0.0161],
  };
  const point = (index: IndexIdentity, n: number, interval: number) => ({
    at: new Date(base - (24 - n) * interval).toISOString(),
    value: index.kind === "volatility" ? 16.1 - n * 0.04 + Math.sin(n * 0.4) * 0.2
      : index.scope === "eu" ? europeLevels[index.id] * (1 + n * 0.0004 + Math.sin(n * 0.9) * 0.002)
      : index.scope === "jp" ? (index.kind === "etf-price" ? 2870 - n * 3 : 39700 + n * 17)
      : index.scope === "cn" ? chinaLevels[index.id][0] * (1 + chinaLevels[index.id][1] * n / 24 + Math.sin(n * 0.6) * 0.003)
      : (index.id === "nasdaq-100" ? 24200 + n * 23 + Math.sin(n * 0.55) * 130
        : index.id === "dow-jones" ? 46000 + n * 17 + Math.sin(n * 0.33) * 120
        : index.id === "russell-2000" ? 2300 - n * 3 + Math.sin(n * 0.5) * 9
        : 6800 + n * 7 + Math.sin(n * 0.9) * 25),
  });
  await page.route("**/api/backend/indices**", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/");
    if (parts.at(-1) === "global-sectors") return route.fulfill({ json: worldFixture });
    if (parts.at(-1) === "global-contribution") return route.fulfill({ json: global });
    if (parts.at(-1) === "catalog") return route.fulfill({ json: indices });
    if (parts.at(-1) === "history") {
      const index = indices.find((item) => item.id === parts.at(-2));
      if (!index) return route.fulfill({ status: 404, json: {} });
      const range = url.searchParams.get("range") ?? "1Y";
      const interval = ({ "1D": 300_000, "1W": 1_800_000, "1M": 3_600_000, MAX: 604_800_000 } as Record<string, number>)[range] ?? 86_400_000;
      const points = Array.from({ length: 25 }, (_, n) => point(index, n, interval));
      return route.fulfill({ json: {
        index, range, points, gaps: [], maxDrawdown: -0.13, volatility: 0.21,
        currency: url.searchParams.get("currency") === "GBP" ? "GBP" : index.currency,
        state: "available", asOf: points.at(-1)?.at,
      } });
    }
    if (parts.at(-1) === "context") {
      const id = parts.at(-2);
      const useBasket = id === "sp-500";
      const proxy = id === "hang-seng" ? "Synthetic MSCI Hong Kong basket" : id === "kospi" ? "Synthetic MSCI Korea basket" : null;
      const sample = { key: "SYN", name: "Synthetic company", weight: 0.10, contribution: 0.0022 };
      if (proxy) return route.fulfill({ json: {
        funds: [], basket: { fund: "SYN", proxyUniverse: proxy, holdingsDate: "2026-11-11",
          sessionDate: "2026-11-12", asOf: null, estimatedMove: null, residual: null,
          breadth: { up: 0, flat: 0, down: 0 }, coverage: 0,
          leaders: [], laggards: [], topHoldings: [{ ...sample, contribution: null }], sectors: [] },
      } });
      return route.fulfill({ json: useBasket ? {
        ...depthFixture,
        basket: {
          fund: "SYN", holdingsDate: "2026-11-11", sessionDate: "2026-11-12", asOf: new Date(base).toISOString(),
          coverage: 0.89, breadth: { up: 45, flat: 5, down: 19 },
          leaders: [sample], laggards: [{ ...sample, key: "SYNB", name: "Synthetic industry", contribution: -0.001 }],
          topHoldings: [sample], sectors: [sample], estimatedMove: 0.012, residual: 0.0001,
        },
        funds: [{ isin: "ZZ0000000001", ticker: "SYNA", name: "Synthetic index fund", shares: 5, valueGbp: 120 }],
        exposureGbp: 120, portfolioAsOf: new Date(base).toISOString(),
      } : { basket: null, funds: [], ...(id === "nasdaq-100" ? { valuationReference: depthFixture.valuationReference } : {}) } });
    }
    if (fail) return route.fulfill({ status: 503, json: {} });
    const scope = url.searchParams.get("scope") ?? "us";
    return route.fulfill({ json: {
      scope, refreshFailed: false,
      quotes: indices.filter((index) => index.scope === scope).map((index, n) => {
        const points = Array.from({ length: 25 }, (_, i) => point(index, i, 300_000));
        return {
          index, points, asOf: points.at(-1)?.at, sessionDate: new Date(base).toISOString().slice(0, 10),
          level: points.at(-1)?.value, change: index.kind === "volatility" ? -0.9 : chinaLevels[index.id]?.[1] ?? [0.0134, 0.0161, 0.0088, -0.0042][n],
          state: index.id === "msci-em-imi" ? "stale" : index.id === "ftse-all-world-etf" ? "unavailable" : "live",
        };
      }),
    } });
  });
  await page.route("**/api/backend/sectors**", async (route) => {
    const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
    const response = fixture(code, now);
    if (code === "eu") {
      response.board.source = { ...response.board.source, universe: "Synthetic MSCI Europe" };
    } else if (code === "jp") {
      response.board.source = { ...response.board.source, fundTicker: "IJPN", universe: "MSCI Japan" };
    }
    const market = NEW_MARKETS.find((item) => item.code === code);
    if (market) response.board.source = { ...response.board.source, fundTicker: market.fund, universe: market.universe };
    await route.fulfill({ json: response });
  });
}

const worldFixture: GlobalSectorBoard = {
  referenceDate: "2026-11-12",
  phase: "completed",
  asOf: "2026-11-12T19:00:00Z",
  acwiMove: -0.0044,
  acwiLevel: 1000,
  weightsAsOf: "2026-11-11",
  weightsStale: false, pricesStale: false,
  rankSessions: ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"],
  exposureBasisGbp: 100_000,
  sectors: SECTORS.map(([gics, name, weight, move], i) => ({
    gics, name, weight, indexCode: 100 + i,
    move: gics === "60" ? null : move,
    contribution: gics === "60" ? null : weight * move,
    intraday: gics === "60" ? [] : Array.from({ length: 25 }, (_, step) => ({
      at: new Date(Date.UTC(2026, 10, 12, 17, step * 5)).toISOString(),
      move: move * Math.sin((step + 1) / 15),
    })),
    ranks: gics === "60" ? [] : [1, 3, 3, 1, i + 1],
    groups: [
      { gics: gics + "10", name: "Synthetic Industry", move, indexCode: 200 + i },
    ],
    holdings: [{ name: "Synthetic Constituent", weight: weight / 3 }],
    exposureGbp: 1250,
  })),
};

test.describe("market index layer", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");

  test("China A has four index cards and no sector board", async ({ page }, { project }) => {
    const mobile = project.name === "mobile";
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockIndices(page, { global: chinaGlobal });
    const paths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/backend/")) paths.push(url.pathname + url.search);
    });
    await page.goto("/sectors");
    await expect(page.locator(".mx-global-benchmark a")).toHaveCount(6);
    expect(paths).not.toContain("/api/backend/indices?scope=cn");
    await selectMarket(page, /A 股|China A/, true);
    await expect(page).toHaveURL(/\/sectors\?market=cn$/);
    const cards = page.locator(".mx-index-cards a");
    await expect(cards).toHaveCount(4);
    await expect(cards.first()).toHaveAccessibleName(/沪深 300|CSI 300/);
    await expect(cards.last()).toHaveAccessibleName(/创业板指|ChiNext/);
    await expect(page.locator(".mx-sector-list, .mx-sector-block")).toHaveCount(0);
    await expect(page.getByText(/板块数据|sector data yet/)).toHaveCount(0);
    expect(paths).not.toContain("/api/backend/sectors?market=cn");

    const folder = process.env.TM_CN_VISUAL_DIR;
    if (folder) await page.screenshot({ path: path.join(folder, `china-a-${mobile ? 390 : 1440}.png`) });
    await cards.first().click();
    await expect(page).toHaveURL(/market=cn&index=csi-300/);
    await expect(page.getByRole("heading", { name: /沪深 300|CSI 300/ })).toBeFocused();
    const ranges = page.getByRole("group", { name: /时间范围|Range/ });
    await expect(ranges.getByRole("button", { name: "1M" })).toBeVisible();
    await expect(ranges.getByRole("button", { name: "1Y" })).toHaveCount(0);
    await page.goto("/sectors?market=cn");
    await expect(cards).toHaveCount(4);
    expect(paths).not.toContain("/api/backend/sectors?market=cn");
  });

  test("China map region names the CSI 300 and opens its market", async ({ page }, { project }) => {
    const mobile = project.name === "mobile";
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockIndices(page, { global: chinaGlobal });
    await page.goto("/sectors");
    const map = page.getByRole("group", { name: /全球市场地图|World market map/ });
    const china = map.getByRole("link", { name: /中国.*沪深 300.*1.23|China.*CSI 300.*1.23/ });
    await expect(china.locator(".mx-global-shape")).toBeVisible();
    await expect(map.locator('[data-market="tw"] .mx-global-shape')).toBeVisible();
    const folder = process.env.TM_CN_VISUAL_DIR;
    if (folder && mobile) await page.locator(".mx-global-map").screenshot({ path: path.join(folder, "global-map-390.png") });
    const hit = china.locator(`.mx-global-label-${mobile ? "phone" : "desktop"} .mx-global-hit`);
    if (mobile) await hit.tap();
    else await hit.hover();
    const inspection = page.locator("#mx-global-inspection");
    await expect(china).toHaveAttribute("data-linked", "true");
    await expect(inspection).toContainText(/沪深 300.*1.23|CSI 300.*1.23/);
    await expect(inspection).toContainText(/计入新兴市场|Included in emerging markets/);
    if (folder && !mobile) await page.locator(".mx-global-map").screenshot({ path: path.join(folder, "global-map-1440.png") });
    await inspection.getByRole("link", { name: /打开市场|Open market/ }).click();
    await expect(page).toHaveURL(/\/sectors\?market=cn$/);
    await expect(page.locator("#index-card-csi-300")).toBeVisible();
  });

  test("Overview shows the China tile and names the CSI 300", async ({ page }, { project }) => {
    const mobile = project.name === "mobile";
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const colorScheme = mobile ? "dark" : "light";
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await mockIndices(page, { global: chinaGlobal });
    await page.goto("/");
    const card = page.locator(".mx-overview-sectors");
    const picker = card.getByRole("button", { name: /选择市场|Choose market/ });
    await picker.click();
    await expect(page.getByRole("menuitem", { name: /A 股|China A/ })).toHaveCount(0);
    await page.getByRole("menuitem", { name: /^(全球|Global)$/ }).click();
    const board = card.locator(mobile ? ".mx-overview-world" : ".mx-overview-world-map");
    const china = board.getByRole("link", { name: /中国.*沪深 300.*1.23|China.*CSI 300.*1.23/ });
    await expect(china).toHaveAttribute("href", "/sectors?market=cn");
    await expect(china).toHaveAttribute("data-tone", "down");
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", colorScheme);
    if (!mobile) {
      await expect(china).toHaveAccessibleName(/2.3%/);
      await china.hover();
      await expect(page.getByRole("tooltip")).toContainText(/沪深 300|CSI 300/);
    }
    const folder = process.env.TM_CN_VISUAL_DIR;
    if (folder) await card.screenshot({ path: path.join(folder, `overview-world-${mobile ? 390 : 1440}-${colorScheme}.png`) });
    await china.click();
    await expect(page).toHaveURL(/\/sectors\?market=cn$/);
  });

  test("opens Japan index history and returns focus to its card", async ({ page }, testInfo) => {
    await mockIndices(page);
    await page.goto("/sectors");
    await selectMarket(page, /日股|Japan|^JP$/);
    const card = page.getByRole("link", { name: /日经 225|Nikkei 225/ });
    await expect(page.getByRole("link", { name: /TOPIX ETF/ })).toBeVisible();
    await expect(page.getByText(/板块篮子：MSCI Japan|Sector basket: MSCI Japan/)).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(/market=jp&index=nikkei-225/);
    await expect(page).toHaveTitle("市场 · Trading Max");
    await expect(page.getByRole("heading", { name: /日经 225|Nikkei 225/ })).toBeFocused();
    await page.getByRole("button", { name: "5Y", exact: true }).click();
    await expect(page).toHaveURL(/range=5Y/);
    await page.getByRole("button", { name: "GBP", exact: true }).click();
    await expect(page).toHaveURL(/currency=GBP/);
    if (testInfo.project.name === "mobile") await expect(page.locator(".mx-index-cards")).toHaveCount(0);
    await page.locator(".mx-sector-back").click();
    await expect(page).toHaveURL(/sectors\?market=jp$/);
    await expect(card).toBeFocused();
  });

  test("Europe shows four index cards and its own sector board", async ({ page }, testInfo) => {
    await mockIndices(page);
    await page.goto("/sectors");
    const received = page.waitForResponse((response) => response.url().endsWith("/api/backend/sectors?market=eu"));
    await selectMarket(page, /欧洲|Europe/);
    await received;
    await expect(page).toHaveURL(/market=eu$/);
    await expect(page.locator(".mx-index-cards a")).toHaveCount(4);
    await expect(page.locator("#index-card-stoxx-europe-600")).toBeVisible();
    await expect(page.locator(".mx-sectors-clock")).toContainText(/盘中|Open/);
    await expect(page.getByRole("button", { name: /我的主题|My themes/ })).toHaveCount(0);

    const detail = page.locator(".mx-sector-detail");
    const rows = page.locator(".mx-sector-list > li");
    if (testInfo.project.name === "mobile") {
      await expect(rows).toHaveCount(11);
      await rows.first().getByRole("button").tap();
      await expect(page).toHaveURL(/market=eu&sector=45/);
      await expect(detail.getByRole("heading", { level: 2 })).toBeFocused();
      await expect(page.locator(".mx-index-cards")).toHaveCount(0);
    } else {
      const map = page.getByRole("group", { name: /欧洲板块地图|Europe sector map/ });
      await expect(map.locator(".mx-sector-block")).toHaveCount(11);
      await map.locator('[data-key="45"] [data-subgroup="4510"]').click();
      await expect(detail.locator('.mx-sector-subgroup[aria-expanded="true"]')).toHaveCount(1);
    }
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(/信息技术|Information Technology/);
    await expect(detail.locator(".mx-sector-spark-line")).toBeVisible();
    await expect(detail.locator(".mx-sector-breadth-detail")).toBeVisible();
    await expect(detail.locator(".mx-sector-leader")).toContainText("SYN455");
    await expect(detail.locator(".mx-sector-ranks li")).toHaveCount(5);
    await expect(detail).toContainText("£1,200");
    if (testInfo.project.name === "mobile") {
      await page.locator(".mx-sector-back").tap();
      await expect(page).toHaveURL(/market=eu$/);
      await expect(rows.first().getByRole("button")).toBeFocused();
    }
  });

  test("an empty Europe board keeps its index cards visible", async ({ page }) => {
    await mockIndices(page);
    await page.route("**/api/backend/sectors?market=eu", (route) => {
      const data = fixture("eu");
      return route.fulfill({ json: { ...data, board: null } });
    });
    await page.goto("/sectors?market=eu");
    await expect(page.locator(".mx-index-cards a")).toHaveCount(4);
    await expect(page.getByRole("heading", { name: /还没有欧洲板块数据|No Europe sector data yet/ })).toBeVisible();
  });

  test("shows sectors through index errors and opens a shared index URL", async ({ page }) => {
    await mockIndices(page, { fail: true });
    await page.goto("/sectors?market=us");
    await expect(page.locator(".mx-index-strip")).toContainText(/暂时无法读取指数|Indices are unavailable/);
    await expect(page.locator(".mx-sector-block:visible, .mx-sector-list button:visible").first()).toBeVisible();
    await page.goto("/sectors?market=us&index=sp-500&range=MAX&compare=nasdaq-100");
    await expect(page.getByRole("heading", { name: /标普 500|S&P 500/ })).toBeVisible();
    await expect(page.locator(".mx-index-legend")).toContainText(/起点归 100|Rebased to 100/);
    await expect(page.getByRole("heading", { name: /^(成分篮子|Constituent basket) · SYN$/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "SYNA" })).toBeVisible();
  });

  test("opens index-only markets without a sector board request", async ({ page }) => {
    await mockIndices(page);
    let requests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/backend/sectors") requests += 1;
    });
    await page.goto("/sectors?market=global");
    await expect(page.locator("#index-card-msci-world")).toBeVisible();
    await selectMarket(page, /瑞士|Switzerland/, true);
    await expect(page).toHaveURL(/market=ch/);
    await page.getByRole("link", { name: /瑞士市场指数|SMI/ }).click();
    await expect(page).toHaveURL(/market=ch&index=smi/);
    await expect(page.getByRole("heading", { name: /瑞士市场指数|SMI/ })).toBeVisible();
    expect(requests).toBe(0);
  });

  test("Global groups benchmarks and links the map to contribution rows", async ({ page }, testInfo) => {
    await mockIndices(page);
    await page.goto("/sectors?market=global");
    const benchmarks = page.locator(".mx-global-benchmark");
    await expect(benchmarks).toHaveCount(3);
    await expect(benchmarks.getByRole("link")).toHaveCount(6);
    await expect(page.locator("#index-card-ftse-all-world")).toHaveCount(0);
    const map = page.getByRole("group", { name: /全球市场地图|World market map/ });
    const shape = map.getByRole("link", { name: /日本.*0.7.*0.04 pp|Japan.*0.7.*0.04 pp/ });
    const panel = page.getByRole("region", { name: /对 MSCI 全球的贡献|Contribution to MSCI ACWI/ });
    const ranking = panel.locator(".mx-global-ranking");
    const row = ranking.getByRole("link", { name: /日本.*0.7.*0.04 pp|Japan.*0.7.*0.04 pp/ });
    await expect(ranking).toContainText(/部分报价不可用|Partial quote coverage/);
    await expect(ranking).toContainText(/汇率与其他|Currency and other/);
    await expect(page.locator(".mx-index-global .mx-index-stamp")).toContainText(/已收盘|Closed/);
    // A finished day is named by its MSCI date alone; the publication clock is another day's in London.
    await expect(page.locator('.mx-index-global time[datetime="2026-11-12"]')).toHaveText(/^(11月12日|12 Nov)$/);
    await expect(ranking.getByRole("link", { name: /英国.*未开盘.*0.00 pp|UK.*Not open.*0.00 pp/ })).toBeVisible();
    await expect(map.getByRole("link", { name: /英国.*未开盘|UK.*Not open/ })).toHaveAttribute("data-neutral", "true");
    await expect(ranking.locator(".mx-global-total")).toContainText("-0.44%");
    if (testInfo.project.name === "desktop") {
      await row.hover();
      await expect(shape).toHaveAttribute("data-linked", "true");
      await expect(shape.locator(".mx-global-shape")).toHaveCSS("stroke-width", "1.5px");
      await shape.locator(".mx-global-label-desktop .mx-global-hit").hover();
      await expect(page.locator("#mx-global-inspection")).toContainText(/日经 225|Nikkei 225/);
      await expect(row).toHaveAttribute("data-linked", "true");
      await page.mouse.move(1, 1);
      await shape.focus();
      await page.keyboard.press("Tab");
      await expect(page.locator("#mx-global-inspection a")).toBeFocused();
      await page.keyboard.press("Escape");
    } else {
      const mapBox = await map.boundingBox();
      const rankingBox = await ranking.boundingBox();
      const leadBox = await panel.locator(".mx-global-lead").boundingBox();
      const dockBox = await page.locator(".mx-mobile-dock").boundingBox();
      expect(mapBox && rankingBox && mapBox.y + mapBox.height <= rankingBox.y + 1).toBe(true);
      expect(leadBox && dockBox && leadBox.y + leadBox.height < dockBox.y).toBe(true);
      expect(await row.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await expect(page.locator("#index-card-msci-em-imi .mx-index-freshness")).toBeVisible();
      await expect(page.locator("#index-card-ftse-all-world-etf .mx-index-freshness")).toBeVisible();
    }
    await panel.getByRole("button", { name: /对 MSCI 全球的贡献说明|Contribution to MSCI ACWI explained/ }).click();
    await expect(page.getByText(/权重来自 iShares|Weights come from iShares/)).toBeVisible();
    await page.keyboard.press("Escape");
    const inspect = async (market: string) => {
      const marker = map.locator(`a[data-market="${market}"]`);
      const hit = marker.locator(".mx-global-label-phone .mx-global-hit");
      if (testInfo.project.name === "desktop") await marker.focus();
      else await hit.tap();
      return page.locator("#mx-global-inspection");
    };
    for (const [market, text] of [
      ["uk", /未开盘|Not open/], ["au", /持平|Flat/],
      ["ch", /无报价|No quote/], ["kr", /计入新兴市场|Included in emerging markets/],
    ] as const) {
      const card = await inspect(market);
      await expect(card).toContainText(text);
      if (testInfo.project.name === "desktop") await page.keyboard.press("Escape");
      else await panel.getByRole("heading", { name: /对 MSCI 全球的贡献|Contribution to MSCI ACWI/ }).tap();
      await expect(card).toBeHidden();
    }
    const inspection = await inspect("jp");
    await expect(inspection).toContainText(/0.04 pp/);
    await expect(page).toHaveURL(/market=global/);
    await inspection.getByRole("link", { name: /打开市场|Open market/ }).click();
    await expect(page).toHaveURL(/market=jp/);
  });

  test("Global labels retained quotes and distinguishes missing data from pre-open", async ({ page }) => {
    await mockIndices(page, { global: {
      ...globalFixture, pricesStale: true,
      markets: [{ market: "us", move: -0.0035, notOpen: false },
        { market: "uk", move: 0, notOpen: true },
        { market: "ch", move: null, notOpen: false }],
    } });
    await page.goto("/sectors?market=global");
    const map = page.getByTestId("global-map");
    await expect(map.getByRole("link", { name: /瑞士.*无报价|Switzerland.*No quote/ })).toBeVisible();
    await expect(map.getByRole("link", { name: /台湾.*无报价|Taiwan.*No quote/ })).toBeVisible();
    await expect(map.getByRole("link", { name: /英国.*未开盘|UK.*Not open/ })).toBeVisible();
    await expect(page.locator(".mx-global-caveats")).toContainText(/报价未更新|Quotes haven’t updated/);
    await expect(page.locator("#index-card-msci-acwi .mx-index-freshness")).toContainText(/未更新|Stale/);
  });

  test("the desktop demo serves only its seeded Europe sector data", async ({ page }) => {
    const demo = process.env.DESKTOP_DEMO_QA_URL;
    test.skip(!demo?.startsWith("http://127.0.0.1:"), "Requires the isolated desktop demo.");
    // The portable seed is tested separately; this isolates the demo presentation.
    await page.route("**/api/backend/sectors?market=eu", (route) => route.fulfill({ json: fixture("eu") }));
    await page.goto(new URL("/desktop/sectors?market=eu", demo).href);
    await expect(page.locator(".mx-sector-block:visible, .mx-sector-list button:visible").first()).toBeVisible();
    await expect(page.locator(".mx-index-cards")).toHaveCount(0);
    await page.getByRole("button", { name: /板块数据来源|Sector data sources/ }).click();
    await expect(page.getByText(/均为演示数据|are synthetic/)).toBeVisible();
  });

  test("Markets defaults to Global and the sector switch persists in the URL", async ({ page }, testInfo) => {
    await mockIndices(page);
    await page.goto("/sectors");
    const view = page.getByRole("group", { name: /全球视图|Global view/ });
    const regions = view.getByRole("button", { name: /地区|Regions/ });
    const sectors = view.getByRole("button", { name: /行业|Sectors/ });
    await expect(regions).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("group", { name: /全球市场地图|World market map/ })).toBeVisible();
    await sectors.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sectors\?view=sectors$/);
    await expect(sectors).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mx-global-benchmark")).toHaveCount(3);
    await expect(page.locator(".mx-index-global time")).toHaveAttribute("datetime", "2026-11-12");
    await page.reload();
    await expect(sectors).toHaveAttribute("aria-pressed", "true");

    if (testInfo.project.name === "desktop") {
      const map = page.getByRole("group", { name: /全球板块地图|Global sector map/ });
      await expect(map.getByRole("button")).toHaveCount(11);
      const noQuote = map.getByRole("button", { name: /房地产.*无报价|Real Estate.*No quote/ });
      await expect(noQuote).toHaveAttribute("data-tone", "flat");
      await expect(noQuote).toHaveCSS("--mx-heat-mix", "0%");
      await expect(map.locator(".mx-sector-tile")).toHaveCount(0);
      const active = map.locator('[aria-pressed="true"]');
      await expect(active).toHaveAttribute("data-key", "45");
      await active.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page).toHaveURL(/view=sectors.*sector=/);
      await expect(active).not.toHaveAttribute("data-key", "45");
      await expect(active).toBeFocused();
    } else {
      const rows = page.locator(".mx-sector-list button");
      await expect(rows).toHaveCount(11);
      const row = page.locator('.mx-sector-list button[data-key="60"]');
      await row.scrollIntoViewIfNeeded();
      const scroll = await page.evaluate(() => window.scrollY);
      expect(scroll).toBeGreaterThan(0);
      await row.click();
      await expect(page).toHaveURL(/view=sectors.*sector=60/);
      await expect(page.getByRole("heading", { name: /房地产|Real Estate/ })).toBeFocused();
      await expect(page.locator(".mx-sector-detail")).toContainText(/无报价|No quote/);
      await expect(page.locator(".mx-global-benchmark")).toHaveCount(0);
      await page.locator(".mx-sector-back").click();
      await expect(page).toHaveURL(/\/sectors\?view=sectors$/);
      await expect(row).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
    }
    await regions.click();
    await expect(page).not.toHaveURL(/view=sectors/);

    for (const [market, indexCard] of [["eu", "stoxx-europe-600"], ["us", "sp-500"]]) {
      const direct = `/sectors?market=${market}`;
      const board = page.waitForResponse((response) => response.url().endsWith(`/api/backend/sectors?market=${market}`));
      await page.goto(direct);
      expect((await board).ok()).toBe(true);
      await expect(page).toHaveURL(direct);
      await expect(view).toHaveCount(0);
      await expect(page.locator(`#index-card-${indexCard}`)).toBeVisible();
      await expect(page.locator(".mx-sector-block:visible, .mx-sector-list button:visible")).toHaveCount(11);
    }
  });

  test("Global discloses the desktop demo’s missing quote data", async ({ page }) => {
    const demo = process.env.DESKTOP_DEMO_QA_URL;
    test.skip(!demo?.startsWith("http://127.0.0.1:"), "Requires the isolated desktop demo.");
    await page.goto(new URL("/desktop/sectors", demo).href);
    await expect(page.getByRole("heading", { name: /演示不包含全球行情|Global quotes aren’t included in the demo/ })).toBeVisible();
    await expect(page.locator(".mx-global-rows")).toHaveCount(0);
    await page.getByRole("group", { name: /全球视图|Global view/ }).getByRole("button", { name: /行业|Sectors/ }).click();
    await expect(page).toHaveURL(/\/desktop\/sectors\?view=sectors$/);
    await expect(page.getByRole("heading", { name: /演示不包含全球行业行情|Global sector quotes aren’t included in the demo/ })).toBeVisible();
  });

  test("research can open an index by its provider ticker", async ({ page }) => {
    await mockIndices(page);
    await page.goto("/research");
    await page.getByRole("button", { name: /添加证券|Add security/ }).first().click();
    await page.getByRole("textbox", { name: /搜索证券|Search securities/ }).fill("^GSPC");
    await page.getByRole("link", { name: /标普 500|S&P 500/ }).click();
    await expect(page).toHaveURL(/sectors\?market=us&index=sp-500/);
    await expect(page.getByRole("heading", { name: /标普 500|S&P 500/ })).toBeVisible();
  });

  for (const market of NEW_MARKETS) {
    test(`${market.code} opens its index cards and sector board`, async ({ page }, testInfo) => {
      const mobile = testInfo.project.name === "mobile";
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      const now = Date.parse(market.at);
      await page.clock.setFixedTime(now);
      await mockIndices(page, { now });
      await page.goto("/sectors");
      if (mobile) {
        const picker = page.getByRole("combobox", { name: /^(市场|Market)$/ });
        await picker.fill("zzzz");
        await expect(page.getByText(/没有匹配的市场|No matching market/)).toBeVisible();
        await picker.clear();
        await page.getByRole("option", { name: market.names }).click();
      } else {
        await page.getByRole("button", { name: /更多市场|More markets/ }).click();
        await expect(page.getByText(market.code === "ca" ? /^(美洲|Americas)$/ : /^(亚太|Asia Pacific)$/)).toBeVisible();
        await page.getByRole("menuitem", { name: market.names }).click();
      }
      await expect(page).toHaveURL(new RegExp(`market=${market.code}$`));
      await expect(page.locator(".mx-index-cards a")).toHaveCount(market.ids.length);
      const card = page.locator(`#index-card-${market.ids[0]}`);
      await expect(card).toBeVisible();
      const rows = page.locator(".mx-sector-list > li");
      if (mobile) await expect(rows).toHaveCount(11);
      else await expect(page.locator(".mx-sector-block")).toHaveCount(11);
      const folder = process.env.TM_MKT2_VISUAL_DIR;
      if (folder) {
        await page.evaluate(() => document.fonts.ready);
        await settle(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: path.join(folder, `market-${market.code}-${mobile ? 390 : 1440}.png`) });
      }
      if (mobile) await rows.first().getByRole("button").tap();
      else await page.locator('[data-key="45"] [data-subgroup="4510"]').click();
      const detail = page.locator(".mx-sector-detail");
      await expect(detail.getByRole("heading", { level: 2 })).toHaveText(/信息技术|Information Technology/);
      await expect(detail.locator(".mx-sector-breadth-detail")).toBeVisible();
      await expect(detail.locator(".mx-sector-ranks li")).toHaveCount(5);
      await expect(detail).toContainText("£1,200");
      if (mobile) {
        await page.locator(".mx-sector-back").tap();
        await expect(rows.first().getByRole("button")).toBeFocused();
      }
      await card.click();
      await expect(page).toHaveURL(new RegExp(`market=${market.code}&index=${market.ids[0]}`));
      await expect(page.locator(".mx-index-detail")).toBeVisible();
    });
  }

  test("shows dated basket breadth, VIX in points and a separate ETF valuation snapshot", async ({ page }, testInfo) => {
    if (testInfo.project.name === "mobile") {
      await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    }
    await mockIndices(page);
    await page.goto("/sectors?market=us&index=sp-500");
    const breadth = page.getByRole("heading", { name: /成分篮子宽度历史|Constituent basket breadth/ });
    await expect(breadth).toBeVisible();
    await expect(page.getByText(/站上 200 日线|Above 200-day average/).first()).toBeVisible();
    await expect(page.getByText("488/503")).toBeVisible();
    await expect(page.getByText(/18\.37 (点|pts)/)).toBeVisible();
    await expect(page.getByText("58%")).toBeVisible();
    await expect(page.getByRole("heading", { name: /跟踪 ETF 估值|Tracking ETF valuation/ })).toBeVisible();
    await expect(page.getByText("22.4×")).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic issuer" })).toHaveAttribute("href", "https://example.invalid/valuation");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await page.goto("/sectors?market=us&index=nasdaq-100");
    await expect(page.getByText(/暂无快照|No snapshot/)).toBeVisible();
    await expect(page.getByText("22.4×")).toHaveCount(0);
  });

  test("Hang Seng and KOSPI disclose MSCI basket weights without index attribution", async ({ page }) => {
    await mockIndices(page);
    for (const [market, id, proxy] of [["hk", "hang-seng", "Hong Kong"], ["kr", "kospi", "Korea"]]) {
      await page.goto(`/sectors?market=${market}&index=${id}`);
      const basket = page.locator(".mx-index-basket");
      await expect(basket.getByText(`Synthetic MSCI ${proxy} basket`, { exact: false })).toBeVisible();
      await expect(basket.getByText(/残差|Residual|正贡献|Top contributors/)).toHaveCount(0);
      await basket.getByText(/前十大成分|Top ten constituents/).click();
      await expect(basket.getByText("10%")).toBeVisible();
    }
  });

  test("India keeps the last board visible when its calendar is unknown", async ({ page }) => {
    const now = Date.parse("2027-01-04T07:30:00Z");
    await page.clock.setFixedTime(now);
    await mockIndices(page, { now });
    await page.route("**/api/backend/sectors?market=in", (route) => {
      const data = fixture("in", Date.parse(NEW_MARKETS[1].at));
      const markets = data.markets.map((status) => status.market === "in"
        ? { ...status, calendarKnown: false } : status);
      return route.fulfill({ json: { ...data, markets } });
    });
    await page.goto("/sectors?market=in");
    const clock = page.locator(".mx-sectors-clock");
    await expect(clock).toContainText(/日历未知|Calendar unknown/);
    await expect(clock).not.toContainText(/已收盘|Closed/);
    await expect(page.locator(".mx-sector-block:visible, .mx-sector-list button:visible").first()).toBeVisible();
  });

  test("capture synthetic Europe board screenshots", async ({ browser }, testInfo) => {
    const folder = process.env.TM_EU_VISUAL_DIR;
    test.skip(!folder || testInfo.project.name !== "desktop", "Opt-in batched visual evidence.");
    const sizes = [[1440, 900, "light"], [1440, 900, "dark"], [1100, 800, "light"], [390, 844, "light"]] as const;
    test.setTimeout(60_000);
    await Promise.all(sizes.map(async ([width, height, colorScheme]) => {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion: "reduce",
        baseURL: process.env.PLAYWRIGHT_BASE_URL });
      await page.clock.setFixedTime(EUROPE_FIXTURE_TIME);
      await mockIndices(page, { now: EUROPE_FIXTURE_TIME });
      const capture = async (market: string, step = "") => {
        await page.goto(`/sectors?market=${market}`);
        await expect(page.locator(".mx-index-cards a").first()).toBeVisible();
        await expect(page.locator(".mx-sector-block:visible, .mx-sector-list button:visible").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", colorScheme);
        await page.evaluate(() => document.fonts.ready);
        await settle(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: path.join(folder!, `synthetic-${market}-${width}x${height}-${colorScheme}${step}.png`) });
      };
      await capture("eu", width === 390 ? "-list" : "");
      if (width === 390) {
        await page.locator(".mx-sector-list button").first().click();
        await expect(page.locator(".mx-sector-detail h2")).toBeFocused();
        await settle(page);
        await page.screenshot({ path: path.join(folder!, "synthetic-eu-390x844-light-detail.png") });
      } else if (width === 1440 && colorScheme === "light") {
        await capture("uk");
        await capture("us");
      }
      await page.close();
    }));
  });

  test("capture market screenshots", async ({ browser }, testInfo) => {
    const folder = process.env.TM_MARKETS_VISUAL_DIR;
    test.skip(!folder || testInfo.project.name !== "desktop", "Opt-in batched visual evidence.");
    test.setTimeout(120_000);
    for (const width of [1440, 1100, 390]) {
      for (const scheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width, height: 940 }, colorScheme: scheme, reducedMotion: "reduce",
          baseURL: process.env.PLAYWRIGHT_BASE_URL,
        });
        await mockIndices(page);
        await page.goto("/sectors?market=us");
        await expect(page.getByRole("link", { name: /标普 500|S&P 500/ })).toBeVisible();
        await expect(page.locator(".mx-sector-block:visible, .mx-sector-list button:visible").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
        await settle(page);
        await page.screenshot({ path: path.join(folder!, `market-${width}-${scheme}.png`), fullPage: true });
        await page.goto("/sectors?market=us&index=sp-500&compare=nasdaq-100");
        await expect(page.locator(".mx-index-legend")).toBeVisible();
        await expect(page.getByRole("link", { name: "SYNA" })).toBeVisible();
        await settle(page);
        await page.screenshot({ path: path.join(folder!, `index-${width}-${scheme}.png`), fullPage: true });
        if (width !== 1100) {
          const depth = page.locator(".mx-index-depth").first();
          await depth.scrollIntoViewIfNeeded();
          await settle(page);
          await page.screenshot({ path: path.join(folder!, `index-depth-${width}-${scheme}.png`) });
        }
        await page.close();
      }
    }
  });
});
