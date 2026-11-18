import { expect, test as base, type Page } from "@playwright/test";
import { join } from "node:path";
import type { ResearchPriceSeries } from "../lib/types";

const test = base.extend<{ uiLocale: "en" | "zh" }>({ uiLocale: ["en", { option: true }] });

const bars = Array.from({ length: 100 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 6, 23 + index)).toISOString().slice(0, 10);
  const open = 105 + index / 3 + Math.sin(index / 5) * 7;
  const close = open + Math.sin(index) * 3 + 0.3;
  return {
    date, close, open, low: Math.min(open, close) - 1.6, high: Math.max(open, close) + 1.9,
    volume: 100_000 + Math.round((1 + Math.sin(index * 1.3)) * 25_000),
    sma20: close * 0.98, sma50: close * 0.91, sma200: close * 0.89,
  };
}).filter((bar) => ![0, 6].includes(new Date(bar.date).getUTCDay()));
const latest = bars.at(-1)!.date;
const day = bars.at(-4)!.date;
const splitDay = bars.at(-7)!.date;
const markers: NonNullable<ResearchPriceSeries["tradeMarkers"]> = [
  {
    ticker: "AAPL", date: bars.at(-9)!.date, kind: "T", accounts: ["isa", "invest"],
    buyOrders: 2, sellOrders: 3, buyQuantity: 3, sellQuantity: 4.5, buyAveragePrice: 100, sellAveragePrice: null,
    fills: [
      { at: bars.at(-9)!.date + "T13:00:00Z", side: "buy", account: "isa", quantity: 2, amount: 200, currency: "USD" },
      { at: bars.at(-9)!.date + "T14:00:00Z", side: "sell", account: "isa", quantity: 1.25, amount: 125, currency: "USD" },
    ],
  },
  {
    ticker: "AAPL", date: bars.at(-8)!.date, kind: "B", accounts: ["invest"],
    buyOrders: 1, sellOrders: 0, buyQuantity: 1, sellQuantity: 0, buyAveragePrice: 141, sellAveragePrice: null,
    fills: [{ at: bars.at(-8)!.date + "T15:35:00Z", side: "buy", account: "invest", quantity: 1, amount: 141, currency: "EUR" }],
  },
  {
    ticker: "AAPL", date: bars.at(-6)!.date, kind: "S", accounts: ["isa"],
    buyOrders: 0, sellOrders: 1, buyQuantity: 0, sellQuantity: 1, buyAveragePrice: null, sellAveragePrice: 144,
    fills: [{ at: bars.at(-6)!.date + "T15:35:00Z", side: "sell", account: "isa", quantity: 1, amount: 144, currency: "GBP" }],
  },
  {
    ticker: "AAPL", date: day, kind: "T", accounts: ["invest", "isa"],
    buyOrders: 1, sellOrders: 1, buyQuantity: 2, sellQuantity: 1, buyAveragePrice: 100, sellAveragePrice: 112,
    fills: [
      { at: day + "T15:35:00Z", side: "buy", account: "invest", quantity: 2, amount: 200, currency: "USD" },
      { at: day + "T17:25:00Z", side: "sell", account: "isa", quantity: 1, amount: 89, currency: "GBP" },
    ],
  },
];

async function mockPrices(page: Page, mode: "candles" | "no OHLC" = "candles") {
  await page.route(/\/api\/backend\/research\/(AAPL|BE|NVDA)\/prices\?/, async (route) => {
    const url = new URL(route.request().url());
    const ticker = url.pathname.split("/").at(-2)!;
    const points = bars.map((bar, index) => index === bars.length - 3 || mode === "no OHLC"
      ? { ...bar, open: null, low: null, high: null } : bar);
    await route.fulfill({ json: {
      ticker, requestedInterval: "1d", actualInterval: "1d", timezone: "America/New_York",
      source: "Synthetic prices", adjustment: "split-and-dividend-adjusted", session: "regular", currency: "USD", asOf: latest, availableSessions: bars.length,
      points, tradeMarkers: ticker === "AAPL" ? markers : [],
      events: [
        { date: day, kind: "dividend", value: 0.25, currency: "USD" },
        { date: splitDay, kind: "split", value: 2 },
      ],
    } satisfies ResearchPriceSeries });
  });
}

