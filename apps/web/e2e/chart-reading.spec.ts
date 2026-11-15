import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import type { ResearchPriceSeries } from "../lib/types";

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
  test.beforeEach(async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
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
        await expect(overview.locator(".mx-chart-readout-latest")).toContainText("USD");
        await expect(overview.getByRole("link", { name: "Technicals" })).toHaveAttribute("href", /priceRange=3M&priceStyle=candles/);
        if (folder && ticker === "AAPL") await overview.screenshot({ path: join(folder, `overview-${info.project.name}-${width}-${colorScheme}.png`) });
      }
      await page.goto("/research?ticker=AAPL&view=technical");
      const chartPanel = page.locator(".mx-tech-chart");
      const chart = chartPanel.locator("[data-tm-chart-ready]");
      const readout = chartPanel.locator("[data-chart-reading]");
      await expect(chart).toBeVisible();
      await expect(readout).toContainText("Open");
      await expect(chartPanel.getByRole("button", { name: "Candles" })).toHaveAttribute("aria-pressed", "true");
      if (width === 1100) {
        const [plot, score] = await Promise.all([chart.boundingBox(), page.locator(".mx-tech-rail").boundingBox()]);
        expect(plot!.y).toBeLessThan(700);
        expect(score!.x).toBeGreaterThan(plot!.x + plot!.width - 4);
      }
      await chart.scrollIntoViewIfNeeded();
      const plot = (await chart.boundingBox())!;
      const x = plot.x + plot.width / 2;
      const y = plot.y + 65;
      if (isMobile) await page.touchscreen.tap(x, y);
      else await page.mouse.move(x, y);
      await expect(readout).toHaveAttribute("data-chart-reading", "selected");
      const pointerText = await readout.innerText();
      await chart.focus();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => readout.innerText()).not.toBe(pointerText);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => readout.innerText()).toBe(pointerText);
      await page.keyboard.press("Escape");
      await expect(readout).toHaveAttribute("data-chart-reading", "latest");
      await chartPanel.getByRole("checkbox", { name: "SMA" }).click();
      await expect(readout).toContainText("SMA20");
      await chartPanel.getByRole("button", { name: "Zoom in" }).click();
      await chartPanel.getByRole("button", { name: "Reset zoom" }).focus();
      await page.keyboard.press("Enter");

      const track = chartPanel.getByRole("region", { name: "Event timeline" });
      await expect(track.getByRole("button", { name: / · B$/ })).toBeVisible();
      await expect(track.getByRole("button", { name: / · S$/ })).toBeVisible();
      const marker = track.getByRole("button", { name: / · T \(\+2\)/ });
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
      await dialog.getByText("Advanced", { exact: true }).click();
      await expect(dialog.getByLabel("Bar interval")).toBeVisible();
      await dialog.getByText("Advanced", { exact: true }).click();
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

  test("a response with no OHLC is visibly identified as closing prices", async ({ page }) => {
    await mockPrices(page, "no OHLC");
    await page.goto("/research?ticker=AAPL&view=overview");
    const overview = page.locator(".mx-price-diagnosis-preview");
    await expect(overview.getByText("OHLC unavailable; closing prices shown")).toBeVisible();
    await expect(overview.getByRole("group", { name: /Three months of closing prices/ })).toHaveAttribute("data-tm-chart-ready", "true");
  });

  test("the index 1D caption says five minutes and empty slots are skipped", async ({ page }) => {
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "available", asOf: "2026-10-30T13:40:00Z", currency: "USD",
      points: [{ at: "2026-10-30T13:30:00Z", value: 500 }, { at: "2026-10-30T13:35:00Z", value: 502 }],
      gaps: ["2026-10-30T13:40:00Z"],
    } }));
    await page.goto("/sectors?market=us&view=indices&index=sp-500&range=1D");
    const history = page.locator(".mx-index-history");
    await expect(history.getByText("Only 2 observations")).toBeVisible();
    const chart = history.locator("[data-tm-chart-ready]");
    await chart.focus();
    await page.keyboard.press("End");
    await expect(history.locator("[data-chart-reading]")).toContainText("502 USD");
    await history.getByRole("button", { name: "Index data and basis" }).click();
    await expect(page.getByText("5-minute bars for the latest trading session.")).toBeVisible();
  });
});
