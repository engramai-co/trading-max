import { expect, test } from "@playwright/test";

test.describe("data status and scheduled updates", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test("a dated published snapshot can coexist with an empty job log", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const queue = { queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0 };
    const worker = { healthy: true };
    await page.route("**/api/backend/health/details", (route) => route.fulfill({ json: {
      checkedAt: "2026-11-15T00:00:00Z",
      health: { status: "ok", latestRunId: "synthetic-existing-snapshot", worker, queue, artifactAgeSeconds: 432_000 },
      readiness: { status: "ready", latestRunId: "synthetic-existing-snapshot", worker, queue },
      refresh: {}, jobs: [], errors: [],
    } }));
    await page.goto("/health");
    await expect(page.getByRole("heading", { name: /no completed update for 5d/ })).toBeVisible();
    await expect(page.locator(".mx-health-hero").getByText("Published snapshot", { exact: false })).toBeVisible();
    await expect(page.getByText("No update jobs recorded")).toBeVisible();
    await expect(page.getByText("Your first update starts here")).toHaveCount(0);
    await page.getByText("What each schedule updates", { exact: true }).click();
    await expect(page.getByText(/calculate returns, drawdowns and risk from reconciled account history/)).toBeVisible();
    await page.getByRole("link", { name: "Manage schedule" }).click();
    await expect(page.getByRole("link", { name: "See the schedule and update history" })).toBeVisible();
    await expect(page.getByText(/calculate returns, drawdowns and risk from reconciled account history/)).toHaveCount(0);
  });

  test("a delayed or timed-out research directory still names the requested listing", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/research/shell", async (route) => {
      await gate;
      await route.fulfill({ status: 504, json: {} });
    });
    await page.goto("/research?ticker=SYNTH");
    await expect(page.getByRole("heading", { name: "SYNTH", exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("heading", { name: "Data request timed out" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "SYNTH", exact: true })).toBeVisible();
  });
});
