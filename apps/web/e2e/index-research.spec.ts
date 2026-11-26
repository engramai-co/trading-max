import { expect, test, webkit, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { formatCalendarDate } from "../ui/formatters";

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

const publishedSeriesId = "f".repeat(20);
async function indexFixture(page: Page, baseURL: string, locale: "zh" | "en" = "zh") {
  const origin = new URL(baseURL).origin;
  await page.clock.install({ time: new Date(stamp) });
  await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
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
      index, range: url.searchParams.get("range"), state: "available", sourceInterval: "1d", displayInterval: "1d", publishedSeriesId,
      points: path.includes("second") ? points.map(({ at, value }) => ({ at, value: value + 20 })) : points,
      gaps: [],
    } });
    if (path === "/securities/search") return route.fulfill({ json: { source: "registry", query: "SYNX", results: [] } });
    return route.fulfill({ json: {} });
  });
}

async function exercise(page: Page, baseURL: string, name: string) {
  await indexFixture(page, baseURL);
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
  const heatmap = page.getByRole("figure", { name: "成分热图" });
  await expect(heatmap).toBeVisible();
  // Missing quotes stay distinct from priced moves, carry no pointer-only title, and inspect by tap/keys.
  await expect(heatmap.locator('button[data-tone="up"]')).toHaveCount(1);
  await expect(heatmap.locator('button[data-tone="down"]')).toHaveCount(1);
  await expect(heatmap.locator('button[data-tone="missing"]')).toHaveCount(1);
  await expect(heatmap.locator("button[title]")).toHaveCount(0);
  if (name !== "mobile") {
    // Landscape panel keeps the 100x100 normalised split: the 65% constituent spans full width on top.
    const boxHost = (await heatmap.locator(".mx-index-research-heatmap").boundingBox())!;
    const box1 = (await heatmap.locator('button[data-key="ZZ0000000001"]').boundingBox())!;
    const box2 = (await heatmap.locator('button[data-key="ZZ0000000002"]').boundingBox())!;
    const box3 = (await heatmap.locator('button[data-key="ZZ0000000003"]').boundingBox())!;
    expect(box1.width).toBeGreaterThanOrEqual(boxHost.width - 2);
    expect(box2.y).toBeGreaterThanOrEqual(box1.y + box1.height);
    expect(Math.abs(box2.y - box3.y)).toBeLessThanOrEqual(1);
  }
  const tileRadius = await heatmap.locator("button").first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(tileRadius).toBe("12px");
  const firstTile = heatmap.locator("button").first();
  await firstTile.click();
  await expect(heatmap.locator("figcaption")).toContainText("SYN1");
  await firstTile.focus();
  await page.keyboard.press("ArrowDown");
  await expect(heatmap.locator("figcaption")).toContainText(/SYN2|SYN3/);
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

test("index reading questions keep the selected series and typed chat uses page context", async ({ page, baseURL, isMobile }) => {
  await indexFixture(page, baseURL!);
  await page.route("**/api/backend/profile",route => route.fulfill({json:{accountLabels:{},assistantEnabled:true}}));
  const date = points[10].at.slice(0, 10);
  const reads: string[] = [];
  const readingContext = {index_id:index.id, ticker:index.symbol, published_series_id:publishedSeriesId};
  await page.route("**/api/backend/assistant/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: { ready: true } });
    if (url.pathname.includes("/key-moments/")) {
      const q = url.searchParams;
      expect(q.get("index_id")).toBe(index.id);
      expect(q.get("published_series_id")).toBe(publishedSeriesId);
      return route.fulfill({ json: { data: { published_series_id: publishedSeriesId, start:q.get("start"), end:q.get("end"), items:[{date}] } } });
    }
    if (url.pathname.endsWith("/chat")) return route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}});
    if (!url.pathname.endsWith("/reading")) return route.fulfill({ json: {} });
    const role = url.pathname.split("/").at(-2)!;
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ snapshotId:shell.status.runId, context:readingContext });
    if (role === "key-moment") expect(body.context.date).toBe(date);
    reads.push(role);
    const evidence = {source:"market", tool:"research_position", evidenceId:"ev_index", arguments:{index:index.id}};
    const reading = {role, version:shell.status.runId, snapshotId:shell.status.runId, asOf:stamp,
      lines: [{zh:"指数点位", en:"Index level", evidence}, {zh:"同期变动", en:"Period change", evidence}]};
    return route.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({type:"result", reading})+"\n"});
  });
  const path = "/research?type=index&index=" + index.id;
  await page.goto(path);
  await expect(page.locator(".mx-index-research-chart-top")).toBeVisible();
  await page.locator("[data-assistant-trigger]").click();
  const opening = page.locator(".mx-assistant-opening");
  await expect(opening.getByRole("heading")).toContainText(index.nameZh);
  await expect(opening.locator(".mx-reading-line")).toHaveCount(2);
  expect(reads).toEqual(["your-position"]);
  const ask = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await opening.locator(".mx-assistant-questions button").first().click();
  expect((await ask).postDataJSON().context).toMatchObject({
    page:"research", role:"your-position", ticker:index.symbol, indexId:index.id, lens:"overview",
    scope:"broker_total", snapshotId:shell.status.runId, object:readingContext,
  });
  await expect(page.getByRole("button", {name:"重试", exact:true})).toBeVisible();
  await expect(page.locator(".mx-assistant-scope")).toHaveText("研究");
  const composer = page.getByRole("textbox", {name:"消息"});
  await composer.fill("How has the market changed?");
  const typed = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await composer.press("Enter");
  expect((await typed).postDataJSON().context).toEqual({page:"research", timezone:expect.any(String)});
  await page.goto(path + "&view=price");
  const track = page.locator(".mx-track-moment");
  await expect(track.locator("time")).toHaveAttribute("datetime", date);
  expect(reads).toEqual(["your-position"]);
  await track.click();
  const card = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading");
  await expect(card.locator(".mx-reading-line")).toHaveCount(2);
  if (isMobile) await page.keyboard.press("Control+j");
  else await page.locator("[data-assistant-trigger]").click();
  await expect(opening.getByRole("heading")).toContainText(index.nameZh + " · " + formatCalendarDate(date, "zh", new Date(stamp)));
  await expect(opening.locator(".mx-reading-line")).toHaveText([/指数点位/, /同期变动/]);
  await expect(opening.getByRole("button", {name:/当天有哪些已核实的事件/})).toBeEnabled();
  expect(reads).toEqual(["your-position", "key-moment"]);
  await expect(page.locator(".mx-earnings-brief")).toHaveCount(0);
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

