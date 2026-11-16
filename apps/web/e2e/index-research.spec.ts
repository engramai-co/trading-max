import { expect, test, webkit, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const index = {
  id: "synthetic-index", name: "Synthetic broad market", nameZh: "合成宽基指数", scope: "us",
  currency: "USD", compiler: "Synthetic compiler", compilerId: "SYN-PR", seriesCode: "SYN-PR",
  variant: "PR", hedging: "unhedged", kind: "index", basis: "price", aliases: ["SYNX"], symbol: "^SYN",
  familyId: "synthetic-index", ranges: ["1D", "3M", "1Y", "MAX"], calendar: "XNYS", rights: "provider-terms",
};
const alternative = { ...index, id: "synthetic-second", name: "Synthetic second", nameZh: "合成对照指数" };
const privateValue = 71;
const stamp = "2026-10-06T20:00:00Z";
const members = [
  { ticker: "SYN1", name: "Synthetic A", isin: "ZZ0000000001", weight: .65, move: .02, contribution: .013, country: "Synthetic country" },
  { ticker: "SYN2", name: "Synthetic B", isin: "ZZ0000000002", weight: .25, move: -.019, contribution: -.00475, country: "Synthetic country" },
  { ticker: "SYN3", name: "Synthetic C", isin: "ZZ0000000003", weight: .10, move: null, contribution: null, country: "Synthetic country" },
];
const composition = {
  source: "Synthetic issuer", sourceUrl: "https://issuer.example", holdingsDate: "2026-10-05", sessionDate: "2026-10-06",
  basketBasis: "issuer-portfolio", coverage: .9, weighting: "cap", members, up: 1, flat: 0, down: 1, uncovered: 1,
  highs52w: 1, lows52w: 0, eligible52w: 2, equalWeightMove: .0005, capWeightMove: .00825, totalMove: .009,
  waterfall: [
    { key: "SYN1", contribution: .013 }, { key: "SYN2", contribution: -.00475 },
    { key: "rest", contribution: 0 }, { key: "residual", contribution: .00075 },
  ],
};
const product = {
  isin: "ZZ0000000100", ticker: "SYNF.L", name: "Synthetic tracker", shareCurrency: "USD", domicile: "IE", hedged: false,
  benchmarkId: index.id, group: "held", relationship: "exact", evidenceUrl: "https://issuer.example",
  expenseRatio: 0.002, evidenceDate: "2026-10-06", valueGbp: privateValue,
};
const points = Array.from({ length: 48 }, (_, n) => ({
  at: new Date(Date.UTC(2026, 7, 3 + n)).toISOString(), value: 550 + 2 * n + 8 * Math.sin(n),
}));
const fundIsin = "ZZ0000000100";
const shell = {
  status: { runId: "synthetic-index", freshness: "fresh" }, watchlistCategories: [],
  instruments: [{ ticker: "SYNF.L", name: "Synthetic tracker", exchange: "LSE", held: true, isFund: true, watchlisted: true, status: "ready" }],
};

async function exercise(page: Page, baseURL: string, name: string) {
  const origin = new URL(baseURL).origin;
  await page.clock.install({ time: new Date(stamp) });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin || req.method() !== "GET") return route.abort();
    if (url.pathname.startsWith("/api/company-logo/")) return route.fulfill({ status: 204 });
    if (!url.pathname.startsWith("/api/backend/")) return route.continue();
    const path = url.pathname.replace(/^\/api\/backend/, "");
    if (path === "/indices/catalog") return route.fulfill({ json: [index, alternative] });
    if (path === "/research/shell") return route.fulfill({ json: shell });
    if (path.includes("/lens/")) return route.fulfill({ json: {
      ticker: "SYNF.L", view: "fundamentals", runId: "synthetic-index", generatedAt: stamp,
      context: { assetType: "ETF", quote: { price: 12, currency: "GBP" }, datasets: [], capabilities: [] },
    } });
    if (path.endsWith("/fund")) return route.fulfill({ json: {
      ticker: "SYNF.L", state: "available", fetchedAt: stamp, isin: fundIsin, benchmark: index, indexName: index.nameZh,
      dailyTracking: {
        isin: fundIsin, benchmarkId: index.id, state: "available", navCurrency: "USD", benchmarkCurrency: "USD",
        sourceUrl: product.evidenceUrl, summary: {
          firstDate: "2026-01-01", lastDate: "2026-10-01", commonObservations: 192, dailyReturnObservations: 190,
          trackingDifference: -.001, trackingError: .005,
        },
        points: points.map(({ at }, i) => ({ date: at.slice(0, 10), cumulativeDifference: -i / 10000, rollingTrackingError: i / 10000 })),
      },
    } });
    if (path.endsWith("/research")) return route.fulfill({ json: {
      index, depth: "L2", quote: { level: 612, change: .009, asOf: stamp, state: "closed" },
      technical: { ticker: index.id, score: 68, asOf: stamp, state: "偏强", scoreExplanationState: "unavailable" },
      exposure: { totalGbp: privateValue, directGbp: 21, lookThroughGbp: 50, matchedIsins: 2, asOf: stamp },
      composition,
      products: [
        product, { ...product, isin: "ZZ0000000101", ticker: "SYN2", valueGbp: null,
          group: "similar", relationship: "similar-exposure" },
      ],
    } });
    if (path.endsWith("/history")) return route.fulfill({ json: {
      index, range: url.searchParams.get("range"), state: "available", sourceInterval: "1d", displayInterval: "1d",
      points: path.includes("second") ? points.map(({ at, value }) => ({ at, value: value + 20 })) : points,
      gaps: [],
    } });
    if (path === "/securities/search") return route.fulfill({ json: { source: "registry", query: "SYNX", results: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(new URL("/research?ticker=SYNF.L&view=tracking", baseURL).href);
  await expect(page.getByRole("region", { name: "累计跟踪差" })).toBeVisible();
  await expect(page.getByRole("region", { name: "滚动一年跟踪误差" })).toBeVisible();
  await page.getByRole("link", { name: index.nameZh }).click();
  await expect(page).toHaveURL(/type=index&index=synthetic-index$/);
  await expect(page.getByRole("heading", { name: index.nameZh })).toBeVisible();
  // Coverage depth is internal: the page shows what it has, not an L-grade.
  await expect(page.getByText("L2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("我的合计敞口")).toBeVisible();
  // The holding's value never reaches the address; the port is the server's, not the page's.
  const address = new URL(page.url());
  expect(address.pathname + address.search).not.toContain(String(privateValue));
  // An index joins the research list the way a stock or fund does, and is listed there.
  await page.getByRole("button", { name: "加入研究清单", exact: true }).click();
  await expect(page.getByRole("button", { name: "加入研究清单", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: index.nameZh + "，打开研究清单" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: new RegExp(index.nameZh) })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "更多操作" }).click();
  await expect(page.getByRole("menuitem", { name: "从研究清单移除" })).toBeEnabled();
  await page.keyboard.press("Escape");
  const tabs = page.getByRole("tablist", { name: "研究视角" });
  await tabs.getByRole("tab", { name: "跟踪产品" }).click();
  await expect(page.getByRole("region", { name: "我持有" })).toContainText("SYNF.L");
  await expect(page.getByRole("region", { name: "相似敞口" })).toContainText("SYN2");

  const screenshotDir = process.env.TRADING_MAX_INDEX_SCREENSHOTS;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  await tabs.getByRole("tab", { name: "成分与权重" }).click();
  await expect(page.getByRole("figure", { name: "成分热图" })).toBeVisible();
  await expect(page.getByRole("list", { name: "贡献瀑布" })).toContainText("对账残差");
  await expect(page.getByText("指数涨跌", { exact: true })).toBeVisible();
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/index-members-${name}-light.png`, animations: "disabled", scale: "css" });

  await tabs.getByRole("tab", { name: "价格与走势" }).click();
  await expect(page.getByRole("region", { name: "回撤" })).toBeVisible();
  await page.getByRole("combobox", { name: "比较指数" }).fill(alternative.nameZh);
  await page.getByRole("option", { name: alternative.nameZh }).click();
  await expect(page.getByText("基准化 · 100")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "对数" }).focus();
  await page.getByRole("switch", { name: "对数" }).press("Space");
  await expect(page.getByRole("switch", { name: "对数" })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (screenshotDir) {
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
    await page.screenshot({ path: `${screenshotDir}/index-price-${name}-dark.png`, animations: "disabled", scale: "css" });
  }
}

test("a fund benchmark opens an index with private exposure, constituents and chart tools", async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: info.project.name === "mobile" ? 390 : 1440, height: 900 });
  await exercise(page, baseURL!, info.project.name);
});

test("the index research lenses fit WebKit at the app width", async ({ baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "Run the app viewport once");
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await exercise(page, baseURL!, "webkit-1100");
  } finally {
    await browser.close();
  }
});
