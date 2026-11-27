import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { IndexIdentity } from "../workspace/market-indices-data";

const base = Date.UTC(2026, 9, 5, 10, 30);
const observations = Array.from({ length: 20 }, (_, i) => ({ at: new Date(base + i * 300_000).toISOString(), value: 500 + i }));

test.describe("chart evidence and fullscreen", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a seeded local preview.");

  test.beforeEach(async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("each canvas initialises once and fullscreen preserves readings and restores focus", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mantine-color-scheme-value", "auto"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "available", range: "1D", index: { scope: "us", source: "Synthetic index" }, asOf: observations.at(-1)!.at, currency: "USD",
      points: observations.filter((_, index) => index !== 9), gaps: [observations[9].at],
    } }));
    await page.goto("/sectors?market=us&index=sp-500&range=1D");
    const index = page.locator(".mx-index-history");
    const chart = index.locator("[data-tm-chart-ready]").first();
    const open = index.getByRole("button", { name: "Fullscreen", exact: true });
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-tm-chart-init-count", "1");
    await chart.press("End");
    await chart.press("Enter");
    await expect(chart).toHaveAttribute("data-tm-chart-init-count", "1");
    await open.click();
    const full = page.getByRole("dialog");
    const fullCanvas = full.locator("[data-tm-chart-ready]");
    await expect(full).toBeVisible();
    await expect(fullCanvas).toHaveAttribute("data-tm-chart-init-count", "1");
    await page.locator(".mx-skip").evaluate((skip: HTMLElement) => skip.focus());
    await expect(full.getByRole("button", { name: "Exit fullscreen" })).toBeFocused();
    await expect(full.locator("[data-chart-reading=selected]")).toContainText("519.00");
    await expect(full.locator("[data-chart-reading=selected]")).not.toContainText("USD");

    await full.getByRole("button", { name: "Zoom in", exact: true }).click();
    const more = full.getByRole("button", { name: "More", exact: true });
    await more.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Copy reading" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.click();
    const csvReady = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export CSV" }).click();
    const csv = await readFile((await (await csvReady).path())!, "utf-8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("time,zone,currency,basis,source,gap_type,series,value");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.length).toBeLessThan(observations.length);
    expect(csv).not.toContain(observations[9].at);
    expect(csv).toContain("after-missing-observation");
    // Mobile WebKit can preview generated images instead of emitting a native download event.
    if (!test.info().project.use.isMobile) {
      const sampleCorner = async (pngBytes: Buffer) => page.evaluate(async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const [r, g, b] = ctx.getImageData(2, 2, 1, 1).data;
        bitmap.close();
        return [r, g, b] as const;
      }, [...pngBytes]);

      const html = page.locator("html");
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expect(html).toHaveAttribute("data-mantine-color-scheme", scheme);
        const expected = await html.evaluate((root) => {
          const swatch = document.createElement("span");
          swatch.style.color = "var(--card)";
          root.append(swatch);
          const channels = getComputedStyle(swatch).color.match(/\d+/g)?.map(Number);
          swatch.remove();
          return channels;
        });
        await full.getByRole("button", { name: "More", exact: true }).click();
        const pngReady = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Export PNG" }).click();
        const png = await readFile((await (await pngReady).path())!);
        expect(png.subarray(1, 4).toString()).toBe("PNG");
        expect(await sampleCorner(png)).toEqual(expected);
      }
    }
    await fullCanvas.press("End");
    await fullCanvas.press("ArrowLeft");
    await fullCanvas.press("Enter");
    await expect(full.locator("[data-chart-reading=selected]")).toContainText("518.00");
    await full.getByRole("button", { name: "Exit fullscreen" }).press("Enter");
    await expect(full).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(chart).toHaveAttribute("data-tm-chart-init-count", "1");
    await expect(index.locator("[data-chart-reading=selected]")).toContainText("518.00");
  });

  test("index risk shows a gap as unverified recovery", async ({ page }) => {
    const points = [
      { at: "2026-10-05T00:00:00Z", value: 100 },
      { at: "2026-10-06T00:00:00Z", value: 72 },
      { at: "2026-10-08T00:00:00Z", value: 103 },
      { at: "2026-10-09T00:00:00Z", value: 98 },
    ];
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "partial", range: "1Y", index: { scope: "us", source: "Synthetic index" }, asOf: points.at(-1)!.at, currency: "USD", points, gaps: ["2026-10-07T00:00:00Z"],
    } }));
    await page.goto("/sectors?market=us&index=sp-500&range=1Y");
    await page.getByText("Index drawdown", { exact: true }).click();
    const reading = page.locator(".mx-drawdown-reading");
    await expect(reading).toContainText("Peak uses the selected range");
    await expect(reading).toContainText("Recovery unverified across a gap");
    await expect(reading).toContainText(/−28|-28/);
  });

  test("a scheme switch during delayed chart initialization preserves a later zoom", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mantine-color-scheme-value", "auto"));
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const identity: IndexIdentity = {
      id: "sp-500", name: "Synthetic index", nameZh: "合成指数", scope: "us",
      source: "Synthetic", kind: "index", basis: "price", currency: "USD",
      symbol: "SYN", seriesCode: "SYN", ranges: ["1D"], calendar: "SYNTH",
      aliases: [], compiler: "Synthetic fixture", compilerId: "synthetic",
      familyId: "synthetic", hedging: "unhedged", historyYears: 1, rights: "provider-terms",
    };
    await page.route("**/api/backend/indices/catalog", (route) => route.fulfill({ json: [identity] }));
    const { promise: heldHistory, resolve: releaseHistory } = Promise.withResolvers<void>();
    await page.route("**/api/backend/indices/sp-500/history?**", async (route) => {
      await heldHistory;
      await route.fulfill({ json: {
        state: "available", range: "1D", index: identity,
        asOf: observations.at(-1)!.at, currency: "USD", points: observations, gaps: [],
      } });
    });
    const hold = await page.goto("/sectors?market=us&index=sp-500&range=1D")
      .then(() => page.addStyleTag({ content: ".mx-index-history .mx-plot > [role=group] { width: 0 !important; }" }))
      .finally(releaseHistory);
    const index = page.locator(".mx-index-history");
    const plot = index.locator(".mx-plot > [role=group]");
    await expect(plot).toBeAttached();
    await expect(plot).not.toHaveAttribute("data-tm-chart-ready");

    const html = page.locator("html");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect(html).toHaveAttribute("data-mantine-color-scheme", "light");
    await hold.evaluate((style) => style.parentNode?.removeChild(style));
    await expect(plot).toHaveAttribute("data-tm-chart-ready", "true");
    await index.getByRole("button", { name: "Fullscreen", exact: true }).click();
    const full = page.getByRole("dialog");

    async function visibleRecords() {
      await full.getByText("More", { exact: true }).click();
      const ready = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "Export CSV" }).click();
      const csv = await readFile((await (await ready).path())!, "utf8");
      return csv;
    }
    const all = await visibleRecords();
    await full.getByRole("button", { name: "Zoom in" }).click();
    const zoomed = await visibleRecords();
    expect(zoomed.length).toBeLessThan(all.length);

    const applied = await plot.getAttribute("data-tm-chart-applied-at");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
    await expect(plot).not.toHaveAttribute("data-tm-chart-applied-at", applied!);
    expect(await visibleRecords()).toBe(zoomed);
  });

  test("quarterly EPS uses dates, same-quarter estimates and a signed surprise", async ({ page, isMobile }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { ...json, analyst: {
        ...json.analyst, reportingCurrency: "USD", earningsEstimate: [],
        earningsHistory: [
          { quarter: "2026-06-30", epsActual: 1.25, epsEstimate: 2 },
          { quarter: "2026-09-30", epsActual: 2.25, epsEstimate: 2 },
        ],
      } } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst");
    await page.getByRole("heading", { name: "Quarterly EPS", exact: true }).scrollIntoViewIfNeeded();
    const chart = page.getByRole("group", { name: "Reported and estimated quarterly EPS" });
    // The live region sits beside the plot frame, inside the chart's host.
    const reading = chart.locator("xpath=../../..").locator("[data-chart-reading]");
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    // Reported leads; the surprise is signed with the typographic minus and no currency.
    await expect(reading).toContainText("Reported 2.25");
    await expect(reading).toContainText("Surprise +0.25");
    await chart.press("Home");
    await expect(reading).toContainText("Surprise \u22120.75");
    // Desktop shows the card at the top of the plot; phones read in the strip above it.
    const popup = isMobile ? page.locator(".mx-chart-strip") : chart.locator("..").locator(".mx-chart-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Surprise\u22120.75");
    await expect(popup).not.toContainText("USD");
    const [card, plot] = [(await popup.boundingBox())!, (await chart.boundingBox())!];
    if (isMobile) expect(card.y + card.height).toBeLessThanOrEqual(plot.y + 1);
    else {
      expect(card.y).toBeGreaterThanOrEqual(plot.y - 1);
      expect(card.y + card.height).toBeLessThanOrEqual(plot.y + plot.height + 1);
    }
    await chart.press("Escape");
    await expect(popup).toBeHidden();
  });

  test("inline chart controls stay in keyboard tab order before and after fullscreen", async ({ page, isMobile }) => {
    test.skip(isMobile, "Tab traversal across native buttons is desktop keyboard behaviour.");
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "available", range: "1D", index: { scope: "us", source: "Synthetic index" }, asOf: observations.at(-1)!.at, currency: "USD",
      points: observations, gaps: [],
    } }));
    await page.goto("/sectors?market=us&index=sp-500&range=1D");
    const index = page.locator(".mx-index-history");
    const host = index.locator(".mx-chart-host").first();
    const more = index.getByRole("button", { name: "More", exact: true });
    const open = index.getByRole("button", { name: "Fullscreen", exact: true });
    const chart = index.locator("[data-tm-chart-ready]").first();
    await expect(chart).toBeVisible();

    const verifyRoundTrip = async () => {
      await more.focus();
      await expect(more).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(open).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(chart).toBeFocused();
      await page.keyboard.press("Tab");
      expect(await host.evaluate((node) => node.contains(document.activeElement))).toBe(false);
      await page.keyboard.press("Shift+Tab");
      await expect(chart).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(open).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(more).toBeFocused();
    };

    await verifyRoundTrip();

    // Open fullscreen, zoom in, close, and verify inline tab order and zoom both survive.
    await open.click();
    const full = page.getByRole("dialog");
    await expect(full).toBeVisible();
    await full.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(full).toHaveCount(0);
    await expect(open).toBeFocused();

    await verifyRoundTrip();

    // Preserved zoom still limits exported CSV records inline after closing fullscreen.
    await more.click();
    const csvReady = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export CSV" }).click();
    const csv = await readFile((await (await csvReady).path())!, "utf-8");
    const rows = csv.trim().split(/\r?\n/).slice(1);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.length).toBeLessThan(observations.length);
  });

  test("chart action feedback shows visibly beside More on clipboard success and failure", async ({ page }) => {
    await page.addInitScript(() => {
      let shouldFail = false;
      (window as unknown as { __setClipboardFail?: (v: boolean) => void }).__setClipboardFail = (v) => { shouldFail = v; };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: () => shouldFail ? Promise.reject(new Error("denied")) : Promise.resolve(),
          writeText: () => shouldFail ? Promise.reject(new Error("denied")) : Promise.resolve(),
        },
      });
    });
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "available", range: "1D", index: { scope: "us", source: "Synthetic index" }, asOf: observations.at(-1)!.at, currency: "USD",
      points: observations, gaps: [],
    } }));
    await page.goto("/sectors?market=us&index=sp-500&range=1D");
    const index = page.locator(".mx-index-history");
    await expect(index.locator("[data-tm-chart-ready]").first()).toBeVisible();

    const more = index.getByRole("button", { name: "More", exact: true });
    await more.click();
    await page.getByRole("menuitem", { name: "Copy reading" }).click();
    const status = index.locator(".mx-chart-status[role=status]");
    await expect(status).toBeVisible();
    await expect(status).toHaveText("Copied");
    const box = (await status.boundingBox())!;
    expect(box.width).toBeGreaterThan(10);
    expect(box.height).toBeGreaterThan(10);

    await page.evaluate(() => (window as unknown as { __setClipboardFail?: (v: boolean) => void }).__setClipboardFail?.(true));
    await more.click();
    await page.getByRole("menuitem", { name: "Copy reading" }).click();
    await expect(status).toBeVisible();
    await expect(status).toHaveText("Action unavailable");
  });
});

