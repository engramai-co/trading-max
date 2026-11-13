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
async function open(page: Page, settings: () => IntegrationOverview) {
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
    if (path.endsWith("/imports/trading212/cfd")) return route.fulfill({ json: {
      parserVersion: "synthetic", accountStatus: "active", importedFiles: 0, uniqueEvents: 0, duplicateEvents: 0,
      totalRawRows: 0, isStale: false, warnings: [], files: [], coverageStartDate: null, coverageEndDate: null,
    } });
    return route.fulfill({ json: path.endsWith("/profile") ? { accountLabels: {} } : {} });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.goto("/settings");
  const panel = page.locator("section.mx-panel").filter({ has: page.getByRole("heading", { name: "Market data", exact: true }) });
  await expect(panel).toBeVisible();
  return { panel, unexpected };
}

/** Holds a request until the test releases it, so a pending state can be inspected. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
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

  test("one switch turns Alpaca on, holds while it saves and keeps keyboard focus", async ({ page, isMobile }) => {
    let server = alpaca(false);
    const { panel, unexpected } = await open(page, () => overview([server]));
    const toggle = panel.getByRole("switch", { name: "Alpaca enhancement", exact: true });
    await expect(toggle).not.toBeChecked();
    // On touch the switch takes taps across a 44px band of its row.
    if (isMobile) expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
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
    const panel = () => page.locator("section.mx-panel").filter({ has: page.getByRole("heading", { name: "Market data", exact: true }) });
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
    await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(dialog.getByText("SIP and overnight BOATS access verified.")).toBeVisible();
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
    await panel.getByRole("button", { name: "Remove keys", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove Alpaca keys" }).getByRole("button", { name: "Remove keys", exact: true }).click();
    await expect(panel.locator("input[role=switch]")).toBeDisabled();
    removing.release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(panel.locator("input[role=switch]")).toHaveCount(0);
    // Without keys nothing switches: the row names the source in use and offers Alpaca beside it.
    await expect(panel.getByRole("heading", { name: "Yahoo Finance", level: 3, exact: true })).toBeVisible();
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
    await remove.click();
    const dialog = page.getByRole("dialog", { name: "Remove Alpaca keys" });
    await dialog.getByRole("button", { name: "Remove keys", exact: true }).click();
    // The removal supersedes the failed change: its alert goes at once, and nothing else can start.
    await expect(panel.locator(".mx-notice")).toHaveCount(0);
    await expect(panel.locator("input[role=switch]")).toBeDisabled();
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
    await panel.getByRole("button", { name: "Remove keys", exact: true }).click();
    const removal = page.getByRole("dialog", { name: "Remove Alpaca keys" });
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
    await expect(panel.locator("input[role=switch]")).toBeChecked();
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
    const { unexpected } = await open(page, () => overview([]));
    const ledger = page.locator("section.mx-panel").filter({ has: page.getByRole("heading", { name: "CFD history ledger", exact: true }) });
    const drop = ledger.locator(".mx-import-drop");
    // The panel title is the only heading; the control's prompt says which file it wants.
    await expect(ledger.getByRole("heading")).toHaveCount(1);
    await expect(drop.getByText("Choose CFD activity CSV file", { exact: true })).toBeVisible();
    expect(await drop.ariaSnapshot()).toContain('button "Choose CFD activity CSV file"');
    // Choosing a file stays in the page; nothing is uploaded.
    await drop.locator("input[type=file]").setInputFiles({ name: "synthetic-activity.csv", mimeType: "text/csv", buffer: Buffer.from("Action,Time\n") });
    expect(await drop.ariaSnapshot()).toContain('button "CFD activity CSV file: synthetic-activity.csv"');
    const importLedger = drop.getByRole("button", { name: "Import ledger", exact: true });
    await expect(importLedger).toBeEnabled();
    expect(await axe(page)).toEqual([]);
    await drop.getByRole("button", { name: "Clear file", exact: true }).click();
    await expect(drop.getByRole("button", { name: "Choose CFD activity CSV file", exact: true })).toBeVisible();
    await expect(importLedger).toBeDisabled();
    expect(unexpected).toEqual([]);
  });
});
