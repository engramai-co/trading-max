import { expect, test, type Page } from "@playwright/test";
import { prepareHistory, type HistorySelection } from "../lib/portfolio/prepared";
import type { NavPoint } from "../lib/types";
import { snapshotCacheStorageKey } from "../lib/snapshot-cache";

const at = "2026-11-10T15:00:00Z";
const runId = "synthetic-cache-run";
const points = [
  { date: "2026-11-10T09:00:00Z", total: 250, totalNetContributionsGbp: 100, intraday: true, valuationSource: "broker" as const },
  { date: at, total: 456, totalNetContributionsGbp: 100, intraday: true, valuationSource: "broker" as const },
] as NavPoint[];
const lens = {
  brokerAsOf: at, runId, dataRevision: "synthetic", totalValueGbp: 456,
  accounts: [{ code: "A", isInvestable: true, totalValueGbp: 456 }], holdings: [],
};
const historyInput = { runId, brokerAsOf: at, dataRevision: "synthetic", nav: points, intradayNav: points };

async function mockReads(page: Page, wait: () => Promise<void>, current: () => number) {
  const calls = { lens: 0, history: 0 };
  await page.route("**/api/backend/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/dashboard/lens/overview")) {
      calls.lens++;
      await wait();
      return route.fulfill({ json: { ...lens, totalValueGbp: current() } });
    }
    if (url.pathname.endsWith("/dashboard/history")) {
      calls.history++;
      await wait();
      const range = url.searchParams.get("range") as HistorySelection["range"];
      return route.fulfill({ json: prepareHistory(historyInput, { range, scope: "total" }).chart });
    }
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { service: "trading_max-api", status: "ok", latestRunId: runId } });
    if (url.pathname.endsWith("/profile")) return route.fulfill({ json: { accountLabels: { A: "Synthetic profile only" } } });
    return route.fulfill({ status: 404, json: {} });
  });
  return calls;
}

test.describe("persistent snapshot cache", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Use an isolated local build.");

  test("cold reopen shows the old number and source time while revalidating all restored reads", async ({ context, page }) => {
    await context.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await mockReads(page, async () => {}, () => 456);
    // Choose a range distinct from Today so the reopen has two independent history reads.
    await page.goto("/?range=3M");
    await expect(page.locator(".mx-metric-large")).toContainText("£456.00");
    const asOf = await page.locator(".mx-summary .mx-freshness").innerText();
    expect(asOf).toContain("Data as of");
    expect(asOf).toContain("10 Nov 15:00");
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), snapshotCacheStorageKey)).toContain("portfolio-history");
    const raw = await page.evaluate((key) => localStorage.getItem(key), snapshotCacheStorageKey);
    expect(raw).not.toContain("Synthetic profile only");
    expect(raw).not.toContain("workspace-profile");

    // A new document has no in-memory QueryClient. Hold all network snapshots
    // until the persisted values have been shown.
    await page.close();
    const reopened = await context.newPage();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const calls = await mockReads(reopened, () => held, () => 789);
    try {
      await reopened.goto("/?range=3M");
      await expect(reopened.locator(".mx-metric-large")).toContainText("£456.00");
      await expect(reopened.locator(".mx-summary .mx-freshness")).toHaveText(asOf);
      await expect.poll(() => calls).toEqual({ lens: 1, history: 2 });
    } finally {
      release();
    }
    await expect(reopened.locator(".mx-metric-large")).toContainText("£789.00");
  });

  test("works when Web Storage is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("Storage disabled", "SecurityError"); },
      });
    });
    await mockReads(page, async () => {}, () => 456);
    await page.goto("/");
    await expect(page.locator(".mx-metric-large")).toContainText("£456.00");
  });
});