async function pinchIndex(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
    state: "available", range: "1D", index: { scope: "us", source: "Synthetic index" }, asOf: observations.at(-1)!.at, currency: "USD", points: observations, gaps: [],
  } }));
  await page.goto("/sectors?market=us&index=sp-500&range=1D");
  await page.locator(".mx-index-history").getByRole("button", { name: "Fullscreen", exact: true }).click();
  const full = page.getByRole("dialog");
  const chart = full.locator("[data-tm-chart-ready]");
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;
  const x = Math.floor(box.x + box.width * 0.55);
  const y = Math.floor(box.y + 110);
  async function visibleRecords() {
    await full.getByText("More", { exact: true }).click();
    const ready = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export CSV" }).click();
    const data = await readFile((await (await ready).path())!, "utf-8");
    return data.trimEnd().split(/\r?\n/).slice(1);
  }
  expect(await visibleRecords()).toHaveLength(20);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }] });
  for (const dx of [38, 46, 54, 62]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - dx, y, id: 1 }, { x: x + dx, y, id: 2 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const zoomed = await visibleRecords();
  expect(zoomed.length).toBeLessThan(20);
  expect(zoomed.length).toBeGreaterThan(3);
  return { cdp, x, y, zoomed, visibleRecords };
}

test("a pinch zooms while a vertical swipe leaves the time range alone", async ({ browser, page, isMobile }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL || isMobile || browser.browserType().name() !== "chromium", "Uses Chromium touch input.");
  const { cdp, x, y, zoomed, visibleRecords } = await pinchIndex(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (const dy of [10, 24, 48, 75]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 2, y: y - dy, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await visibleRecords()).toEqual(zoomed);
});

test("a delayed index context preserves the pinch-zoomed records", async ({ browser, page, isMobile }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL || isMobile || browser.browserType().name() !== "chromium", "Uses Chromium touch input.");
  const { promise: gate, resolve: releaseContext } = Promise.withResolvers<void>();
  await page.route("**/api/backend/indices/sp-500/context", async (route) => {
    await gate;
    await route.fulfill({ json: {} });
  });
  const { visibleRecords, zoomed } = await pinchIndex(page);
  releaseContext();
  await expect(page.locator(".mx-index-holdings h3")).toHaveText("Tracking ETFs I hold");
  expect(await visibleRecords()).toEqual(zoomed);
});
