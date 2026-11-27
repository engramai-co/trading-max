import { expect, test } from "@playwright/test";

const currentRun = "synthetic-confirmed-run";
const state = {
  name: "Synthetic workspace", path: "synthetic-workspace",
  connectedAccounts: ["invest"], latestFullJob: null, activeJobId: null,
  canConfirm: true, confirmed: false,
  readiness: { status: "ready", latestRunId: currentRun },
};

for (const trigger of ["retry", "reconnect"] as const) {
  test(`first-sync balance ${trigger} announces recovery only after validating the run`, async ({ page, context }) => {
    test.skip(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID !== "synthetic-onboarding",
      "Requires the synthetic first-sync workspace preview.");
    let balanceRun = "synthetic-wrong-run";
    let reads = 0;
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/local-workspace", route => route.fulfill({ json: state }));
    await page.route("**/api/backend/dashboard/lens/overview?detail=summary", route => {
      reads += 1;
      return route.fulfill({ json: {
        runId: balanceRun, totalValueGbp: 2_050,
        accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2_050 }],
      } });
    });
    await page.goto("/settings?tab=accounts&onboarding=1");
    const setup = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: "Set up your local workspace", exact: true }) }).first();
    const retry = setup.getByRole("button", { name: "Try again" });
    const recovered = page.getByRole("status").filter({ hasText: "Data is available again." });
    await expect(retry).toBeVisible();
    const rejected = reads;
    await retry.click();
    await expect.poll(() => reads).toBe(rejected + 2);
    await expect(retry).toBeVisible();
    await expect(setup.getByRole("checkbox")).toHaveCount(0);
    await expect(setup.getByRole("status").filter({ hasText: "Balance check · Data is temporarily unavailable" })).toHaveCount(1);
    await expect(recovered).toHaveCount(0);

    balanceRun = currentRun;
    if (trigger === "retry") {
      await retry.click();
    } else {
      // Reconnect is automatic. Observe it separately from the manual retry callback.
      await context.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
      await context.setOffline(false);
    }
    await expect(setup.getByText("£2,050.00")).toBeVisible();
    await expect(recovered).toHaveCount(1);
    await expect(recovered).toHaveText("Balance check · Data is available again.");
    await expect(retry).toHaveCount(0);
  });
}
