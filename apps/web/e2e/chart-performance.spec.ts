import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const size = 50_000;
const start = Date.UTC(2025, 10, 15);
const data = (base: number) => Array.from({ length: size }, (_, i) => ({
  at: new Date(start + i * 600_000).toISOString(),
  value: base + i * 0.005 + Math.sin(i * 0.02) * 23 + (i === 12_798 ? 80 : i === 33_341 ? -40 : 0),
}));
const left = data(500), right = data(600);
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test("benchmarks two 50k-point index lines at 4× CPU", async ({ browser, page, isMobile }) => {
  test.skip(!process.env.CHART_BENCH || isMobile || browser.browserType().name() !== "chromium", "Opt-in Chromium benchmark.");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("trading_max-locale", "en");
    const original = Response.prototype.json;
    let histories = 0;
    Response.prototype.json = async function () {
      const parsed = await original.call(this);
      if (this.url.includes("/indices/") && this.url.includes("/history?") && this.url.includes("range=1Y") && ++histories === 2) {
        performance.mark("chart-bench:data-ready");
      }
      return parsed;
    };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.route("**/api/backend/indices/*/history?**", async (route) => {
    const uri = new URL(route.request().url());
    const series = uri.pathname.includes("nasdaq") ? right : left;
    const range = uri.searchParams.get("range");
    const points = range === "3M" ? series.slice(-12_000) : series;
    await route.fulfill({ json: { state: "available", asOf: points.at(-1)!.at, currency: "USD", points, gaps: [] } });
  });
  const startups: number[] = [], frames: number[] = [];
  const host = page.locator(".mx-index-history");
  const plot = host.locator("[data-tm-chart-ready=true]").first();
  for (let i = 0; i < 8; i++) {
    await page.goto("/sectors?market=us&index=sp-500&compare=nasdaq-100&range=1Y");
    await expect(host.locator(".mx-index-legend")).toBeVisible();
    await expect(plot).toBeVisible();
    await expect.poll(async () => Number(await plot.getAttribute("data-tm-chart-applied-at"))).toBeGreaterThan(0);
    const ready = await page.evaluate(() => performance.getEntriesByName("chart-bench:data-ready").at(-1)!.startTime);
    const applied = Number(await plot.getAttribute("data-tm-chart-applied-at"));
    startups.push(Math.max(0, applied - ready));
    // Measure the synchronous event and scheduled frame work. Timer wait and
    // browser paint times are deliberately excluded from the CPU frame budget.
    const sample = await plot.evaluate(async (element) => {
      const node = element as HTMLDivElement;
      const box = node.getBoundingClientRect();
      const durations: number[] = [];
      const original = window.requestAnimationFrame;
      let pending: number[] = [];
      window.requestAnimationFrame = (callback) => original((at) => {
        const started = performance.now();
        callback(at);
        pending.push(performance.now() - started);
      });
      try {
        for (let frame = 0; frame < 15; frame++) {
          pending = [];
          const time = performance.now();
          node.dispatchEvent(new PointerEvent("pointermove", {
            clientX: box.left + 70 + frame * 12, clientY: box.top + 60, pointerType: "mouse", bubbles: true,
          }));
          const processing = performance.now() - time;
          await new Promise<void>((resolve) => original(() => original(() => resolve())));
          durations.push(processing + pending.reduce((sum, elapsed) => sum + elapsed, 0));
        }
      } finally {
        window.requestAnimationFrame = original;
        node.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
      }
      return durations;
    });
    frames.push(...sample);
  }
  const ranges: number[] = [];
  const controls = host.getByRole("group", { name: "Range" });
  await controls.getByRole("button", { name: "3M", exact: true }).click();
  await expect(host.locator(".mx-index-legend")).toBeVisible();
  await expect(plot).toBeVisible();
  for (let i = 0; i < 10; i++) {
    const from = Number(await plot.getAttribute("data-tm-chart-applied-at"));
    const to = i % 2 === 0 ? "1Y" : "3M";
    const button = controls.getByRole("button", { name: to, exact: true });
    const began = await button.evaluate((node) => {
      const stamp = performance.now();
      (node as HTMLButtonElement).click();
      return stamp;
    });
    await expect.poll(async () => Number(await plot.getAttribute("data-tm-chart-applied-at"))).toBeGreaterThan(from);
    ranges.push(Number(await plot.getAttribute("data-tm-chart-applied-at")) - began);
  }
  const summary = { samples: { startup: startups, crosshair: frames, localRange: ranges },
    p95: { startup: p95(startups), crosshair: p95(frames), localRange: p95(ranges) } };
  const folder = process.env.CHART_QA_DIR;
  if (folder) await writeFile(join(folder, "performance.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary.p95));
  if (folder) for (const width of [390, 480, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(host).toBeVisible();
    await host.screenshot({ path: join(folder, `dense-index-${width}.png`) });
  }
  expect(summary.p95.startup).toBeLessThanOrEqual(500);
  expect(summary.p95.crosshair).toBeLessThanOrEqual(16.7);
  expect(summary.p95.localRange).toBeLessThanOrEqual(150);
});
