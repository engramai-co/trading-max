import { expect, test } from "@playwright/test";

const currentRun = "synthetic-confirmed-run";
const state = {
  name: "Synthetic workspace", path: "synthetic-workspace",
  connectedAccounts: ["invest"], latestFullJob: null, activeJobId: null,
  canConfirm: true, confirmed: false,
  readiness: { status: "ready", latestRunId: currentRun },
};

test("idle local setup announces a failed poll and successful retry with cached status", async ({ page }) => {
  test.skip(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID !== "synthetic-onboarding",
    "Requires the synthetic first-sync workspace preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const idle = { ...state, canConfirm: false, readiness: { status: "not_ready" } };
  let available = true;
  await page.route("**/api/backend/local-workspace", (route) => available
    ? route.fulfill({ json: idle })
    : route.fulfill({ status: 503 }));
  await page.goto("/settings?tab=accounts&onboarding=1");
  const panel = page.getByRole("tabpanel", { name: "Accounts & data" });
  const start = panel.getByRole("button", { name: "Start first sync" });
  const failure = panel.getByRole("status").filter({ hasText: "Workspace status could not be refreshed." });
  const recovery = panel.getByRole("status").filter({ hasText: "Set up your local workspace · Data is available again." });
  await expect(start).toBeEnabled();
  await expect(recovery).toHaveCount(0);

  available = false;
  const warning = panel.getByRole("note").filter({ hasText: "Workspace status could not be refreshed." });
  await expect(warning).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(failure).toHaveCount(1);
  const announcer = await failure.elementHandle();
  await expect(recovery).toHaveCount(0);

  const retry = warning.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  available = true;
  await retry.click();
  await expect(start).toBeEnabled();
  await expect(warning).toHaveCount(0);
  await expect(recovery).toHaveCount(1);
  await expect(failure).toHaveCount(0);
  expect(await recovery.evaluate((element, original) => element === original, announcer)).toBe(true);
});

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
