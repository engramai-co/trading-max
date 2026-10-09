import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { prepareHistory } from "../lib/portfolio/prepared";

const checkedAt = "2026-10-09T12:00:00Z";
const fixture = {
  runId: "synthetic-update-attention", brokerAsOf: checkedAt,
  totalValueGbp: 2000, totalCashGbp: 100, holdings: [],
  accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2000 }],
};
const failing = { checkedAt, issues: [{
  scope: "accounts", consecutiveFailures: 3, failingSince: "2026-10-08T21:00:00Z",
}] };
const history = prepareHistory({ ...fixture, dataRevision: "synthetic" }, { range: "1D", scope: "total" }).chart;

test.describe("overview update attention", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date(checkedAt) });
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = path.includes("/dashboard/lens/") ? fixture
        : path.endsWith("/dashboard/history") ? history
          : path.endsWith("/refresh/attention") ? failing
            : path.endsWith("/health/details") ? { checkedAt, health: null, readiness: null, refresh: null, jobs: [], errors: [] }
            : path.endsWith("/profile") ? { accountLabels: {} } : {};
      return route.fulfill({ json });
    });
  });

  test("fresh valuations still show a warning, retained across a failed check, cleared by recovery", async ({ page }) => {
    await page.goto("/?range=1D");
    const warning = page.locator(".mx-attention").getByRole("link", { name: /账户更新连续失败/ });
    await expect(warning).toHaveText("账户更新连续失败15 小时");
    await expect(warning).toHaveAttribute("href", "/health");
    expect((await new AxeBuilder({ page }).include(".mx-attention").analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Switch to English" }).click();
    await expect(page.locator(".mx-attention")).toContainText("Account updates failing15h");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.locator(".mx-attention").evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.screenshot({ path: test.info().outputPath("overview-update-attention.png") });

    await page.route("**/api/backend/refresh/attention", (route) => route.fulfill({ status: 503, json: {} }));
    await page.clock.runFor(65_000);
    await expect(page.locator(".mx-attention")).toContainText("Account updates failing");
    await page.route("**/api/backend/refresh/attention", (route) => route.fulfill({ json: { checkedAt, issues: [] } }));
    await page.clock.runFor(65_000);
    await expect(page.locator(".mx-attention")).toHaveCount(0);
  });

  test("status latency never blocks the portfolio, and desktop links open activity", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/refresh/attention", async (route) => {
      await gate;
      await route.fulfill({ json: failing });
    });
    try {
      await page.goto("/desktop?range=1D");
      await expect(page.locator(".mx-overview-totals")).toContainText("£2,000.00");
      await expect(page.locator(".mx-attention")).toHaveCount(0);
    } finally {
      release();
    }
    const warning = page.locator(".mx-attention").getByRole("link", { name: /账户更新连续失败/ });
    await expect(warning).toHaveAttribute("href", "/desktop/activity");
    await expect(warning).toHaveAttribute("target", "_blank");
  });
});