for (const [locale, expected] of [
  ["zh", ["其余已覆盖成分", "对账残差"]],
  ["en", ["Other covered constituents", "Reconciliation residual"]],
] as const) {
  test(`constituent heatmap excludes sub-pixel tiles from focus, wraps phone waterfall labels and respects 20px root (${locale})`, async ({ page, baseURL }, info) => {
    test.skip(locale === "en" && info.project.name !== "mobile", "Phone bilingual waterfall check");
    await indexFixture(page, baseURL!, locale);
    const subpixelMembers = [
      { ticker: "SYN1", name: "Synthetic A", isin: "ZZ0000000001", weight: 0.65, move: 0.02, contribution: 0.013, country: "Synthetic country" },
      { ticker: "SYN2", name: "Synthetic B", isin: "ZZ0000000002", weight: 0.25, move: -0.019, contribution: -0.00475, country: "Synthetic country" },
      { ticker: "SYN3", name: "Synthetic C", isin: "ZZ0000000003", weight: 0.0999, move: null, contribution: null, country: "Synthetic country" },
      { ticker: "TINY", name: "Synthetic Tiny", isin: "ZZ0000000004", weight: 0.0001, move: 0.01, contribution: 0.000001, country: "Synthetic country" },
    ];
    await page.route("**/api/backend/indices/*/research**", (route) => route.fulfill({ json: {
      index, depth: "L2", quote: { level: 612, change: 0.009, asOf: stamp, state: "closed" },
      composition: { ...composition, members: subpixelMembers },
      products: [],
    } }));
    await page.addInitScript(() => {
      const apply = () => {
        if (!document.documentElement) return false;
        document.documentElement.style.fontSize = "125%";
        return true;
      };
      if (!apply()) {
        new MutationObserver((_, observer) => {
          if (apply()) observer.disconnect();
        }).observe(document, { childList: true });
      }
    });
    await page.setViewportSize({ width: info.project.name === "mobile" ? 390 : 1280, height: 900 });
    await page.goto("/research?type=index&index=synthetic-index&view=constituents");

    const heatmap = page.getByRole("figure", { name: locale === "zh" ? "成分热图" : "Constituent heatmap" });
    expect(await heatmap.evaluate((el) => getComputedStyle(el).marginLeft === "0px" && getComputedStyle(el).marginRight === "0px")).toBe(true);
    await expect(heatmap.locator("button")).toHaveCount(3);
    await expect(heatmap.locator('button[data-key="ZZ0000000004"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /TINY/ })).toBeVisible();

    // At 20px root font, labelled tiles must not clip vertically or horizontally.
    const clipped = await heatmap.locator('button[data-label-tier]:not([data-label-tier="none"])').evaluateAll((buttons) =>
      buttons.filter((button) => {
        const btnStyle = getComputedStyle(button);
        const btnRect = button.getBoundingClientRect();
        const innerBottom = btnRect.bottom - (parseFloat(btnStyle.paddingBottom) || 0) + 0.5;
        const innerRight = btnRect.right - (parseFloat(btnStyle.paddingRight) || 0) + 0.5;
        return [...button.querySelectorAll("strong, span")].some((child) => {
          const rect = child.getBoundingClientRect();
          return child.scrollWidth > child.clientWidth + 1 || rect.bottom > innerBottom || rect.right > innerRight;
        });
      }).length);
    expect(clipped).toBe(0);

    if (info.project.name === "mobile") {
      const waterfall = page.getByRole("list", { name: locale === "zh" ? "贡献瀑布" : "Contribution waterfall" });
      await expect(waterfall).toBeVisible();
      for (const text of expected) {
        const label = waterfall.getByText(text, { exact: true });
        await expect(label).toBeVisible();
        const metrics = await label.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            overflows: el.scrollWidth > el.clientWidth + 1,
            textOverflow: cs.textOverflow,
            whiteSpace: cs.whiteSpace,
          };
        });
        expect(metrics.overflows).toBe(false);
        expect(metrics.textOverflow).not.toBe("ellipsis");
        expect(metrics.whiteSpace).not.toBe("nowrap");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });
}
