import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { IntegrationOverview, ResearchShell } from "../lib/types";

test.describe("workspace overlays", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires the seeded preview.");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("Escape closes the finder before the research list", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto("/research?ticker=NVDA");
    const trigger = page.locator(".mx-security-switcher");
    await trigger.click();
    const list = page.getByRole("dialog", { name: "Research list", exact: true });
    const search = list.getByRole("button", { name: "Search", exact: true });
    await search.click();
    const finder = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(finder).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toHaveCount(0);
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("desktop P&L help leaves the headline figures visible", async ({ page, isMobile }) => {
    test.skip(isMobile);
    const { promise: releaseOverview, resolve } = Promise.withResolvers<void>();
    await page.route("**/api/backend/dashboard/lens/overview?**", async route => {
      await releaseOverview;
      await route.continue();
    });
    const help = page.getByRole("dialog", { name: "Period net P&L" });
    const reading = page.locator(".mx-overview-history .mx-data-body .mx-period-figure");
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Period net P&L explained" }).first().click();
      await expect(help).toHaveCSS("opacity", "1");
      await expect(reading).toHaveCount(0);
    } finally {
      resolve();
    }
    await expect(reading).toBeVisible();
    await expect.poll(async () => {
      const amount = (await reading.boundingBox())!;
      const popover = (await help.boundingBox())!;
      const overlapX = popover.x < amount.x + amount.width && amount.x < popover.x + popover.width;
      const overlapY = popover.y < amount.y + amount.height && amount.y < popover.y + popover.height;
      return overlapX && overlapY;
    }).toBe(false);
  });

  test("keyboard readers can scroll help in a short window", async ({ page }) => {
    await page.setViewportSize({ width: 670, height: 300 });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "Period net P&L explained" }).first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const help = page.getByRole("dialog", { name: "Period net P&L" });
    const close = help.getByRole("button", { name: "Close explanation" });
    await expect(close).toBeFocused();
    const region = help.getByRole("region", { name: "Period net P&L" });
    await page.keyboard.press("Tab");
    await expect(region).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(() => region.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("a holding sheet hides background landmarks and restores focus", async ({ page }) => {
    await page.goto("/holdings");
    const trigger = page.locator(".mx-table-button:visible, .mx-holding-mobile:visible").first();
    await trigger.focus();
    await page.keyboard.press("Space");
    const sheet = page.getByRole("dialog", { name: "Holding detail" });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Close holding detail" })).toBeFocused();
    await expect(sheet).toHaveCSS("opacity", "1");
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("research removal alertdialog suppresses J/K and removes the original ticker", async ({ page }) => {
    const stamp = "2026-11-11T16:30:00Z";
    const instruments = [
      { ticker: "SYN1", watchlistTicker: "SYN1", name: "Synthetic One", exchange: "NMS", status: "ready", order: 0, lastRunId: "syn", held: false, watchlisted: true, isFund: false, categoryId: "core", exposureGbp: 0, directValueGbp: 0, gics: null },
      { ticker: "SYN2", watchlistTicker: "SYN2", name: "Synthetic Two", exchange: "NMS", status: "ready", order: 1, lastRunId: "syn", held: false, watchlisted: true, isFund: false, categoryId: "core", exposureGbp: 0, directValueGbp: 0, gics: null },
    ];
    let list = [...instruments];
    const removed: Array<{ path: string; body: unknown }> = [];
    await page.route("**/api/backend/research/shell*", (route) => route.fulfill({ json: {
      status: { runId: "syn", overall: "fresh", artifacts: [] },
      watchlistCategories: [{ id: "core", labelZh: "核心", labelEn: "Core" }],
      instruments: list,
    } }));
    await page.route("**/api/backend/research/*/lens/*", (route) => {
      const ticker = new URL(route.request().url()).pathname.split("/")[4];
      return route.fulfill({ json: {
        ticker, view: "overview", runId: "syn", generatedAt: stamp, fundamentals: { metrics: {} },
        context: { quote: { ticker, price: 100, currency: "USD", asOf: stamp, source: "synthetic", exchange: "NMS" }, assetType: "EQUITY", capabilities: [], datasets: [] },
      } });
    });
    await page.route("**/api/backend/research/*/prices*", (route) => {
      const ticker = new URL(route.request().url()).pathname.split("/")[4];
      return route.fulfill({ json: { ticker, currency: "USD", actualInterval: "1d", points: [{ date: "2026-11-10", close: 99 }, { date: "2026-11-11", close: 100 }] } });
    });
    await page.route("**/api/backend/watchlist/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      removed.push({ path, body });
      const target = decodeURIComponent(path.split("/").at(-1)!);
      list = list.filter((item) => item.ticker !== target);
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto("/research?ticker=SYN1");
    const selection = page.locator(".mx-security-switcher");
    await expect(selection).toContainText("Synthetic One");
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove from research list" }).click();
    const alert = page.getByRole("alertdialog", { name: /Remove SYN1/ });
    const cancel = alert.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();

    // J and K must not move the research selection while the confirmation is open.
    await page.keyboard.press("j");
    await expect(page).toHaveURL(/ticker=SYN1/);
    await expect(selection).toContainText("Synthetic One");
    await page.keyboard.press("k");
    await expect(page).toHaveURL(/ticker=SYN1/);
    await expect(selection).toContainText("Synthetic One");
    await expect(cancel).toBeFocused();

    await alert.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(alert).toHaveCount(0);
    expect(removed).toEqual([{ path: "/api/backend/watchlist/SYN1", body: { action: "remove" } }]);
    await expect(selection).toContainText("Synthetic Two");
  });

  test("Escape closes an expanded select listbox before its parent overlay", async ({ page, request }) => {
    // 1. Model-provider dialog and OAuth connection sheet
    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    await page.goto("/settings?tab=models");
    await page.getByRole("button", { name: "Choose a provider", exact: true }).click();
    const providerDialog = page.getByRole("dialog", { name: "Connect your model", exact: true });
    await expect(providerDialog).toBeVisible();
    await providerDialog.getByRole("combobox", { name: "Model provider" }).click();
    await expect(providerDialog.getByRole("option", { name: "Anthropic", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option", { name: "Anthropic", exact: true })).toHaveCount(0);
    await expect(providerDialog).toBeVisible();

    // Open the OAuth sheet from the dialog and verify its model listbox stays portalled inside the sheet.
    await providerDialog.getByRole("button", { name: "Continue" }).click();
    const oauthSheet = page.getByRole("dialog", { name: "Connect OpenAI", exact: true });
    await expect(oauthSheet).toBeVisible();
    await oauthSheet.getByRole("combobox", { name: "Model" }).click();
    await expect(oauthSheet.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(oauthSheet.getByRole("option")).toHaveCount(0);
    await expect(oauthSheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(oauthSheet).toHaveCount(0);

    // Reopen the model-provider dialog cleanly and confirm a second Escape closes it.
    await page.reload();
    await page.getByRole("button", { name: "Choose a provider", exact: true }).click();
    await expect(providerDialog).toBeVisible();
    await providerDialog.getByRole("combobox", { name: "Model provider" }).click();
    await expect(providerDialog.getByRole("option", { name: "Anthropic", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(providerDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(providerDialog).toHaveCount(0);

    // 2. Note editor sheet
    await page.route("**/api/backend/research/NVDA/journal*", (route) => route.fulfill({ json: {
      ticker: "NVDA",
      baselineModelId: null,
      notes: [],
      models: [{
        id: "model-1",
        savedAt: "2026-11-10T10:00:00Z",
        preview: { horizon: 5, basis: { currency: "USD" }, scenarios: { base: { value: 150 } } },
      }],
    } }));
    await page.goto("/research?ticker=NVDA&view=ledger");
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const noteSheet = page.getByRole("dialog", { name: "New note", exact: true });
    await expect(noteSheet).toBeVisible();
    await noteSheet.getByRole("combobox", { name: "Related model version" }).click();
    await expect(noteSheet.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(noteSheet.getByRole("option")).toHaveCount(0);
    await expect(noteSheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(noteSheet).toHaveCount(0);

    // 3. Fullscreen price chart dialog keeps its advanced Select listboxes portalled inside the dialog
    await page.goto("/research?ticker=NVDA&view=technical");
    await page.getByRole("button", { name: "Full chart", exact: true }).click();
    const fullChart = page.getByRole("dialog", { name: /NVDA.*Full chart/ });
    await expect(fullChart).toBeVisible();
    await fullChart.getByRole("button", { name: "Advanced", exact: true }).click();
    await fullChart.getByRole("combobox", { name: "Price axis" }).click();
    await expect(fullChart.getByRole("option", { name: "Log", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(fullChart.getByRole("option", { name: "Log", exact: true })).toHaveCount(0);
    await expect(fullChart).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(fullChart).toHaveCount(0);
  });

  test("composing Backspace leaves both comparison companies selected", async ({ page }) => {
    await page.goto("/research?ticker=NVDA&compare=on&peers=AAPL");
    const dialog = page.getByRole("dialog", { name: "Compare companies" });
    const input = dialog.getByRole("combobox", { name: "Up to 4 companies" });
    const chips = dialog.locator('[data-slot="picker-chip-label"]');
    await expect(chips).toHaveCount(2);
    await input.focus();
    await expect(input).toHaveValue("");
    await input.dispatchEvent("keydown", { key: "Backspace", isComposing: true });
    await expect(chips).toHaveCount(2);
    await expect(page).toHaveURL(/peers=AAPL/);

    await input.press("Backspace");
    await expect(chips).toHaveCount(1);
    await expect(page).not.toHaveURL(/peers=AAPL/);
  });

  test("successive Escapes close the company list then its dialog and retain the peer", async ({ page }) => {
    await page.goto("/research?ticker=NVDA&compare=on&peers=AAPL");
    const dialog = page.getByRole("dialog", { name: "Compare companies" });
    const input = dialog.getByRole("combobox", { name: "Up to 4 companies" });
    const list = dialog.getByRole("listbox", { name: "Up to 4 companies" });
    await input.click();
    await expect(list).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await expect(dialog.getByRole("button", { name: /^Remove AAPL/ })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/peers=AAPL/);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /^Remove AAPL/ })).toBeVisible();
  });

  test("successive Escapes close the model list then its connection sheet", async ({ page, request }) => {
    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    await page.goto("/settings?tab=models");
    await page.getByRole("button", { name: "Choose a provider", exact: true }).click();
    const provider = page.getByRole("dialog", { name: "Connect your model" });
    await provider.getByRole("combobox", { name: "Model provider" }).click();
    await provider.getByRole("option", { name: "Anthropic", exact: true }).click();
    await provider.getByRole("button", { name: "Continue" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect Anthropic" });
    const model = sheet.getByRole("combobox", { name: "Model to test" });
    await expect(model).toHaveValue(/claude-/);
    const label = await model.inputValue();
    await model.click();
    const list = sheet.getByRole("listbox", { name: "Model to test" });
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(model).toBeFocused();
    await expect(model).toHaveValue(label);

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("the related model clear button has its own touch target", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Touch target on the mobile project.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/backend/research/NVDA/journal*", (route) => route.fulfill({ json: {
      ticker: "NVDA",
      baselineModelId: null,
      notes: [],
      models: [{
        id: "model-1",
        savedAt: "2026-11-10T10:00:00Z",
        preview: { horizon: 5, basis: { currency: "USD" }, scenarios: { base: { value: 150 } } },
      }],
    } }));
    await page.goto("/research?ticker=NVDA&view=ledger");
    await page.getByRole("button", { name: "New note", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "New note", exact: true });
    const picker = dialog.getByRole("combobox", { name: "Related model version" });
    await picker.tap();
    await dialog.getByRole("option").first().tap();
    const clear = dialog.getByRole("button", { name: "Clear", exact: true });
    await expect(clear).toBeVisible();
    const targets = await clear.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const trigger = button.previousElementSibling!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, space: rect.left - trigger.right };
    });
    expect(targets.width).toBeGreaterThanOrEqual(44);
    expect(targets.height).toBeGreaterThanOrEqual(44);
    expect(targets.space).toBeGreaterThanOrEqual(0);
    await clear.tap();
    await expect(clear).toHaveCount(0);
    await expect(picker).toHaveText("");
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
  });

  test("company comparison exposes full long labels and retains its pinned company", async ({ page, request, isMobile }) => {
    const directory = await (await request.get("/api/backend/research/shell")).json() as ResearchShell;
    const sample = directory.instruments.find((item) => item.ticker === "NVDA")!;
    const company = "Synthetic International Holdings " + "有限责任公司全球投资".repeat(8);
    await page.route("**/api/backend/research/shell", (route) => route.fulfill({ json: {
      ...directory, instruments: [...directory.instruments, { ...sample, ticker: "SYN", name: company }],
    } }));
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/research?ticker=NVDA&compare=on");
    const dialog = page.getByRole("dialog", { name: "Compare companies" });
    const field = dialog.getByRole("combobox", { name: "Up to 4 companies" });
    await field.fill("Synthetic International");
    const option = dialog.getByRole("option", { name: "SYN · " + company, exact: true });
    await expect(option).toBeVisible();
    await option.click();

    const selected = dialog.locator('[data-slot="picker-chip-label"]').filter({ hasText: company });
    await expect(selected).toBeVisible();
    const truncated = () => selected.evaluate((element) => element.scrollWidth > element.clientWidth);
    if (isMobile) {
      expect(await truncated()).toBe(false);
    } else {
      expect(await truncated()).toBe(true);
      await selected.hover();
      await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: company })).toBeVisible();
    }
    const remove = dialog.getByRole("button", { name: "Remove SYN · " + company });
    if (isMobile) {
      const box = (await remove.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      const trigger = (await dialog.locator('[data-slot="combobox-trigger"]').boundingBox())!;
      expect(box.x + box.width <= trigger.x || box.y + box.height <= trigger.y || box.y >= trigger.y + trigger.height).toBe(true);
      await remove.tap();
    } else {
      await remove.click();
    }
    await expect(selected).toHaveCount(0);
    await expect(dialog.locator('[data-slot="picker-chip-label"]').filter({ hasText: "NVDA" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Remove NVDA/ })).toHaveCount(0);
  });

  test("AlertDialog uses the shared dialog surface tokens and scrolling body", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mantine-color-scheme-value", "auto"));
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.route("**/api/backend/settings/assistant", (route) => route.fulfill({ json: {
      enabled: false, route: null, acceptedDestination: null, acceptedConsentRevision: null, acceptedAt: null, reasoning: null,
      backgroundBriefsEnabled: true, shareValuationAssumptions: true, consentRevision: 2,
      revision: 1, updatedAt: "2026-01-01T00:00:00Z", providers: [], integrations: [],
    } }));
    await page.goto("/settings?tab=assistant");
    await page.getByRole("button", { name: "Delete conversations", exact: true }).click();
    const alert = page.getByRole("alertdialog", { name: "Delete all conversations?" });
    await expect(alert).toBeVisible();
    await expect(alert).toHaveCSS("border-radius", "26px");
    await expect(alert).toHaveCSS("box-shadow", "none");
    await expect(alert).toHaveCSS("border-top-width", "1px");
    expect(await alert.evaluate((el) => getComputedStyle(el).maxHeight)).not.toBe("none");
    await expect(alert.locator(".tm-overlay-body")).toHaveCSS("overflow-y", "auto");

    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
    await expect(alert).not.toHaveCSS("box-shadow", "none");
  });

  test("mobile MaxAI citations show external credit while preserving link activation", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Touch evidence visibility on the mobile project.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/backend/profile", (route) => route.fulfill({ json: { accountLabels: {}, assistantEnabled: true } }));
    await page.route("**/api/backend/assistant/status", (route) => route.fulfill({ json: { ready: true, code: null } }));
    await page.route("**/api/backend/assistant/roles/daily/reading", (route) => route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({
        type: "result",
        reading: {
          role: "daily", version: "synthetic", asOf: "2026-11-11T16:30:00Z",
          lines: [{
            section: "market",
            zh: "外媒报道了主要市场动态。",
            en: "External reporting noted the session move.",
            evidence: {
              source: "publisher",
              publisher: "Example Wire",
              tool: "sector_headline",
              evidenceId: "ev_ext",
              arguments: { url: "https://example.org/story", credit: "Synthetic News Credit" },
            },
          }],
        },
      }) + "\n",
    }));

    await page.goto("/");
    const digest = page.locator(".mx-digest");
    await digest.locator("[aria-expanded]").click();
    await expect(digest).toContainText("Synthetic News Credit");
    const link = digest.getByRole("link", { name: "Example Wire", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://example.org/story");
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("phone drawer supports swipe-to-dismiss", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Phone bottom drawer gesture.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "Period net P&L explained" }).first();
    await trigger.tap();
    const drawer = page.getByRole("dialog", { name: "Period net P&L" });
    await expect(drawer).toBeVisible();
    const handle = drawer.locator('[data-slot="drawer-swipe-handle"]');
    await expect(handle).toBeVisible();
    const dragFraction = await handle.evaluate(async (target) => {
      const box = target.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const popup = target.closest('[role="dialog"]')!;
      const start = popup.getBoundingClientRect();
      const distance = start.height * 0.65;
      const dispatch = (type: string, clientY: number) => {
        // Mobile WebKit exposes TouchEvent but does not construct Touch objects.
        const touch = { identifier: 1, target, clientX: x, clientY };
        const touches = type === "touchend" ? [] : [touch];
        const event = new TouchEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          targetTouches: { value: touches },
          changedTouches: { value: [touch] },
        });
        target.dispatchEvent(event);
      };
      dispatch("touchstart", y);
      for (let step = 1; step <= 10; step++) {
        await new Promise(requestAnimationFrame);
        dispatch("touchmove", y + distance * step / 10);
      }
      const moved = popup.getBoundingClientRect().y - start.y;
      dispatch("touchend", y + distance);
      return moved / start.height;
    });
    expect(dragFraction).toBeGreaterThan(0.5);
    await expect(drawer).toHaveCount(0);
  });

  test("phone drawer tracks visual-viewport resizes", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Phone bottom drawer viewport adaptation.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Period net P&L explained" }).first().tap();
    const drawer = page.getByRole("dialog", { name: "Period net P&L" });
    const viewportEl = page.locator('[data-slot="drawer-viewport"]');
    await expect(drawer).toBeVisible();
    await expect.poll(() => viewportEl.evaluate((el) => el.style.getPropertyValue("--tm-drawer-available"))).toBe("844px");

    await page.setViewportSize({ width: 390, height: 520 });
    await expect.poll(() => viewportEl.evaluate((el) => el.style.getPropertyValue("--tm-drawer-available"))).toBe("520px");
    expect((await drawer.boundingBox())!.height).toBeLessThanOrEqual(520);

    // Simulate a soft keyboard reducing visualViewport.height by 220px.
    const keyboardApplied = await page.evaluate(() => {
      const vv = window.visualViewport;
      if (!vv) return false;
      const reduced = Math.max(200, window.innerHeight - 220);
      Object.defineProperty(vv, "height", { configurable: true, get: () => reduced });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
      vv.dispatchEvent(new Event("resize"));
      return true;
    });
    expect(keyboardApplied).toBe(true);
    await expect.poll(() => viewportEl.evaluate((el) => el.style.getPropertyValue("--tm-keyboard-inset"))).toBe("220px");
    await expect.poll(() => viewportEl.evaluate((el) => el.style.getPropertyValue("--tm-drawer-available"))).toBe("300px");
    const box = (await drawer.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(301);
  });
});
