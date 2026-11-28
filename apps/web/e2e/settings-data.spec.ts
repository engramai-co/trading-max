import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { IntegrationOverview, IntegrationSummary } from "../lib/types";

function alpaca(enabled: boolean, revision = 1): IntegrationSummary {
  return {
    integrationId: "synthetic-alpaca",
    provider: "alpaca",
    profile: null,
    enabled,
    configured: true,
    model: null,
    baseUrl: null,
    credentialFingerprint: "synthetic",
    needsSecret: false,
    lastTestAt: "2026-09-18T09:30:00Z",
    lastTestStatus: "succeeded",
    lastErrorCode: null,
    revision,
    updatedAt: "2026-09-18T09:30:00Z",
  };
}

function overview(integrations: IntegrationSummary[]): IntegrationOverview {
  return {
    deploymentMode: "personal_tailnet",
    profile: {
      profileId: "synthetic", displayName: "Synthetic", initials: "S", avatarColor: "blue", locale: "en",
      baseCurrency: "GBP", timezone: "Europe/London", accountLabels: {}, revision: 1, updatedAt: "2026-01-01T00:00:00Z",
    },
    integrations,
    llmProviders: [],
    llmRoutePolicy: null,
  };
}

/** Opens Settings with every backend request answered here; writes other than the ones a test routes fail it. */
async function open(page: Page, settings: () => IntegrationOverview, publishedBuild?: string, cfdRecords = 0, locale = "en") {
  const unexpected: string[] = [];
  await page.route("**/*", (route) => {
    if (route.request().method() === "GET") return route.fallback();
    unexpected.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.route("**/api/backend/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      unexpected.push(request.method() + " " + path);
      return route.abort();
    }
    if (path.endsWith("/settings/integrations")) return route.fulfill({ json: settings() });
    if (path.endsWith("/health") && publishedBuild) return route.fulfill({
      headers: { "x-trading-max-web-build": publishedBuild },
      json: { service: "trading_max-api", status: "ok", latestRunId: null },
    });
    if (path.endsWith("/imports/trading212/cfd")) return route.fulfill({ json: {
      parserVersion: "synthetic", accountStatus: "active", importedFiles: 0, uniqueEvents: cfdRecords, duplicateEvents: 0,
      totalRawRows: cfdRecords, isStale: false, warnings: [], files: [], coverageStartDate: null, coverageEndDate: null,
    } });
    return route.fulfill({ json: path.endsWith("/profile") ? settings().profile : {} });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
  await page.goto("/settings");
  const panel = page.locator("section.mx-panel").filter({
    has: page.locator("h2").filter({ hasText: locale === "zh" ? /^公开市场数据$/ : /^Market data$/ }),
  });
  await expect(panel).toBeVisible();
  return { panel, unexpected };
}

/** Holds a request until the test releases it, so a pending state can be inspected. */
function gate() {
  const { promise: opened, resolve: release } = Promise.withResolvers<void>();
  return { opened, release };
}

/** Axe reads final colours: buttons fading back from disabled are mid-transition for a moment. */
async function axe(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
  return (await new AxeBuilder({ page }).analyze()).violations;
}

/**
 * Every mutation's state (variables included) and every query's state, read from the page's QueryClient. The client
 * is not exposed globally, so it is found on its provider in the React tree.
 */
function cacheText(page: Page) {
  return page.evaluate(() => {
    type Client = { getMutationCache(): { getAll(): Array<{ state: unknown }> }; getQueryCache(): { getAll(): Array<{ state: unknown }> } };
    type Fiber = { return: Fiber | null; memoizedProps?: { client?: Partial<Client> } };
    const host = document.querySelector("main") ?? document.body;
    const key = Object.keys(host).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? (host as unknown as Record<string, Fiber>)[key] : null;
    while (fiber && !fiber.memoizedProps?.client?.getMutationCache) fiber = fiber.return;
    const client = fiber?.memoizedProps?.client as Client | undefined;
    if (!client) throw new Error("No QueryClient in the React tree");
    return JSON.stringify({
      mutations: client.getMutationCache().getAll().map((mutation) => mutation.state),
      queries: client.getQueryCache().getAll().map((query) => query.state),
    });
  });
}

test.describe("reconstruction market data", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  for (const scheme of ["dark", "light"] as const) {
    test(`offers missing-key recovery and keeps Save gated in ${scheme}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("mantine-color-scheme-value", value), scheme);
      const { panel, unexpected } = await open(page, () => overview([]));
      await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
      await panel.getByRole("button", { name: "Connect Alpaca", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const button = dialog.getByRole("button", { name: "Test connection", exact: true });
      const save = dialog.getByRole("button", { name: "Save and enable", exact: true });
      const key = dialog.getByLabel("Alpaca API Key ID");
      const secret = dialog.getByLabel("Alpaca API Secret");
      const requirement = dialog.getByText("Test the connection before saving.", { exact: true });
      await expect(save).toBeDisabled();
      await expect(requirement).toBeVisible();
      await expect(save).toHaveAccessibleDescription("Test the connection before saving.");
      await expect(save).toHaveCSS("opacity", "0.5");
      await expect(save).toHaveCSS("cursor", "not-allowed");
      await expect(key).toHaveCSS("color-scheme", scheme);
      await expect(key).toHaveAttribute("aria-invalid", "false");
      await expect(button).toBeEnabled();
      await button.click();
      await expect(key).toBeFocused();
      await expect(key).toHaveAttribute("aria-invalid", "true");
      await expect(key).toHaveAccessibleDescription("Enter the API key ID.");
      await expect(secret).toHaveAccessibleDescription("Enter the API secret.");
      // Hovering an invalid credential group keeps its destructive border colour.
      const keyGroup = key.locator("..");
      const invalidBorder = await keyGroup.evaluate((el) => {
        const probe = document.createElement("div");
        probe.style.borderColor = "var(--destructive)";
        el.appendChild(probe);
        const expected = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return { actual: getComputedStyle(el).borderTopColor, expected };
      });
      expect(invalidBorder.actual).toBe(invalidBorder.expected);
      await keyGroup.hover();
      await expect(keyGroup).toHaveCSS("border-top-color", invalidBorder.expected);
      expect((await new AxeBuilder({ page }).include('[role="dialog"] form').analyze()).violations).toEqual([]);
      expect(unexpected).toEqual([]);
      await key.fill("synthetic-key");
      await secret.fill("synthetic-secret");
      await expect(dialog.getByText("Closing this form clears unsaved keys.", { exact: true })).toHaveCount(0);
      await expect(key).toHaveAttribute("aria-invalid", "false");
      await expect(secret).toHaveAttribute("aria-invalid", "false");
      await expect(save).toBeDisabled();
      await expect(requirement).toBeVisible();
    });
  }

  test("one switch turns Alpaca on, holds while it saves and keeps keyboard focus", async ({ page, isMobile }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let server = alpaca(false);
    const { panel, unexpected } = await open(page, () => overview([server]));
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await expect(toggle).not.toBeChecked();
    // The label owns the switch's 44px touch band.
    if (isMobile) expect((await toggle.locator("..").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(panel.getByRole("button", { name: "Update Alpaca keys", exact: true })).toBeHidden();
    await panel.getByText("Manage Alpaca keys", { exact: true }).click();
    await expect(panel.getByRole("button", { name: "Update Alpaca keys", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Remove keys", exact: true })).toBeVisible();
    // The source name and the state tag are gone: the switch alone carries the state.
    await expect(panel.getByRole("heading", { level: 3 })).toHaveCount(0);
    // The saving announcement is mounted from the start and silent until a change runs.
    const announcer = panel.locator(".sr-only[role=status]");
    await expect(announcer).toHaveCount(1);
    await expect(announcer).toHaveText("");
    // The change and the settings reload after it are held separately.
    const saving = gate();
    const reloading = gate();
    const bodies: unknown[] = [];
    await page.route("**/api/backend/settings/integrations/alpaca", async (route) => {
      expect(route.request().method()).toBe("PATCH");
      bodies.push(route.request().postDataJSON());
      await saving.opened;
      server = alpaca(true, 2);
      await route.fulfill({ json: server });
    });
    let reloads = 0;
    await page.route("**/api/backend/settings/integrations", async (route) => {
      reloads += 1;
      await reloading.opened;
      await route.fulfill({ json: overview([server]) });
    });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    await expect(toggle.locator("[data-slot=spinner]")).toHaveCSS("animation-iteration-count", "infinite");
    await expect(toggle).toBeFocused();
    await expect(announcer).toHaveText("Saving…");
    // A second press while the change saves is ignored.
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    expect(bodies).toEqual([{ enabled: true }]);
    saving.release();
    // The confirmed result goes into the cached settings at once: the switch settles while the reload is still held.
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(announcer).toHaveText("");
    await expect(toggle).toBeChecked();
    await expect(toggle).not.toHaveAttribute("aria-busy");
    await expect(toggle).toBeFocused();
    await expect.poll(() => reloads).toBeGreaterThan(0);
    reloading.release();
    await expect(toggle).toBeChecked();
    expect(await axe(page)).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test("the switch follows the server's answer, not the request", async ({ page }) => {
    // The server accepts the change but reports Alpaca still off, and the reload agrees.
    const { panel, unexpected } = await open(page, () => overview([alpaca(false)]));
    await page.route("**/api/backend/settings/integrations/alpaca", (route) => route.fulfill({ json: alpaca(false) }));
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).not.toHaveAttribute("aria-busy");
    expect(unexpected).toEqual([]);
  });

  test("a failed change returns the switch to the server's state and says so", async ({ page }) => {
    const { panel, unexpected } = await open(page, () => overview([alpaca(true)]));
    await page.route("**/api/backend/settings/integrations/alpaca", (route) => route.fulfill({ status: 500, json: { detail: "synthetic failure" } }));
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await expect(toggle).toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(panel.getByRole("alert")).toContainText("Could not update settings");
    await expect(toggle).toBeChecked();
    expect(unexpected).toEqual([]);
  });

  test("the switch shows the last confirmed state, and a later successful load supersedes it", async ({ page }) => {
    let server = alpaca(false);
    let outage = false;
    const { panel, unexpected } = await open(page, () => overview([server]));
    await page.route("**/api/backend/settings/integrations", (route) =>
      outage ? route.fulfill({ status: 503, json: { detail: "synthetic outage" } }) : route.fulfill({ json: overview([server]) }));
    const patches: unknown[] = [];
    await page.route("**/api/backend/settings/integrations/alpaca", (route) => {
      patches.push(route.request().postDataJSON());
      if (patches.length > 1) return route.fulfill({ status: 500, json: { detail: "synthetic failure" } });
      // The enable is confirmed, then the settings stop loading.
      server = alpaca(true, 2);
      outage = true;
      return route.fulfill({ json: server });
    });
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    const reloadFailed = page.getByRole("alert").filter({ hasText: "Settings could not be reloaded." });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(reloadFailed).toBeVisible();
    await expect(toggle).toBeChecked();
    // A failed disable leaves the last confirmed state, on, rather than the state before the enable.
    await page.keyboard.press("Space");
    await expect(panel.getByRole("alert")).toContainText("Could not update settings");
    await expect(toggle).toBeChecked();
    expect(patches).toEqual([{ enabled: true }, { enabled: false }]);
    // Meanwhile the server turned Alpaca off; the next successful load supersedes the confirmed result.
    server = alpaca(false, 3);
    outage = false;
    await reloadFailed.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(reloadFailed).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    expect(unexpected).toEqual([]);
  });

  test("a saved change whose settings cannot be reloaded keeps the page, says so once and retries", async ({ page }) => {
    const { panel, unexpected } = await open(page, () => overview([alpaca(false)]));
    const drop = page.locator(".mx-import-drop");
    await drop.locator("input[type=file]").setInputFiles({ name: "synthetic-activity.csv", mimeType: "text/csv", buffer: Buffer.from("Action,Time\n") });
    await page.route("**/api/backend/settings/integrations/alpaca", (route) => {
      expect(route.request().method()).toBe("PATCH");
      return route.fulfill({ json: alpaca(true, 2) });
    });
    // The change saves, then every reload of the settings fails until the outage ends.
    let outage = true;
    let reloads = 0;
    await page.route("**/api/backend/settings/integrations", (route) => {
      reloads += 1;
      return outage ? route.fulfill({ status: 503, json: { detail: "synthetic outage" } }) : route.fulfill({ json: overview([alpaca(true, 2)]) });
    });
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await toggle.focus();
    await page.keyboard.press("Space");
    // The save succeeded, so the panel says so; the reload failure is the page's to report.
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    expect(reloads).toBeGreaterThan(0);
    await expect(panel.locator(".mx-notice")).toHaveCount(1);
    await expect(page.getByText("Data is temporarily unavailable")).toHaveCount(0);
    // One notice near the top says the page is not current, for every panel, and offers the retry.
    const reloadFailed = page.getByRole("alert").filter({ hasText: "Settings could not be reloaded." });
    await expect(reloadFailed).toHaveCount(1);
    expect(await axe(page)).toEqual([]);
    // The page stays: the confirmed state is in the cached settings, the switch keeps focus and the chosen file stays.
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeFocused();
    await expect(drop.getByRole("button", { name: "CFD activity CSV file: synthetic-activity.csv", exact: true })).toBeVisible();
    outage = false;
    await reloadFailed.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(reloadFailed).toHaveCount(0);
    await expect(toggle).toBeChecked();
    await expect(drop.getByRole("button", { name: "CFD activity CSV file: synthetic-activity.csv", exact: true })).toBeVisible();
    expect(unexpected).toEqual([]);
  });

  test("a change in flight keeps every Alpaca write locked across a tab switch", async ({ page }) => {
    let server = alpaca(false);
    const { unexpected } = await open(page, () => overview([server]));
    const saving = gate();
    const writes: string[] = [];
    await page.route("**/api/backend/settings/integrations/alpaca", async (route) => {
      writes.push(route.request().method() + " " + route.request().postData());
      await saving.opened;
      server = alpaca(true, 2);
      await route.fulfill({ json: server });
    });
    const panel = () => page.locator("section.mx-panel").filter({ has: page.locator("h2").filter({ hasText: /^Market data$/ }) });
    await panel().getByRole("switch", { name: "Alpaca enhancement", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(panel().getByRole("switch")).toHaveAttribute("aria-busy", "true");
    // Away to Preferences and back: the panel mounts afresh, and the change in flight still holds every write.
    await page.getByRole("tab", { name: "Preferences", exact: true }).click();
    await expect(panel()).toHaveCount(0);
    await page.getByRole("tab", { name: "Accounts & data", exact: true }).click();
    const toggle = panel().getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    await expect(panel().locator(".sr-only[role=status]")).toHaveText("Saving…");
    await panel().getByText("Manage Alpaca keys", { exact: true }).click();
    await expect(panel().getByRole("button", { name: "Remove keys", exact: true })).toBeDisabled();
    await expect(panel().getByRole("button", { name: "Update Alpaca keys", exact: true })).toBeDisabled();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    saving.release();
    await expect(toggle).not.toHaveAttribute("aria-busy");
    await expect(toggle).toBeChecked();
    await expect(panel().getByRole("button", { name: "Remove keys", exact: true })).toBeEnabled();
    expect(writes).toEqual(['PATCH {"enabled":true}']);
    expect(unexpected).toEqual([]);
  });

  test("a key save keeps the keys and the validation token out of the query client", async ({ page }) => {
    const keyId = "synthetic-key-id";
    const secret = "synthetic-secret";
    const token = "synthetic-receipt";
    let configured = false;
    const { panel, unexpected } = await open(page, () => overview(configured ? [alpaca(true, 2)] : []));
    const bodies: unknown[] = [];
    await page.route("**/api/backend/settings/integrations/alpaca/test", (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { validationToken: token } });
    });
    await page.route("**/api/backend/settings/integrations/alpaca", (route) => {
      expect(route.request().method()).toBe("PUT");
      bodies.push(route.request().postDataJSON());
      configured = true;
      return route.fulfill({ json: alpaca(true, 2) });
    });
    const leaked = new RegExp([keyId, secret, token].join("|"));
    await panel.getByRole("button", { name: "Connect Alpaca", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Alpaca market data" });
    await dialog.getByLabel("Alpaca API Key ID").fill(keyId);
    await dialog.getByLabel("Alpaca API Secret").fill(secret);
    const prerequisite = dialog.getByText("Test the connection before saving.", { exact: true });
    await expect(prerequisite).toBeVisible();
    await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(dialog.getByText("SIP and overnight BOATS access verified.")).toBeVisible();
    await expect(prerequisite).toHaveCount(0);
    // The test settles and leaves the cache; the token lives only in the dialog.
    await expect.poll(() => cacheText(page)).not.toMatch(leaked);
    await dialog.getByRole("button", { name: "Save and enable", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole("switch", { name: "Alpaca enhancement", exact: true })).toBeChecked();
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    // After the save settles and the dialog closes, nothing in the client holds the key, the secret or the token.
    await expect.poll(() => cacheText(page)).not.toMatch(leaked);
    // The snapshot is the live client: it does hold the saved integration's public summary.
    expect(await cacheText(page)).toContain("synthetic-alpaca");
    expect(bodies).toEqual([
      { apiKeyId: keyId, secretKey: secret },
      { apiKeyId: keyId, secretKey: secret, enabled: true, validationToken: token },
    ]);
    expect(unexpected).toEqual([]);
  });

  test("the switch waits while keys are removed, then the panel names Yahoo Finance and offers Alpaca", async ({ page }) => {
    let configured = true;
    const { panel, unexpected } = await open(page, () => overview(configured ? [alpaca(true)] : []));
    const removing = gate();
    await page.route("**/api/backend/settings/integrations/alpaca", async (route) => {
      expect(route.request().method()).toBe("DELETE");
      await removing.opened;
      configured = false;
      await route.fulfill({ status: 204 });
    });
    await panel.getByText("Manage Alpaca keys", { exact: true }).click();
    await panel.getByRole("button", { name: "Remove keys", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Remove Alpaca keys" }).getByRole("button", { name: "Remove keys", exact: true }).click();
    await expect(panel.getByRole("switch", { includeHidden: true })).toBeDisabled();
    removing.release();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(panel.getByRole("switch", { includeHidden: true })).toHaveCount(0);
    // Without keys nothing switches: the row names the source in use and offers Alpaca beside it.
    await expect(panel.getByRole("heading", { name: "Alpaca", level: 3, exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Connect Alpaca", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Remove keys", exact: true })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test("Alpaca writes run one at a time, and a new write clears the last one's notice", async ({ page }) => {
    let configured = true;
    const { panel, unexpected } = await open(page, () => overview(configured ? [alpaca(false)] : []));
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    // Located by text, not role: an open dialog may hide the panel from the accessibility tree.
    const update = panel.locator("button", { hasText: "Update Alpaca keys" });
    const remove = panel.locator("button", { hasText: "Remove keys" });
    const patching = gate();
    const deleting = gate();
    const writes: string[] = [];
    await page.route("**/api/backend/settings/integrations/alpaca", async (route) => {
      const method = route.request().method();
      writes.push(method);
      if (method === "PATCH") {
        await patching.opened;
        return route.fulfill({ status: 500, json: { detail: "synthetic failure" } });
      }
      expect(method).toBe("DELETE");
      await deleting.opened;
      configured = false;
      return route.fulfill({ status: 204 });
    });
    await toggle.focus();
    await page.keyboard.press("Space");
    // While the change is in flight, a key update or removal cannot start, and the switch keeps focus.
    await expect(update).toBeDisabled();
    await expect(remove).toBeDisabled();
    await expect(toggle).toBeFocused();
    patching.release();
    await expect(panel.getByRole("alert")).toContainText("Could not update settings");
    await expect(remove).toBeEnabled();
    await panel.getByText("Manage Alpaca keys", { exact: true }).click();
    await remove.click();
    const dialog = page.getByRole("alertdialog", { name: "Remove Alpaca keys" });
    await dialog.getByRole("button", { name: "Remove keys", exact: true }).click();
    // The removal supersedes the failed change: its alert goes at once, and nothing else can start.
    await expect(panel.locator(".mx-notice")).toHaveCount(0);
    await expect(panel.getByRole("switch", { includeHidden: true })).toBeDisabled();
    await expect(update).toBeDisabled();
    // The dialog stays until its write settles, so the outcome shows where it was asked for.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    deleting.release();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(panel.locator(".mx-notice")).toHaveCount(1);
    expect(writes).toEqual(["PATCH", "DELETE"]);
    expect(unexpected).toEqual([]);
  });

  test("a second press before the panel re-renders starts no second Alpaca write", async ({ page }) => {
    let server = [alpaca(false)];
    const { panel, unexpected } = await open(page, () => overview(server));
    const saving = gate();
    const writes: string[] = [];
    await page.route("**/api/backend/settings/integrations/alpaca/test", (route) => route.fulfill({ json: { validationToken: "synthetic-receipt" } }));
    await page.route("**/api/backend/settings/integrations/alpaca", async (route) => {
      const method = route.request().method();
      const repeat = writes.includes(method);
      writes.push(method);
      if (method === "PATCH") await saving.opened;
      // A repeat is answered after the first write and fails, so its failure would replace the saved notice.
      if (repeat) return route.fulfill({ status: 409, json: { detail: "synthetic conflict" } });
      if (method === "DELETE") {
        server = [];
        return route.fulfill({ status: 204 });
      }
      server = [alpaca(true, 2)];
      return route.fulfill({ json: server[0] });
    });
    // Both clicks run in one task, so the second meets the controls as the first left them, before any re-render.
    async function pressTwice(target: Locator) {
      await expect(target).toBeEnabled();
      await target.evaluate((element: HTMLElement) => { element.click(); element.click(); });
    }
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await pressTwice(toggle);
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    saving.release();
    await expect(toggle).not.toHaveAttribute("aria-busy");
    await expect(toggle).toBeChecked();
    expect(writes).toEqual(["PATCH"]);
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    // The removal's confirmation removes the keys once.
    await panel.getByText("Manage Alpaca keys", { exact: true }).click();
    await panel.getByRole("button", { name: "Remove keys", exact: true }).click();
    const removal = page.getByRole("alertdialog", { name: "Remove Alpaca keys" });
    await pressTwice(removal.getByRole("button", { name: "Remove keys", exact: true }));
    await expect(removal).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Connect Alpaca", exact: true })).toBeVisible();
    expect(writes).toEqual(["PATCH", "DELETE"]);
    // The key dialog's save stores the keys once and closes.
    await panel.getByRole("button", { name: "Connect Alpaca", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Alpaca market data" });
    await dialog.getByLabel("Alpaca API Key ID").fill("synthetic-key-id");
    await dialog.getByLabel("Alpaca API Secret").fill("synthetic-secret");
    await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
    await pressTwice(dialog.getByRole("button", { name: "Save and enable", exact: true }));
    await expect(panel.getByRole("switch", { includeHidden: true })).toBeChecked();
    expect(writes).toEqual(["PATCH", "DELETE", "PUT"]);
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
});

test.describe("CFD import", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  test("the file control has a name with and without a chosen file, and its prompt names the file", async ({ page }) => {
    const { unexpected } = await open(page, () => overview([]), undefined, Number.MAX_SAFE_INTEGER);
    const ledger = page.locator("section.mx-panel").filter({ has: page.getByRole("heading", { name: "CFD history ledger", exact: true }) });
    const drop = ledger.locator(".mx-import-drop");
    const count = ledger.locator(".mx-metric").filter({ hasText: "9,007,199,254,740,991" });
    await expect(count).toBeVisible();
    expect(await count.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await ledger.getByText("Import history & coverage", { exact: true }).click();
    const empty = ledger.getByText("No imports yet", { exact: true });
    await expect(empty).toBeVisible();
    expect((await empty.boundingBox())!.height).toBeLessThan(48);
    // The panel title is the only heading; the control's prompt says which file it wants.
    await expect(ledger.getByRole("heading")).toHaveCount(1);
    await expect(drop.getByText("Choose CFD activity CSV file", { exact: true })).toBeVisible();
    expect(await drop.ariaSnapshot()).toContain('button "Choose CFD activity CSV file"');
    // Choosing a file stays in the page; nothing is uploaded.
    await drop.locator("input[type=file]").setInputFiles({ name: "synthetic-activity.csv", mimeType: "text/csv", buffer: Buffer.from("Action,Time\n") });
    expect(await drop.ariaSnapshot()).toContain('button "CFD activity CSV file: synthetic-activity.csv"');
    const longName = `synthetic-${"账本".repeat(22)}-${"long-name".repeat(8)}.csv`;
    await drop.locator("input[type=file]").setInputFiles({ name: longName, mimeType: "text/csv", buffer: Buffer.from("Action,Time\n") });
    await expect(drop.getByRole("button", { name: `CFD activity CSV file: ${longName}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const importLedger = drop.getByRole("button", { name: "Import ledger", exact: true });
    await expect(importLedger).toBeEnabled();
    expect(await axe(page)).toEqual([]);
    await drop.getByRole("button", { name: "Clear file", exact: true }).press("Space");
    const chooser = drop.getByRole("button", { name: "Choose CFD activity CSV file", exact: true });
    await expect(chooser).toBeFocused();
    await expect(chooser.locator("..")).toHaveCSS("outline-width", "2px");
    await expect(chooser.locator("..")).toHaveCSS("outline-offset", "2px");
    await expect(importLedger).toBeDisabled();
    expect(unexpected).toEqual([]);
  });
});

for (const scheme of ["dark", "light"] as const) {
  test(`a pending model test dims checked and unchecked checkboxes in ${scheme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("mantine-color-scheme-value", value), scheme);
    const server = overview([]);
    server.llmProviders = [{
      provider: "openai", label: "OpenAI", adapter: "openai", baseUrl: "https://example.invalid",
      models: ["synthetic-model"], defaultModel: "synthetic-model", authMethod: "api_key",
    }];
    const { unexpected } = await open(page, () => server);
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
    await page.getByRole("tab", { name: "Model connections", exact: true }).click();
    await page.getByRole("button", { name: "Choose a provider", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Connect OpenAI", exact: true });
    await dialog.locator('input[type="password"]').fill("synthetic-secret");
    const checkbox = dialog.getByRole("checkbox", { name: "Use as the default model" });
    const testConnection = dialog.getByRole("button", { name: "Test connection", exact: true });

    let pending = gate();
    await page.route("**/api/backend/settings/llm/providers/openai/test", async (route) => {
      expect(route.request().method()).toBe("POST");
      await pending.opened;
      await route.fulfill({ json: { status: "succeeded", validationToken: "synthetic-receipt" } });
    });
    for (const checked of [true, false]) {
      await checkbox.setChecked(checked);
      try {
        await testConnection.click();
        await expect(checkbox).toBeDisabled();
        await expect(checkbox).toBeChecked({ checked });
        await expect(checkbox.locator("..")).toHaveCSS("opacity", "0.5");
      } finally {
        pending.release();
      }
      await expect(checkbox).toBeEnabled();
      pending = gate();
    }
    expect(unexpected).toEqual([]);
  });
}

test("an EODHD key is tested and saved with index history off by default", async ({ page }) => {
  let source: IntegrationSummary | undefined;
  const requests: string[] = [];
  const { unexpected } = await open(page, () => overview(source ? [source] : []));
  await page.route("**/api/backend/settings/integrations/eodhd/test", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ apiKey: "synthetic-secret" });
    requests.push("test");
    await route.fulfill({ json: { validationToken: "synthetic-receipt" } });
  });
  await page.route("**/api/backend/settings/integrations/eodhd", async (route) => {
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toEqual({
        apiKey: "synthetic-secret", validationToken: "synthetic-receipt", enabled: false,
      });
      source = { ...alpaca(false), integrationId: "eodhd:default", provider: "eodhd" };
      requests.push("save");
    } else {
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().postDataJSON()).toEqual({ enabled: true });
      source = { ...alpaca(true, 2), integrationId: "eodhd:default", provider: "eodhd" };
      requests.push("enable");
    }
    await route.fulfill({ json: source });
  });
  await page.getByRole("button", { name: "Connect EODHD" }).click();
  const dialog = page.getByRole("dialog");
  const key = dialog.getByLabel(/API key/);
  const reveal = dialog.getByRole("button", { name: "Show or hide key" });
  const submit = dialog.getByRole("button", { name: "Test and save" });
  await expect(key).toHaveAttribute("aria-invalid", "false");
  await expect(key).toHaveAttribute("type", "password");
  await expect(key).toHaveAttribute("name", "eodhd-api-key");
  await expect(key).toHaveAttribute("spellcheck", "false");
  await key.fill("   ");
  await submit.click();
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute("aria-invalid", "true");
  await expect(key).toHaveAccessibleDescription("Enter the API key.");
  expect(requests).toEqual([]);
  await key.fill("synthetic-secret");
  await expect(dialog.getByText("Closing this form clears unsaved keys.", { exact: true })).toHaveCount(0);
  await expect(key).toHaveAttribute("aria-invalid", "false");
  await key.press("Tab");
  await expect(reveal).toBeFocused();
  await reveal.press("Space");
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(key).toHaveAttribute("type", "text");
  await expect(key).toHaveValue("synthetic-secret");
  await reveal.press("Enter");
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await expect(key).toHaveAttribute("type", "password");
  await submit.click();
  const toggle = page.getByRole("switch", { name: "EODHD", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
  expect(requests).toEqual(["test", "save", "enable"]);
  expect(unexpected).toEqual([]);
  expect(await cacheText(page)).not.toContain("synthetic-secret");
});

async function expectDraftNavigation(page: Page, isMobile: boolean) {
  await page.evaluate(() => { document.body.dataset.settingsDocument = "yes"; });
  const navigation = isMobile ? /^(Quick navigation|快捷导航)$/ : /^(Primary navigation|主导航)$/;
  await page.getByRole("navigation", { name: navigation })
    .getByRole("link", { name: /^(Holdings|持仓|持仓与穿透)$/ }).click();
  await expect(page).toHaveURL(/\/holdings$/);
  await expect(page.locator("body")).toHaveAttribute("data-settings-document", "yes");
}

test("the schedule opens independently and retries a write using the latest revision", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  let integrationsReads = 0;
  let revision = 1;
  let writes = 0;
  let enabled = false;
  let canRead = false;
  await page.route("**/api/backend/settings/integrations", (route) => {
    integrationsReads++;
    return route.fulfill({ status: 503 });
  });
  await page.route("**/api/backend/settings/automation", (route) => {
    if (!canRead && route.request().method() === "GET") return route.fulfill({ status: 503 });
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toEqual({ liveEnabled: true, expectedRevision: revision });
      writes++;
      revision++;
      if (writes === 1) return route.fulfill({ status: 409 });
      enabled = true;
    }
    return route.fulfill({
      json: {
        revision,
        liveEnabled: enabled,
        performanceEnabled: false,
        researchEnabled: false,
        evidenceNoticesEnabled: false,
      },
    });
  });
  await page.goto("/settings?tab=automation");
  const schedule = page.getByRole("tabpanel", { name: "Update schedule" });
  await expect(schedule.getByRole("status").filter({ hasText: "Automatic updates · Data is temporarily unavailable" })).toHaveCount(1);
  canRead = true;
  await schedule.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(schedule.getByRole("status").filter({ hasText: "Automatic updates · Data is available again." })).toHaveCount(1);
  const live = schedule.getByRole("switch", { name: "Account state & intraday history" });
  await live.focus();
  await page.keyboard.press("Space");
  const retry = schedule.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(live).not.toBeChecked();
  await retry.click();
  await expect(live).toBeChecked();
  await expect(schedule.getByText("Schedule saved")).toBeVisible();
  expect(writes).toBe(2);
  expect(integrationsReads).toBe(0);
});

test("the schedule announces a failed refresh and successful retry with cached settings", async ({ page, context }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.clock.install();
  let available = true;
  let liveEnabled = false;
  await page.route("**/api/backend/settings/automation", (route) => available
    ? route.fulfill({ json: { revision: 1, liveEnabled, performanceEnabled: false, researchEnabled: false, evidenceNoticesEnabled: false } })
    : route.fulfill({ status: 503 }));
  await page.goto("/settings?tab=automation");
  const schedule = page.getByRole("tabpanel", { name: "Update schedule" });
  const live = schedule.getByRole("switch", { name: "Account state & intraday history" });
  const failure = schedule.getByRole("status").filter({ hasText: "Automatic updates · Update failed" });
  const recovery = schedule.getByRole("status").filter({ hasText: "Automatic updates · Data is available again." });
  await expect(live).toBeVisible();
  await expect(recovery).toHaveCount(0);

  available = false;
  await page.clock.fastForward(31_000);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
  const warning = schedule.locator(".mx-notice").filter({ hasText: "Update schedule could not be reloaded." });
  await expect(warning).toBeVisible();
  await expect(live).not.toBeChecked();
  await expect(failure).toHaveCount(1);
  await expect(schedule.getByRole("alert").filter({ hasText: "Update schedule could not be reloaded." })).toHaveCount(0);
  const announcer = await failure.elementHandle();
  await expect(recovery).toHaveCount(0);

  available = true;
  liveEnabled = true;
  await warning.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(live).toBeChecked();
  await expect(warning).toHaveCount(0);
  await expect(recovery).toHaveCount(1);
  await expect(failure).toHaveCount(0);
  expect(await recovery.evaluate((element, original) => element === original, announcer)).toBe(true);
});

test("Preferences can save the language selected from the shell", async ({ page, isMobile }) => {
  const server = overview([]);
  const { unexpected } = await open(page, () => server);
  await page.route("**/api/backend/profile", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const submitted = route.request().postDataJSON();
    expect(submitted).toEqual({ locale: "zh", expectedRevision: 1 });
    server.profile = { ...server.profile, locale: "zh", revision: 2 };
    return route.fulfill({ json: server.profile });
  });

  if (isMobile) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "切换到中文", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "切换到中文", exact: true }).click();
  }
  await page.getByRole("tab", { name: "个人偏好", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveText("简体中文");
  const name = page.getByRole("textbox", { name: "显示名称" });
  const originalName = await name.inputValue();
  const save = page.getByRole("button", { name: "保存偏好", exact: true });
  await name.fill("  ");
  const compositionWasGuarded = await name.evaluate((input) => !input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }),
  ));
  expect(compositionWasGuarded).toBe(true);
  await expect(name).toHaveAttribute("aria-invalid", "false");
  await save.click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAccessibleDescription("请输入显示名称。");
  await name.fill(originalName);
  await expect(name).toHaveAttribute("aria-invalid", "false");
  await save.click();
  await expect(page.getByText("个人偏好已保存。", { exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("Preferences follows a shell language change after editing its language selector", async ({ page, isMobile }) => {
  const server = overview([]);
  const { unexpected } = await open(page, () => server);
  await page.route("**/api/backend/profile", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({ displayName: "Updated name", expectedRevision: 1 });
    server.profile = { ...server.profile, displayName: "Updated name", revision: 2 };
    return route.fulfill({ json: server.profile });
  });

  await page.getByRole("tab", { name: "Preferences", exact: true }).click();
  const language = page.getByRole("combobox", { name: /^(Interface language|界面语言)$/ });
  await language.click();
  await page.getByRole("option", { name: "Chinese (Simplified)" }).click();
  await expect(language).toHaveText("简体中文");

  if (isMobile) {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "Switch to English", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Switch to English", exact: true }).click();
  }
  await expect(language).toHaveText("English");
  await page.getByRole("textbox", { name: "Display name" }).fill("Updated name");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await expect(page.getByText("Preferences saved.", { exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("a preference draft survives tabs and a language change during save still guards navigation", async ({ page, isMobile }) => {
  const server = overview([]);
  const save = gate();
  const publication = page.waitForResponse((response) => response.url().endsWith("/api/backend/health"));
  const { unexpected } = await open(page, () => server, "synthetic-new-build");
  await publication;
  await page.route("**/api/backend/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const submitted = route.request().postDataJSON();
    expect(submitted).toEqual({ displayName: "Draft name", expectedRevision: 1 });
    await save.opened;
    server.profile = { ...server.profile, ...submitted, revision: 2 };
    return route.fulfill({ json: server.profile });
  });

  const preferences = page.getByRole("tab", { name: /^(Preferences|个人偏好)$/ });
  const accounts = page.getByRole("tab", { name: /^(Accounts & data|账户与数据)$/ });
  await preferences.click();
  const name = page.getByRole("textbox", { name: /^(Display name|显示名称)$/ });
  await name.fill("Draft name");
  await accounts.click();
  await expect(name).toBeHidden();
  await preferences.click();
  await expect(name).toHaveValue("Draft name");

  const saving = page.waitForRequest((request) =>
    request.method() === "PATCH" && request.url().endsWith("/api/backend/profile"));
  await page.getByRole("button", { name: "Save preferences" }).click();
  await saving;
  try {
    await page.getByRole("combobox", { name: "Interface language" }).click();
    await page.getByRole("option", { name: "Chinese (Simplified)" }).click();
    await accounts.click();
  } finally {
    save.release();
  }
  await preferences.click();
  await expect(page.getByText("还有未保存的修改")).toBeVisible();
  await expect(name).toHaveValue("Draft name");
  await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveText("简体中文");
  await accounts.click();
  await expectDraftNavigation(page, isMobile);
  expect(unexpected).toEqual([]);
});

test("editing a previously saved name after another profile revision is unsaved", async ({ page, isMobile }) => {
  const server = overview([]);
  const publication = page.waitForResponse((response) => response.url().endsWith("/api/backend/health"));
  const { unexpected } = await open(page, () => server, "synthetic-new-build");
  await publication;
  let failReload = true;
  await page.route("**/api/backend/settings/integrations", (route) => failReload
    ? route.fulfill({ status: 503, json: {} })
    : route.fallback());
  await page.route("**/api/backend/profile", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    server.profile = { ...server.profile, ...route.request().postDataJSON(), revision: 2 };
    return route.fulfill({ json: server.profile });
  });
  const preferences = page.getByRole("tab", { name: "Preferences", exact: true });
  await preferences.click();
  const name = page.getByRole("textbox", { name: "Display name" });
  await name.fill("Saved name");
  await page.getByRole("button", { name: "Save preferences" }).click();
  const saved = page.getByText("Preferences saved.", { exact: true });
  await expect(saved).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  server.profile = { ...server.profile, displayName: "Another writer", revision: 3 };
  failReload = false;
  await retry.click();
  await expect(name).toHaveValue("Another writer");
  await name.fill("Saved name");
  await expect(saved).toBeHidden();
  await page.getByRole("tab", { name: "Accounts & data" }).click();
  await expectDraftNavigation(page, isMobile);
  expect(unexpected).toEqual([]);
});

async function refetchProfileFromPreferences(page: Page) {
  await page.route("**/api/backend/settings/assistant", (route) => route.fulfill({ status: 503 }));
  await page.clock.setFixedTime(Date.now() + 31_000);
  const assistant = page.getByRole("tab", { name: "MaxAI" });
  await assistant.click();
  await expect(assistant).toHaveAttribute("aria-selected", "true");
  const reloaded = page.waitForResponse((response) => response.url().endsWith("/api/backend/settings/integrations"));
  await page.getByRole("tab", { name: "Preferences", exact: true }).click();
  await reloaded;
}

test("a profile reload supersedes a dirty draft without resubmitting untouched preferences", async ({ page }) => {
  const server = overview([]);
  const { unexpected } = await open(page, () => server);
  const preferences = page.getByRole("tab", { name: "Preferences", exact: true });
  await preferences.click();
  const name = page.getByRole("textbox", { name: "Display name" });
  await name.fill("Obsolete name");

  server.profile = { ...server.profile, revision: 2, displayName: "Another writer", timezone: "UTC" };
  await refetchProfileFromPreferences(page);
  await expect(name).toHaveValue("Another writer");
  await expect(page.getByRole("combobox", { name: "Display timezone" })).toHaveValue("UTC");

  await page.route("**/api/backend/profile", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const submitted = route.request().postDataJSON();
    expect(submitted).toEqual({ displayName: "Fresh name", expectedRevision: 2 });
    server.profile = { ...server.profile, displayName: submitted.displayName, revision: 3 };
    return route.fulfill({ json: server.profile });
  });
  await name.fill("Fresh name");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences saved.", { exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

for (const status of [409, 200]) {
  test(`a preferences save retains its draft on ${status === 409 ? "conflict" : "an unrelated response revision"}`, async ({ page }) => {
    const server = overview([]);
    const { unexpected } = await open(page, () => server);
    await page.route("**/api/backend/profile", (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const submitted = route.request().postDataJSON();
      expect(submitted).toEqual({ displayName: "Draft name", expectedRevision: 1 });
      server.profile = { ...server.profile, displayName: "Another writer", revision: 3 };
      return route.fulfill({
        status,
        json: status === 409
          ? { detail: { code: "profile_revision_conflict" } }
          : { ...server.profile, displayName: submitted.displayName },
      });
    });

    const preferences = page.getByRole("tab", { name: "Preferences", exact: true });
    await preferences.click();
    const name = page.getByRole("textbox", { name: "Display name" });
    const save = page.getByRole("button", { name: "Save preferences" });
    await name.fill("Draft name");
    await save.click();
    const conflict = page.getByText("Settings changed in another window. Reload before saving.", { exact: true });
    await expect(conflict).toBeVisible();
    await expect(save).toBeDisabled();

    await refetchProfileFromPreferences(page);
    await expect(name).toHaveValue("Draft name");
    await expect(conflict).toBeVisible();
    await expect(page.getByText("Preferences saved.", { exact: true })).toBeHidden();
    expect(unexpected).toEqual([]);
  });
}

test("a routing draft survives tabs and a later revision supersedes the old save", async ({ page, isMobile }) => {
  const server = overview([{ ...alpaca(true), provider: "openai", model: "gpt-5" }]);
  server.llmProviders = [{
    provider: "openai", label: "OpenAI", adapter: "openai", baseUrl: "https://example.invalid",
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"], defaultModel: "gpt-5", authMethod: "api_key",
  }];
  const initial = { defaultRoute: "openai/gpt-5", overrides: {}, revision: 1, updatedAt: server.profile.updatedAt };
  server.llmRoutePolicy = initial;
  const save = gate();
  const reload = gate();
  const publication = page.waitForResponse((response) => response.url().endsWith("/api/backend/health"));
  const { unexpected } = await open(page, () => server, "synthetic-new-build");
  await publication;
  await page.route("**/api/backend/settings/llm/routes", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({
      defaultRoute: "openai/gpt-5-mini", overrides: {}, expectedRevision: 1,
    });
    await save.opened;
    server.llmRoutePolicy = { ...initial, defaultRoute: "openai/gpt-5-nano", revision: 3 };
    return route.fulfill({ json: { ...initial, defaultRoute: "openai/gpt-5-mini", revision: 2 } });
  });
  await page.route("**/api/backend/settings/integrations", async (route) => {
    await reload.opened;
    return route.fallback();
  });

  const models = page.getByRole("tab", { name: "Model connections" });
  const preferences = page.getByRole("tab", { name: "Preferences", exact: true });
  await models.click();
  const defaultModel = page.getByRole("combobox", { name: "Default model", exact: true });
  async function selectModel(model: string) {
    await defaultModel.click();
    await page.getByRole("option", { name: `OpenAI · ${model}`, exact: true }).click();
  }
  await selectModel("gpt-5-mini");
  await preferences.click();
  await expect(defaultModel).toBeHidden();
  await models.click();
  await expect(defaultModel).toHaveValue("OpenAI · gpt-5-mini");

  const saving = page.waitForRequest((request) =>
    request.method() === "PUT" && request.url().endsWith("/api/backend/settings/llm/routes"));
  await page.getByRole("button", { name: "Save model assignments" }).click();
  await saving;
  try {
    await selectModel("gpt-5");
  } finally {
    save.release();
  }
  try {
    await expect(page.getByText("You have unsaved changes", { exact: true })).toBeVisible();
    await expect(defaultModel).toHaveValue("OpenAI · gpt-5");
  } finally {
    reload.release();
  }
  await expect(defaultModel).toHaveValue("OpenAI · gpt-5-nano");
  await selectModel("gpt-5-mini");
  await expect(page.getByText("Model assignments saved.", { exact: true })).toBeHidden();
  await preferences.click();
  await expectDraftNavigation(page, isMobile);
  expect(unexpected).toEqual([]);
});

test.describe("Settings review", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a synthetic web preview.");

  test("drafts survive leaving Settings and guard unload", async ({ page }) => {
    const server = overview([{ ...alpaca(true), provider: "openai", model: "gpt-5" }]);
    server.llmProviders = [{
      provider: "openai", label: "OpenAI", adapter: "openai", baseUrl: "https://example.invalid",
      models: ["gpt-5", "gpt-5-mini"], defaultModel: "gpt-5", authMethod: "api_key",
    }];
    server.llmRoutePolicy = { defaultRoute: "openai/gpt-5", overrides: {}, revision: 1, updatedAt: server.profile.updatedAt };
    await open(page, () => server);
    await page.getByRole("tab", { name: "Model connections" }).click();
    await page.getByRole("combobox", { name: "Default model", exact: true }).click();
    await page.getByRole("option", { name: "OpenAI · gpt-5-mini" }).click();
    await page.getByRole("tab", { name: "Preferences", exact: true }).click();
    await page.getByRole("textbox", { name: "Display name" }).fill("Draft across navigation");
    const unloadGuarded = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    await expect.soft.poll(unloadGuarded, { timeout: 1500 }).toBe(true);
    await page.getByRole("tab", { name: "Accounts & data" }).click();
    await page.getByRole("link", { name: "View research", exact: true }).click();
    await expect(page).toHaveURL(/\/research/);
    await expect.soft.poll(unloadGuarded, { timeout: 1500 }).toBe(true);
    await page.goBack();
    await page.getByRole("tab", { name: "Preferences", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Display name" })).toHaveValue("Draft across navigation");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await page.getByRole("tab", { name: "Model connections" }).click();
    await expect(page.getByRole("combobox", { name: "Default model", exact: true })).toHaveValue("OpenAI · gpt-5-mini");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect.poll(unloadGuarded).toBe(false);
  });

  test("CFD import stays locked across tabs and clears the submitted file", async ({ page }) => {
    await open(page, () => overview([]));
    const upload = gate();
    let posts = 0;
    await page.route("**/api/backend/imports/trading212/cfd", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      await upload.opened;
      return route.fulfill({ json: { status: "imported" } });
    });
    const ledger = page.locator("section").filter({ has: page.getByRole("heading", { name: "CFD history ledger", exact: true }) });
    await ledger.locator("input[type=file]").setInputFiles({
      name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Action,Time\n"),
    });
    const posting = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/cfd"));
    await ledger.getByRole("button", { name: "Import ledger" }).click();
    await posting;
    try {
      await page.getByRole("tab", { name: "Preferences", exact: true }).click();
      await page.getByRole("tab", { name: "Accounts & data" }).click();
      await expect(ledger.getByRole("button", { name: "Importing…" })).toBeDisabled();
      expect(posts).toBe(1);
    } finally {
      upload.release();
    }
    await expect(ledger.getByRole("button", { name: "Choose CFD activity CSV file" })).toBeVisible();
    await expect(ledger.getByText(/File imported/)).toBeVisible();
  });

  test("CFD import keeps the same file after a 503 and can retry", async ({ page }) => {
    await open(page, () => overview([]));
    const contents = "Action,Time\n";
    const filename = "synthetic-cfd.csv";
    let uploads = 0;
    await page.route("**/api/backend/imports/trading212/cfd", (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      expect(request.headers()["x-trading-max-filename"]).toBe(filename);
      expect(request.headers()["content-type"]).toBe("text/csv");
      const body = request.postData();
      if (body !== null) expect(body).toBe(contents);
      uploads++;
      return uploads === 1
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { status: "imported" } });
    });
    const ledger = page.locator("section").filter({ has: page.getByRole("heading", { name: "CFD history ledger", exact: true }) });
    await ledger.locator("input[type=file]").setInputFiles({ name: filename, mimeType: "text/csv", buffer: Buffer.from(contents) });
    const upload = ledger.getByRole("button", { name: "Import ledger", exact: true });
    await upload.click();
    await expect(ledger.getByRole("alert")).toContainText("Import failed.");
    await expect(ledger.getByRole("button", { name: "CFD activity CSV file: " + filename })).toBeVisible();
    await expect(upload).toBeEnabled();
    await upload.click();
    await expect(ledger.getByText(/File imported/)).toBeVisible();
    await expect(ledger.getByRole("button", { name: "Choose CFD activity CSV file" })).toBeVisible();
    await expect(upload).toBeDisabled();
    expect(uploads).toBe(2);
  });

  test("Discard restores a Settings preview and preserves the shell language choice", async ({ page, isMobile }) => {
    const server = overview([]);
    server.profile.locale = "zh";
    await open(page, () => server);
    await page.getByRole("tab", { name: "Preferences", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Display name", exact: true });
    await name.fill("Other draft");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-locale", "en");
    await page.getByRole("combobox", { name: "Interface language" }).click();
    await page.getByRole("option", { name: "Chinese (Simplified)" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-locale", "zh");
    await page.getByRole("button", { name: "放弃修改" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-locale", "en");
    await page.getByRole("combobox", { name: "Interface language" }).click();
    await page.getByRole("option", { name: "Chinese (Simplified)" }).click();
    if (isMobile) {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("menuitem", { name: "Switch to English" }).click();
    } else {
      await page.getByRole("button", { name: "Switch to English" }).click();
    }
    await name.fill("Another draft");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-locale", "en");
  });

  test("reporting currency can be selected and copied with the keyboard", async ({ page }) => {
    await open(page, () => overview([]));
    await page.getByRole("tab", { name: "Preferences", exact: true }).click();
    const currency = page.getByRole("textbox", { name: "Portfolio reporting currency" });
    await expect(currency).toHaveAttribute("readonly", "");
    await expect(currency).not.toBeFocused();
    await expect(currency).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(currency).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await currency.focus();
    await page.keyboard.press("ControlOrMeta+A");
    expect(await currency.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))).toBe("GBP");
    await expect(currency).toHaveCSS("outline-width", "2px");
    await expect(currency).toHaveCSS("outline-offset", "2px");
    await page.evaluate(() => document.addEventListener("copy", () => {
      document.documentElement.dataset.copied = (document.activeElement as HTMLInputElement).value;
    }, { once: true }));
    await page.keyboard.press("ControlOrMeta+C");
    await expect(page.locator("html")).toHaveAttribute("data-copied", "GBP");
  });

  test("an unavailable route shows one label and a nearby reconnect action", async ({ page }) => {
    const server = overview([]);
    server.llmProviders = [{
      provider: "openai", label: "OpenAI", adapter: "openai", baseUrl: "https://example.invalid",
      models: ["gpt-5"], defaultModel: "gpt-5", authMethod: "api_key",
    }];
    server.llmRoutePolicy = { defaultRoute: "openai/gpt-5", overrides: {}, revision: 1, updatedAt: server.profile.updatedAt };
    await open(page, () => server);
    await page.getByRole("tab", { name: "Model connections" }).click();
    const form = page.getByRole("form", { name: "Model assignments" });
    await expect(form.getByRole("combobox", { name: "Default model", exact: true })).toHaveValue(/unavailable/);
    await expect(form.getByText(/The selected model .* is unavailable/)).toHaveCount(0);
    await form.getByRole("button", { name: "Connect OpenAI", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Connect OpenAI" })).toBeVisible();
  });

  test("cached local readiness cannot confirm balances after polling fails", async ({ page }) => {
    test.skip(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID !== "synthetic-settings-review", "Requires the synthetic local onboarding preview.");
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let available = true;
    let writes = 0;
    const status = {
      name: "Synthetic workspace", path: "/synthetic/workspace", connectedAccounts: ["invest"],
      readiness: { status: "ready", latestRunId: "sample-run" },
      latestFullJob: null, activeJobId: null, confirmed: false, canConfirm: true,
    };
    await page.route("**/api/backend/local-workspace", (route) => available
      ? route.fulfill({ json: status })
      : route.fulfill({ status: 503, json: {} }));
    await page.route("**/api/backend/local-workspace/confirm", (route) => {
      writes++;
      return route.fulfill({ json: { ...status, confirmed: true, canConfirm: false } });
    });
    await page.route("**/api/backend/dashboard/lens/overview?detail=summary", (route) =>
      route.fulfill({ json: { runId: "sample-run", accounts: [{ code: "A", isInvestable: true, totalValueGbp: 100 }] } }));
    await page.goto("/settings");
    const confirm = page.getByRole("button", { name: "Finish setup", exact: true });
    await page.getByRole("checkbox", { name: /account values are plausible/ }).check();
    await expect(confirm).toBeEnabled();
    available = false;
    const warning = page.getByRole("note").filter({ hasText: "Workspace status could not be refreshed." });
    await expect(warning).toBeVisible();
    const failedRead = page.getByRole("status").filter({ hasText: "Workspace status could not be refreshed." });
    await expect(failedRead).toHaveCount(1);
    await expect(confirm).toBeDisabled();
    expect(writes).toBe(0);
    const retry = warning.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeEnabled();
    available = true;
    await retry.click();
    await expect(confirm).toBeEnabled();
    await expect(failedRead).toHaveCount(0);
    await confirm.click();
    expect(writes).toBe(1);
  });
});

test.describe("Trading 212 account cards", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  function trading212(profile: "invest" | "isa", overrides: Partial<IntegrationSummary> = {}): IntegrationSummary {
    return { ...alpaca(true), integrationId: `synthetic-${profile}`, provider: "trading212", profile, ...overrides };
  }

  for (const locale of ["en", "zh"] as const) {
    const copy = <T>(zh: T, en: T): T => (locale === "zh" ? zh : en);
    const hint = copy("连接后，前往数据状态开始更新。", "Once connected, start an update in Data status.");

    test(`a connected account names no next step, and an unconnected one does (${locale})`, async ({ page }) => {
      const { unexpected } = await open(page, () => overview([trading212("invest")]), undefined, 0, locale);
      const accounts = page.locator("section.mx-panel").filter({
        has: page.getByRole("heading", { level: 2, name: copy(/^Trading.?212 账户$/, /^Trading.?212 accounts$/) }),
      });
      // The card is the heading's grandparent: the title sits inside the toolbar row.
      const invest = accounts.getByRole("heading", { level: 3, name: "Invest", exact: true }).locator("xpath=../..");
      const isa = accounts.getByRole("heading", { level: 3, name: /^Stocks.?ISA$/ }).locator("xpath=../..");

      // Connected: the badge and the button say so, and no paragraph leaves a gap where the next step was.
      await expect(invest).toContainText(copy("已连接", "Connected"));
      await expect(invest).not.toContainText(hint);
      await expect(invest.locator("p")).toHaveCount(0);
      await expect(invest.getByRole("button", { name: copy(/^管理连接/, /^Manage connection/) })).toBeVisible();

      // Not connected: the badge and the button say so, and the card names the next step.
      await expect(isa).toContainText(copy("未连接", "Not connected"));
      await expect(isa).toContainText(hint);
      await expect(isa.getByRole("button", { name: copy(/^连接账户/, /^Connect account/) })).toBeVisible();
      expect(unexpected).toEqual([]);
    });

    test(`a connected account that has not been tested keeps its test row (${locale})`, async ({ page }) => {
      const { unexpected } = await open(page, () => overview([trading212("invest", { lastTestAt: null, lastTestStatus: "untested" })]), undefined, 0, locale);
      const invest = page.getByRole("heading", { level: 3, name: "Invest", exact: true }).locator("xpath=../..");
      await expect(invest).toContainText(copy("已连接", "Connected"));
      await expect(invest).toContainText(copy("上次测试", "Last tested"));
      await expect(invest).toContainText(copy("未测试", "Not tested"));
      await expect(invest).not.toContainText(copy("尚未更新", "Awaiting update"));
      await expect(invest).not.toContainText(hint);
      await expect(invest.locator("p")).toHaveCount(0);
      expect(unexpected).toEqual([]);
    });
  }

  test("an account that needs reconnecting still names the next step", async ({ page }) => {
    const { unexpected } = await open(page, () => overview([trading212("invest", { needsSecret: true })]));
    const invest = page.getByRole("heading", { level: 3, name: "Invest", exact: true }).locator("xpath=../..");
    await expect(invest).toContainText("Reconnect needed");
    await expect(invest).toContainText("Once connected, start an update in Data status.");
    await expect(invest.getByRole("button", { name: /^Connect account/ })).toBeVisible();
    expect(unexpected).toEqual([]);
  });
});

test.describe("Model provider cards", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  for (const locale of ["en", "zh"] as const) {
    const copy = <T>(zh: T, en: T): T => (locale === "zh" ? zh : en);
    const hint = copy("连接后，在下方为研究用途选择模型。", "Once connected, choose a model for each research task below.");

    test(`a connected provider names no next step, and an unconnected one does (${locale})`, async ({ page }) => {
      const server = overview([{ ...alpaca(true), integrationId: "synthetic-openai", provider: "openai", model: "gpt-5" }]);
      server.llmProviders = [
        { provider: "openai", label: "OpenAI", adapter: "openai", baseUrl: "https://example.invalid", models: ["gpt-5"], defaultModel: "gpt-5", authMethod: "api_key" },
        { provider: "deepseek", label: "DeepSeek", adapter: "deepseek", baseUrl: "https://example.invalid", models: ["deepseek-chat"], defaultModel: "deepseek-chat", authMethod: "api_key" },
      ];
      const { unexpected } = await open(page, () => server, undefined, 0, locale);
      await page.getByRole("tab", { name: copy("模型连接", "Model connections"), exact: true }).click();
      const providers = page.locator("section.mx-panel").filter({
        has: page.getByRole("heading", { level: 2, name: copy(/^模型连接（可选）$/, /^Model connections \(optional\)$/) }),
      });
      const openai = providers.getByRole("heading", { level: 3, name: "OpenAI", exact: true }).locator("xpath=../..");
      const deepseek = providers.getByRole("heading", { level: 3, name: "DeepSeek", exact: true }).locator("xpath=../..");

      // Connected: the badge and the button say so, and the only paragraph is the model, with no gap for a next step.
      await expect(openai).toContainText(copy("已连接", "Connected"));
      await expect(openai).not.toContainText(hint);
      await expect(openai.locator("p")).toHaveCount(1);
      await expect(openai.locator("p")).toHaveText("gpt-5");
      await expect(openai.getByRole("button", { name: copy(/^管理连接/, /^Manage connection/) })).toBeVisible();

      // Not connected: the badge and the button say so, and the card names the next step.
      await expect(deepseek).toContainText(copy("未连接", "Not connected"));
      await expect(deepseek).toContainText(hint);
      await expect(deepseek.getByRole("button", { name: copy(/^连接模型/, /^Connect model/) })).toBeVisible();
      expect(unexpected).toEqual([]);
    });
  }
});
