import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const base = Date.UTC(2026, 9, 5, 10, 30);
const observations = Array.from({ length: 20 }, (_, i) => ({ at: new Date(base + i * 300_000).toISOString(), value: 500 + i }));

test.describe("chart evidence and fullscreen", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a seeded local preview.");

  test.beforeEach(async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("fullscreen preserves a reading, downloads only visible records and restores focus", async ({ page }) => {
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "available", asOf: observations.at(-1)!.at, currency: "USD",
      points: observations.filter((_, index) => index !== 9), gaps: [observations[9].at],
    } }));
    await page.goto("/sectors?market=us&index=sp-500&range=1D");
    const index = page.locator(".mx-index-history");
    const chart = index.locator("[data-tm-chart-ready]").first();
    const open = index.getByRole("button", { name: "Fullscreen", exact: true });
    await expect(chart).toBeVisible();
    await chart.press("End");
    await chart.press("Enter");
    await open.click();
    const full = page.getByRole("dialog");
    await expect(full).toBeVisible();
    await expect(full.locator("[data-chart-reading=selected]")).toContainText("519 USD");

    await full.getByRole("button", { name: "Zoom in", exact: true }).click();
    await full.getByText("More", { exact: true }).click();
    const csvReady = page.waitForEvent("download");
    await full.getByRole("button", { name: "Export CSV" }).click();
    const csv = await readFile((await (await csvReady).path())!, "utf-8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("time,zone,currency,basis,source,gap_type,series,value");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.length).toBeLessThan(observations.length);
    expect(csv).not.toContain(observations[9].at);
    expect(csv).toContain("after-missing-observation");
    // Mobile WebKit can preview generated images instead of emitting a native download event.
    if (!test.info().project.use.isMobile) {
      const pngReady = page.waitForEvent("download");
      await full.getByRole("button", { name: "Export PNG" }).click();
      const png = await readFile((await (await pngReady).path())!);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
    await full.getByRole("button", { name: "Exit fullscreen" }).focus();
    await page.keyboard.press("Escape");
    await expect(full).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test("index risk shows a gap as unverified recovery", async ({ page }) => {
    const points = [
      { at: "2026-10-05T00:00:00Z", value: 100 },
      { at: "2026-10-06T00:00:00Z", value: 72 },
      { at: "2026-10-08T00:00:00Z", value: 103 },
      { at: "2026-10-09T00:00:00Z", value: 98 },
    ];
    await page.route("**/api/backend/indices/sp-500/history?**", (route) => route.fulfill({ json: {
      state: "partial", asOf: points.at(-1)!.at, currency: "USD", points, gaps: ["2026-10-07T00:00:00Z"],
    } }));
    await page.goto("/sectors?market=us&index=sp-500&range=1Y");
    await page.getByText("Index drawdown", { exact: true }).click();
    const reading = page.locator(".mx-drawdown-reading");
    await expect(reading).toContainText("Peak uses the selected range");
    await expect(reading).toContainText("Recovery unverified across a gap");
    await expect(reading).toContainText(/−28|-28/);
  });

  test("quarterly EPS uses dates, same-quarter estimates and a signed surprise", async ({ page }) => {
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
    const chart = page.getByRole("group", { name: "Reported and estimated quarterly EPS" });
    const reading = chart.locator("..").locator("..").locator("[data-chart-reading]");
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await expect(reading).toContainText("Difference +0.25 USD");
    await chart.press("Home");
    await expect(reading).toContainText("Difference -0.75 USD");
    expect((await reading.boundingBox())!.y + (await reading.boundingBox())!.height).toBeLessThanOrEqual((await chart.boundingBox())!.y + 1);
  });
});
