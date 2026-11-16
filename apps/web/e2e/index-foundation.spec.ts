import { expect, test, webkit, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const runId = "synthetic-index-foundation";
const stamp = "2026-01-12T20:30:00Z";
const eqgb = { ticker: "EQGB.L", name: "Synthetic hedged ETF", exchange: "LSE", held: true, watchlisted: true, isFund: true, status: "ready" };
const security = {
  ticker: "QQQ", name: "Synthetic comparison ETF", exchange: "NASDAQ", figi: "",
  bloombergTicker: "QQQ US Equity", securityType: "ETF", alreadyWatched: false,
};
const peer = {
  fund: { ticker: security.ticker, name: security.name, exchange: security.exchange, benchmark: "Synthetic gross total return", sourceUrl: "https://issuer.example/qqq" },
  relation: "similar", localBenchmark: "Synthetic hedged index", localSourceUrl: "https://issuer.example/eqgb",
  differenceEn: "Different return basis", differenceZh: "回报口径不同",
};
const points = Array.from({ length: 8 }, (_, n) => ({
  date: `2026-01-0${n + 1}`, close: 95 + n, open: 94 + n, high: 96 + n, low: 93 + n, volume: 1000,
}));

async function runPeerFlow(page: Page, baseURL: string, name: string) {
  let added = false;
  let posts = 0;
  const origin = new URL(baseURL).origin;
  await page.clock.install({ time: new Date(stamp) });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const path = url.pathname.replace(/^\/api\/backend/, "");
    if (url.pathname.startsWith("/api/company-logo/")) return route.fulfill({ status: 204 });
    if (!url.pathname.startsWith("/api/backend/")) return route.continue();
    if (path === "/securities/search") {
      return route.fulfill({ json: { query: "QQQ", source: "registry", results: [{ ...security, alreadyWatched: added }] } });
    }
    if (path === "/watchlist" && req.method() === "POST") {
      expect(req.postDataJSON()).toMatchObject({ security: { ticker: "QQQ", securityType: "ETF" }, refresh: true });
      added = true;
      posts += 1;
      return route.fulfill({ status: 202, json: { item: { ticker: "QQQ" }, message: "Added" } });
    }
    if (req.method() !== "GET") return route.abort();
    if (path === "/research/shell") {
      return route.fulfill({ json: {
        status: { runId, freshness: "fresh" }, watchlistCategories: [],
        instruments: [
          { ...eqgb, usFundPeers: [peer] },
          { ...security, isFund: true, status: added ? "ready" : "partial", watchlisted: added, held: false },
        ],
      } });
    }
    if (path.includes("/lens/")) {
      const [ticker, view] = [path.split("/")[2], path.split("/").at(-1)];
      if (ticker === "QQQ" && !added) expect(url.searchParams.get("preview")).toBe("true");
      return route.fulfill({ json: {
        ticker, view, runId, generatedAt: stamp, fundamentals: { metrics: { quoteType: "ETF" } },
        technicalSummary: { ticker, asOf: "2026-01-09", score: 64, state: "中性", scoreExplanationState: "unavailable" },
        context: { assetType: "ETF", quote: { exchange: "NASDAQ", price: 102, currency: "USD", asOf: "2026-01-09" }, capabilities: [], datasets: [] },
      } });
    }
    if (path.endsWith("/prices")) return route.fulfill({ json: { ticker: "QQQ", currency: "USD", points, availableSessions: points.length, asOf: "2026-01-09" } });
    if (path.endsWith("/fund")) return route.fulfill({ json: {
      ticker: path.split("/")[2], state: "available", fetchedAt: stamp, indexName: peer.fund.benchmark,
      sourceUrl: peer.fund.sourceUrl, shareCurrency: "USD", holdingsState: "no-holdings",
    } });
    if (path === "/indices/catalog") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto(new URL("/research?ticker=EQGB.L&view=peers", baseURL).href);
  await page.getByRole("button", { name: "更多操作" }).click();
  // A holding stays in the list: removal is offered but unavailable, and says why.
  const remove = page.getByRole("menuitem", { name: /从研究清单移除/ });
  await expect(remove).toBeDisabled();
  await expect(remove).toContainText("持仓中");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: /QQQ/ }).last().click();
  await expect(page).toHaveURL(/ticker=QQQ/);
  await expect(page.getByRole("heading", { name: "基金概况" })).toBeVisible();
  await expect(page.locator(".mx-security-price")).toContainText("102");
  await expect(page.locator(".mx-tech-score-compact .mx-tech-number strong")).toHaveText("64");
  expect(posts).toBe(0);
  const add = page.getByRole("button", { name: "加入研究清单" });
  await expect(add).toBeEnabled();
  if (process.env.TRADING_MAX_INDEX_SCREENSHOTS) {
    const folder = process.env.TRADING_MAX_INDEX_SCREENSHOTS;
    await mkdir(folder, { recursive: true });
    await page.screenshot({ path: `${folder}/peer-${name}-light.png`, animations: "disabled", scale: "css" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
    await page.screenshot({ path: `${folder}/peer-${name}-dark.png`, animations: "disabled", scale: "css" });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await add.click();
  await expect(add).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更多操作" })).toBeVisible();
  expect(posts).toBe(1);
}

test("an issuer peer opens read-only before it is added", async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: info.project.name === "mobile" ? 390 : 1440, height: 900 });
  await runPeerFlow(page, baseURL!, info.project.name);
});

test("the peer flow fits the native WebKit width", async ({ baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "Run the app viewport only once");
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await runPeerFlow(page, baseURL!, "webkit-1100");
  } finally {
    await browser.close();
  }
});
