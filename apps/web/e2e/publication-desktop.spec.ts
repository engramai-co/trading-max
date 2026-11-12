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

test.describe("web build changes", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Use an isolated production build.");

  test("waits for a same-window workspace link, leaving query controls and desktop windows alone", async ({ page, request, isMobile }) => {
    test.skip(isMobile, "Desktop tools are not shown at phone widths.");
    const response = await request.get("/api/backend/health");
    const builtId = response.headers()["x-trading-max-web-build"];
    expect(builtId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers()["cache-control"]).toBe("private, no-store");

    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let buildId = builtId;
    let checks = 0;
    await page.route("**/api/backend/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/health")) {
        checks++;
        return route.fulfill({
          headers: { "x-trading-max-web-build": buildId },
          json: { service: "trading_max-api", status: "ok", latestRunId: null },
        });
      }
      if (path.endsWith("/profile")) return route.fulfill({ json: { accountLabels: {} } });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/desktop/holdings");
    await expect.poll(() => checks).toBe(1);
    await page.evaluate(() => { document.body.dataset.oldDocument = "yes"; });
    buildId = "synthetic-new-build";
    await page.clock.fastForward(60_001);
    await expect.poll(() => checks).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("body")).toHaveAttribute("data-old-document", "yes");
    const lookthrough = page.getByRole("tab", { name: /Look.through/i });
    await lookthrough.click();
    await expect(page).toHaveURL(/\/desktop\/holdings\?view=lookthrough/);
    await expect(page.locator("body")).toHaveAttribute("data-old-document", "yes");

    const [settings] = await Promise.all([
      page.waitForEvent("popup"),
      page.locator('.mx-desktop-tools a[href="/desktop/settings"]').click(),
    ]);
    await expect(settings).toHaveURL(/\/desktop\/settings$/);
    await settings.close();
    await expect(page.locator("body")).toHaveAttribute("data-old-document", "yes");

    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: /Research/ }).click();
    await expect(page).toHaveURL(/\/desktop\/research$/);
    await expect(page.locator("body")).not.toHaveAttribute("data-old-document", "yes");
  });

  test("defers the full navigation for a preferences draft and pending save, then takes the command search destination", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let checks = 0;
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { finishSave = resolve; });
    const profile = {
      profileId: "synthetic", displayName: "Synthetic", initials: "S", avatarColor: "blue", locale: "en",
      baseCurrency: "GBP", timezone: "Europe/London", accountLabels: {}, revision: 1, updatedAt: "2026-01-01T00:00:00Z",
    };
    await page.route("**/api/backend/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/health")) {
        checks++;
        return route.fulfill({
          headers: { "x-trading-max-web-build": "synthetic-new-build" },
          json: { service: "trading_max-api", status: "ok", latestRunId: null },
        });
      }
      if (path.endsWith("/settings/integrations")) return route.fulfill({ json: { profile, integrations: [], llmProviders: [] } });
      if (path.endsWith("/profile")) {
        if (route.request().method() === "PATCH") await pendingSave;
        return route.fulfill({ json: profile });
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/settings?tab=preferences");
    await page.getByRole("textbox", { name: "Display name" }).fill("Synthetic draft");
    await expect.poll(() => checks).toBe(1);
    await page.evaluate(() => { document.body.dataset.oldDocument = "yes"; });
    const holdings = page.getByRole("navigation", { name: isMobile ? "Quick navigation" : "Primary navigation" })
      .getByRole("link", { name: isMobile ? "Assets" : "Holdings", exact: true });
    await holdings.click();
    await expect(page).toHaveURL(/\/holdings$/);
    await expect(page.locator("body")).toHaveAttribute("data-old-document", "yes");

    await page.goBack();
    await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue("Synthetic");
    const saving = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith("/profile"));
    await page.getByRole("button", { name: "Save preferences" }).click();
    await saving;
    try {
      await holdings.click();
      await expect(page).toHaveURL(/\/holdings$/);
      await expect(page.locator("body")).toHaveAttribute("data-old-document", "yes");
    } finally {
      const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith("/profile"));
      finishSave();
      await saved;
    }

    await page.getByRole("button", { name: "Search pages or securities", exact: true }).click();
    const input = page.getByRole("combobox", { name: /Search/ });
    await input.fill("TWR");
    await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/analytics\?view=returns$/);
    await expect(page.locator("body")).not.toHaveAttribute("data-old-document", "yes");
  });
});
