import { expect, test } from "@playwright/test";

test("desktop settings retain a draft through a publication outage and recovery", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Use an isolated synthetic local build.");
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  let checks = 0;
  let settingsReads = 0;
  let available = true;
  let latestRunId = "synthetic-desktop-one";
  await page.route("**/api/backend/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/health")) {
      checks++;
      return available ? route.fulfill({ json: { service: "trading_max-api", status: "ok", latestRunId } })
        : route.fulfill({ status: 503, json: {} });
    }
    if (path.endsWith("/settings/integrations")) {
      settingsReads++;
      return route.fulfill({ json: { profile: { accountLabels: {} }, integrations: [], llmProviders: [], llmRoutePolicy: null } });
    }
    if (path.endsWith("/profile")) return route.fulfill({ json: { accountLabels: {} } });
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/desktop/settings");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const draft = dialog.getByLabel(/^API Key ID/);
  await draft.fill("synthetic-test-id");
  await expect(draft).toBeFocused();
  await expect.poll(() => checks).toBe(1);

  available = false;
  await page.clock.fastForward(60_000);
  await expect.poll(() => checks).toBe(2);
  await expect(draft).toHaveValue("synthetic-test-id");
  await expect(draft).toBeFocused();

  available = true;
  latestRunId = "synthetic-desktop-two";
  await page.clock.fastForward(61_000);
  await expect.poll(() => checks).toBe(3);
  await expect(draft).toHaveValue("synthetic-test-id");
  await expect(draft).toBeFocused();
  await expect(page).toHaveURL(/\/desktop\/settings$/);
  expect(settingsReads).toBe(1);
});