test.describe("primary chart reading", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a seeded local preview.");
  test.beforeEach(async ({ page, isMobile, uiLocale }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), uiLocale);
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`fixed chart and technical chart work in ${colorScheme}`, async ({ page, isMobile }, info) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await mockPrices(page);
      const width = page.viewportSize()!.width;
      const folder = process.env.CHART_QA_DIR;
      for (const ticker of ["AAPL", "BE", "NVDA"]) {
        await page.goto(`/research?ticker=${ticker}&view=overview`);
        const overview = page.locator(".mx-price-diagnosis-preview");
        const preview = overview.getByRole("group", { name: `${ticker} · Three-month candlestick chart` });
        await expect(preview).toHaveAttribute("data-tm-chart-ready", "true");
        await expect(overview.locator("[data-chart-reading]")).toContainText("Open");
        // The panel names the currency once; figures carry none.
        await expect(overview).toContainText("Price history · 3M · USD");
        await expect(overview.locator(".mx-chart-readout-latest")).not.toContainText("USD");
        await expect(overview.getByRole("link", { name: "Price & technicals" })).toHaveAttribute("href", /priceRange=3M&priceStyle=candles/);
        if (folder && ticker === "AAPL") await overview.screenshot({ path: join(folder, `overview-${info.project.name}-${width}-${colorScheme}.png`) });
      }
      await page.goto("/research?ticker=AAPL&view=technical");
      const chartPanel = page.locator(".mx-tech-chart");
      const chart = chartPanel.locator("[data-tm-chart-ready]");
      const readout = chartPanel.locator("[data-chart-reading]");
      await expect(chart).toBeVisible();
      await expect(readout).toContainText("Open");
      await expect(chartPanel.getByRole("button", { name: "Candles" })).toHaveAttribute("aria-pressed", "true");
      // The chart, score and diagnosis share one surface; the diagnosis spans it below them.
      const [surfaceBox, chartBox, diagnosisBox] = await Promise.all([
        page.locator(".mx-tech-workspace").boundingBox(), chartPanel.boundingBox(), page.locator(".mx-tech-diagnosis").boundingBox(),
      ]);
      expect(Math.abs(diagnosisBox!.width - (surfaceBox!.width - 2))).toBeLessThanOrEqual(2);
      expect(diagnosisBox!.x).toBeCloseTo(chartBox!.x, 0);
      if (width === 1100) {
        const [plot, score] = await Promise.all([chart.boundingBox(), page.locator(".mx-tech-rail").boundingBox()]);
        expect(plot!.y).toBeLessThan(700);
        expect(score!.x).toBeGreaterThan(plot!.x + plot!.width - 4);
      }
      await chart.scrollIntoViewIfNeeded();
      const plot = (await chart.boundingBox())!;
      const x = plot.x + plot.width / 2;
      const y = plot.y + 65;
      const latestText = await readout.innerText();
      if (isMobile) await page.touchscreen.tap(x, y);
      else await page.mouse.move(x, y);
      await expect(readout).toHaveAttribute("data-chart-reading", "selected");
      const pointerText = await readout.innerText();
      // A touch selection is announced; a mouse hover is not.
      if (isMobile) expect(pointerText).not.toBe(latestText);
      else expect(pointerText).toBe(latestText);
      await chart.focus();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => readout.innerText()).not.toBe(pointerText);
      const previousText = await readout.innerText();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => readout.innerText()).not.toBe(previousText);
      if (isMobile) await expect.poll(() => readout.innerText()).toBe(pointerText);
      await page.keyboard.press("Escape");
      await expect(readout).toHaveAttribute("data-chart-reading", "latest");
      await chartPanel.getByRole("checkbox", { name: "SMA" }).click();
      await expect(readout).toContainText("SMA 20");
      await chartPanel.getByRole("button", { name: "Zoom in" }).click();
      await chartPanel.getByRole("button", { name: "Reset zoom" }).focus();
      await page.keyboard.press("Enter");

      const track = chartPanel.getByRole("region", { name: "Event timeline" });
      await expect(track.getByRole("button", { name: / B$/ })).toBeVisible();
      await expect(track.getByRole("button", { name: / S$/ })).toBeVisible();
      const marker = track.getByRole("button", { name: / · T \(\+2\)$/ });
      await marker.focus();
      await page.keyboard.press("Enter");
      await expect(marker).toHaveAttribute("aria-expanded", "true");
      await expect(track.locator("li").filter({ hasText: "Buy · INVEST" })).toContainText("200 USD");
      await expect(track.locator("li").filter({ hasText: "Sell · ISA" })).toContainText("89 GBP");
      await expect(track.locator("li").filter({ hasText: "Dividend" })).toContainText("0.25 USD");
      await chartPanel.getByRole("checkbox", { name: "Events" }).click();
      await expect(track).toHaveCount(0);
      if (folder) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(folder, `technical-${info.project.name}-${width}-${colorScheme}.png`) });
      }

      await chartPanel.getByRole("button", { name: "Full chart" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator("[data-tm-chart-ready]")).toBeVisible();
      await expect(dialog.getByLabel("Bar interval")).not.toBeVisible();
      const advanced = dialog.getByText("Advanced", { exact: true });
      if (isMobile) expect((await advanced.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await advanced.click();
      const interval = dialog.getByRole("combobox", { name: "Bar interval" });
      await expect(interval).toBeVisible();
      if (isMobile) expect((await interval.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await advanced.click();
      const rows = await dialog.getByRole("group", { name: "Price range" }).getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().y)));
      expect(rows.every((row) => rows.filter((other) => row === other).length > 1)).toBe(true);
      if (folder) await dialog.screenshot({ path: join(folder, `full-${info.project.name}-${width}-${colorScheme}.png`) });
      await dialog.getByRole("button", { name: "Line", exact: true }).click();
      await expect(page).toHaveURL(/priceStyle=line/);
      await expect(dialog.locator("[data-chart-reading]")).not.toContainText("Open");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await dialog.getByRole("button", { name: "Exit fullscreen", exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(chartPanel.getByRole("button", { name: "Full chart", exact: true })).toBeFocused();
    });
  }

  for (const locale of ["en", "zh"] as const) {
    test.describe(`mixed archive in ${locale}`, () => {
      test.use({ uiLocale: locale });
      for (const colorScheme of ["light", "dark"] as const) {
        test(`expands single and multiple orders in ${colorScheme}`, async ({ page }, info) => {
          const en = locale === "en";
          await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
          await mockPrices(page);
          await page.goto("/research?ticker=AAPL&view=technical");
          const track = page.getByRole("region", { name: en ? "Event timeline" : "事件时间轴" });
          const marker = track.getByRole("button", { name: / · T \(\+4\)$/ });
          await expect(marker).toHaveAccessibleName(/ · T \(\+4\)$/);
          await marker.focus();
          await page.keyboard.press("Enter");
          const rows = track.getByRole("listitem");
          await expect(rows.filter({ hasText: en ? "Buy · ISA" : "买入 · ISA" })).toContainText("200 USD");
          await expect(rows.filter({ hasText: en ? "Sell · ISA" : "卖出 · ISA" })).toContainText("125 USD");
          const archive = rows.filter({ hasText: en ? "Original amount unavailable in this archive" : "旧档案未记录原币金额" });
          const single = archive.filter({ hasText: en ? "Buy 1 share" : "买入 1 股" });
          const multiple = archive.filter({ hasText: en ? "Sell 3.25 shares" : "卖出 3.25 股" });
          await expect(single.getByText(en ? "1 order" : "1 笔", { exact: true })).toBeVisible();
          await expect(multiple.getByText(en ? "2 orders" : "2 笔", { exact: true })).toBeVisible();
          if (process.env.CHART_QA_DIR) await track.screenshot({ path: join(process.env.CHART_QA_DIR, `mixed-archive-${info.project.name}-${locale}-${colorScheme}.png`) });
        });
      }
    });
  }

  test("the chart explains unavailable price history for the selected listing", async ({ page }, info) => {
    await page.route("**/api/backend/research/AAPL/prices?**", route => route.fulfill({
      status: 404, json: { detail: "security-price-history-unavailable" },
    }));
    await page.goto("/research?ticker=AAPL&view=technical&chart=full");
    const message = page.getByText("Price history unavailable for this listing", { exact: true }).last();
    await expect(message).toBeVisible();
    if (process.env.CHART_QA_DIR) await message.locator("..").screenshot({
      path: join(process.env.CHART_QA_DIR, `listing-unavailable-${info.project.name}.png`),
    });
  });

  test("a response with no OHLC is visibly identified as closing prices", async ({ page }) => {
    await mockPrices(page, "no OHLC");
    await page.goto("/research?ticker=AAPL&view=overview");
    const overview = page.locator(".mx-price-diagnosis-preview");
    await expect(overview.getByText("OHLC unavailable; closing prices shown")).toBeVisible();
    await expect(overview.getByRole("group", { name: /Three months of closing prices/ })).toHaveAttribute("data-tm-chart-ready", "true");
  });

  test("the index 1D caption says five minutes and empty slots are skipped", async ({ page }) => {
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "available", range: "1D", index: { scope: "us", source: "Synthetic index" }, asOf: "2026-10-30T13:40:00Z", currency: "USD",
      points: [{ at: "2026-10-30T13:30:00Z", value: 500 }, { at: "2026-10-30T13:35:00Z", value: 502 }],
      gaps: ["2026-10-30T13:40:00Z"],
    } }));
    await page.goto("/sectors?market=us&view=indices&index=sp-500&range=1D");
    const history = page.locator(".mx-index-history");
    await expect(history.getByText("Only 2 observations")).toBeVisible();
    const chart = history.locator("[data-tm-chart-ready]");
    await chart.focus();
    await page.keyboard.press("End");
    await expect(history.locator("[data-chart-reading]")).toContainText("502.00");
    await expect(history.locator("[data-chart-reading]")).not.toContainText("USD");
    await history.getByRole("button", { name: "Index data and basis" }).click();
    await expect(page.getByText("5-minute bars for the latest trading session.")).toBeVisible();
  });
});
