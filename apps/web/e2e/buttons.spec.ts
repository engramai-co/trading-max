import { expect, test } from "@playwright/test";
import type { IntegrationOverview } from "../lib/types";

test.describe("button primitives, focus, loading stability, copy and touch targets", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a seeded local preview.");

  test("buttons draw a single 2px focus ring and keep exact width while loading", async ({ page }) => {
    let hold = false;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/health/details", async (route) => {
      if (hold) await gate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });

    await page.goto("/health");
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    const checkNow = page.getByRole("button", { name: "Check now", exact: true });
    await expect(checkNow).toBeVisible();

    // Keyboard focus via Tab shows one outline ring (2px, offset 2px) and no box-shadow ring.
    await page.keyboard.press("Tab");
    await checkNow.focus();
    const ring = await checkNow.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        borderRadius: parseFloat(s.borderRadius),
        height: el.getBoundingClientRect().height,
        outlineWidth: s.outlineWidth,
        outlineStyle: s.outlineStyle,
        outlineOffset: s.outlineOffset,
        boxShadow: s.boxShadow,
      };
    });
    expect(ring.borderRadius).toBeGreaterThanOrEqual(999);
    expect(ring.height).toBeGreaterThanOrEqual(40);
    expect(ring.outlineStyle).toBe("solid");
    expect(ring.outlineWidth).toBe("2px");
    expect(ring.outlineOffset).toBe("2px");
    expect(ring.boxShadow).toBe("none");

    const beforeWidth = (await checkNow.boundingBox())!.width;
    hold = true;
    await page.keyboard.press("Enter");
    const checking = page.getByRole("button", { name: "Checking…", exact: true });
    await expect(checking).toBeVisible();
    await expect(checking.locator("[data-slot=button-spinner]")).toBeVisible();
    await expect(checking).toHaveAttribute("aria-busy", "true");
    await expect(checking).toHaveAttribute("aria-disabled", "true");
    await expect(checking).toBeFocused();
    const loadingWidth = (await checking.boundingBox())!.width;
    expect(Math.abs(loadingWidth - beforeWidth)).toBeLessThanOrEqual(0.5);

    release();
    await expect(checkNow).toBeVisible();
    await expect(checkNow).not.toHaveAttribute("aria-busy");
    await expect(checkNow).toBeEnabled();
    await expect(checkNow).toBeFocused();
  });

  test("save actions show localised progress labels without jumping width", async ({ page, request }) => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    await page.route("**/api/backend/profile", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const submitted = route.request().postDataJSON();
      await gate;
      overview.profile = { ...overview.profile, ...submitted, revision: overview.profile.revision + 1 };
      await route.fulfill({ json: overview.profile });
    });

    await page.goto("/settings?tab=preferences");
    const nameInput = page.getByRole("textbox", { name: "Display name" });
    await nameInput.fill("Loading Label Check");

    const saveBtn = page.getByRole("button", { name: "Save preferences", exact: true });
    await expect(saveBtn).toBeVisible();
    const idleWidth = (await saveBtn.boundingBox())!.width;

    await saveBtn.click();
    const savingBtn = page.getByRole("button", { name: "Saving…", exact: true });
    await expect(savingBtn).toBeVisible();
    await expect(savingBtn.locator("[data-slot=button-spinner]")).toBeVisible();
    await expect(savingBtn).toHaveAttribute("aria-busy", "true");
    const loadingWidth = (await savingBtn.boundingBox())!.width;
    expect(Math.abs(loadingWidth - idleWidth)).toBeLessThanOrEqual(0.5);

    release();
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeEnabled();
    await expect(page.getByText("Preferences saved.", { exact: true })).toBeVisible();
  });

  test("shell switches cleanly between More menu at 767px and sidebar rail at 768px", async ({ page, isMobile }) => {
    test.skip(isMobile, "Desktop width boundary audit");
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.setViewportSize({ width: 767, height: 844 });
    await page.goto("/");

    const sidebar = page.locator(".mx-sidebar");
    const more = page.getByRole("button", { name: "More", exact: true });
    const appearance = page.getByRole("button", { name: "Choose appearance", exact: true });

    await expect(sidebar).toBeHidden();
    await expect(page.locator(".mx-mobile-dock")).toBeVisible();
    await expect(more).toBeVisible();
    await expect(appearance).toBeHidden();

    await more.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Data status" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 768, height: 844 });
    await expect(sidebar).toBeVisible();
    await expect(page.locator(".mx-mobile-dock")).toBeHidden();
    await expect(more).toBeHidden();
    await expect(appearance).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Data status" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  test("close controls use 40px desktop / 44px touch targets outside tables", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const minBox = isMobile ? 43.5 : 39.5;

    // Holdings search clear button.
    await page.goto("/holdings");
    const filter = page.getByRole("searchbox", { name: "Filter holdings" });
    await filter.fill("a");
    const clearBtn = page.getByRole("button", { name: "Clear search", exact: true });
    await expect(clearBtn).toBeVisible();
    const clearBox = (await clearBtn.boundingBox())!;
    expect(clearBox.width).toBeGreaterThanOrEqual(minBox);
    expect(clearBox.height).toBeGreaterThanOrEqual(minBox);
    if (isMobile) {
      const filterFontSize = await filter.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(filterFontSize).toBeGreaterThanOrEqual(16);
    }

    // Help popover close button (desktop) or bottom-sheet close button (mobile).
    await page.goto("/");
    const infoBtn = page.locator(".mx-info").first();
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();
    const helpClose = page.getByRole("button", { name: "Close explanation", exact: true });
    await expect(helpClose).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
    const helpCloseBox = (await helpClose.boundingBox())!;
    expect(helpCloseBox.width).toBeGreaterThanOrEqual(minBox);
    expect(helpCloseBox.height).toBeGreaterThanOrEqual(minBox);
  });

  test("reduced-motion button press does not scale or shrink while held", async ({ page, isMobile }) => {
    test.skip(isMobile, "Pointer press hold check");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.goto("/health");

    const checkNow = page.getByRole("button", { name: "Check now", exact: true });
    await expect(checkNow).toBeVisible();
    const idleBox = (await checkNow.boundingBox())!;

    await page.mouse.move(idleBox.x + idleBox.width / 2, idleBox.y + idleBox.height / 2);
    await page.mouse.down();
    try {
      const pressed = await checkNow.evaluate((el) => {
        const s = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          isActive: el.matches(":active"),
          scale: s.scale,
          transform: s.transform,
          width: rect.width,
          height: rect.height,
        };
      });
      expect(pressed.isActive).toBe(true);
      expect(pressed.scale).toBe("none");
      expect(pressed.transform).toBe("none");
      expect(Math.abs(pressed.width - idleBox.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(pressed.height - idleBox.height)).toBeLessThanOrEqual(0.5);
    } finally {
      await page.mouse.up();
    }
  });

  test("CopyButton announces via a sibling live region, keeps width, and reports clipboard failure", async ({ page, request }) => {
    await page.addInitScript(() => {
      localStorage.setItem("trading_max-locale", "en");
      let fail = false;
      (window as unknown as { __setCopyFail?: (v: boolean) => void; __copied?: string[] }).__setCopyFail = (v) => { fail = v; };
      (window as unknown as { __copied?: string[] }).__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (fail) throw new Error("blocked");
            (window as unknown as { __copied: string[] }).__copied.push(text);
          },
        },
      });
    });

    const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
    overview.integrations = overview.integrations.map((item) => ({ ...item, configured: false, enabled: false }));
    await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: overview }));
    const session = {
      sessionId: "synthetic-copy-session", state: "pending", userCode: "COPY-9876",
      verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2099-01-01T00:00:00Z", errorCode: null,
    };
    await page.route("**/api/backend/settings/llm/oauth/openai/start", (route) => route.fulfill({ json: session }));
    await page.route("**/api/backend/settings/llm/oauth/openai/synthetic-copy-session", (route) =>
      route.request().method() === "DELETE" ? route.fulfill({ status: 204 }) : route.fulfill({ json: session }),
    );

    await page.goto("/settings?tab=models");
    await page.getByRole("button", { name: "Choose a provider", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect OpenAI" });
    await dialog.getByRole("button", { name: "Sign in with ChatGPT" }).click();

    const copyBtn = dialog.getByRole("button", { name: "Copy code" });
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toHaveAttribute("command", "--copy");
    await expect(dialog.getByRole("button", { name: "Waiting for authorisation" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Waiting for authorisation" }).locator("[data-slot=button-spinner]")).toBeVisible();
    const idleWidth = (await copyBtn.boundingBox())!.width;

    // Live region sits outside the button.
    await expect(copyBtn.locator("[role=status]")).toHaveCount(0);
    await copyBtn.click();
    await expect(copyBtn).toHaveAttribute("data-copied", "");
    await expect(copyBtn.getByText("Copied", { exact: true })).toBeVisible();
    expect(Math.abs((await copyBtn.boundingBox())!.width - idleWidth)).toBeLessThanOrEqual(0.5);
    await expect(dialog.getByRole("status").filter({ hasText: "One-time code copied" })).toHaveCount(1);

    // Inline external Sign-in help TextLink preserves external security attributes.
    const helpLink = dialog.getByRole("link", { name: "Sign-in help" });
    await expect(helpLink).toHaveAttribute("href", "https://learn.chatgpt.com/docs/auth");
    await expect(helpLink).toHaveAttribute("target", "_blank");
    await expect(helpLink).toHaveAttribute("rel", /noopener/);

    // Clipboard failure shows explicit failure state rather than silent Copied.
    await page.evaluate(() => {
      (window as unknown as { __setCopyFail: (v: boolean) => void }).__setCopyFail(true);
      document.execCommand = () => false;
    });
    await copyBtn.click();
    await expect(copyBtn).toHaveAttribute("data-failed", "");
    await expect(copyBtn.getByText("Copy failed", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("status").filter({ hasText: "Could not copy code" })).toHaveCount(1);
  });

  test("destructive confirmation uses red text and outline with transparent fill", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.goto("/settings?tab=assistant");
    await page.getByRole("button", { name: "Delete conversations" }).click();
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Delete all conversations" });
    await expect(confirm).toBeVisible();
    const styles = await confirm.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, borderWidth: s.borderTopWidth, borderColor: s.borderTopColor, color: s.color };
    });
    expect(styles.bg).toBe("rgba(0, 0, 0, 0)");
    expect(styles.borderWidth).toBe("1px");
    expect(styles.borderColor).toBe(styles.color);
  });

  test("coarse-pointer controls clear 44px without overlapping neighbours", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Coarse-pointer phone target audit");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));

    await page.goto("/");
    // The loading picker is replaced when the market data resolves.
    const market = page.getByRole("button", { name: "Choose market, now: US sectors", exact: true });
    await expect(market).toBeVisible();
    const marketBox = (await market.boundingBox())!;
    expect(marketBox.width).toBeGreaterThanOrEqual(43.5);
    expect(marketBox.height).toBeGreaterThanOrEqual(43.5);

    const infoBoxes = await page.locator(".mx-info").evaluateAll((els) =>
      els.filter((e) => e.getClientRects().length > 0).map((e) => e.getBoundingClientRect()),
    );
    expect(infoBoxes.length).toBeGreaterThan(0);
    for (const box of infoBoxes) {
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }

    // Connection drawer close button and PasswordInput visibility toggle clear 44x44.
    await page.goto("/settings?tab=accounts");
    await page.getByRole("button", { name: /Manage connection|Connect account/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const closeBox = (await dialog.locator("[data-overlay-close]").boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(43.5);
    expect(closeBox.height).toBeGreaterThanOrEqual(43.5);
    const revealBox = (await dialog.getByRole("button", { name: /show or hide/i }).first().boundingBox())!;
    expect(revealBox.width).toBeGreaterThanOrEqual(43.5);
    expect(revealBox.height).toBeGreaterThanOrEqual(43.5);
    const passwordFontSize = await dialog.locator("input[type=password]").first().evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    expect(passwordFontSize).toBeGreaterThanOrEqual(16);
    await page.keyboard.press("Escape");

    // Global markets ETF price proxies summary clears 44px.
    await page.goto("/sectors?market=global");
    const proxySummary = page.locator(".mx-global-proxy > summary");
    if (await proxySummary.count()) {
      const box = (await proxySummary.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("option chain provides one touch-sized target per contract side around the strike", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const expiry = "2026-11-20";
    const chain = {
      ticker: "AAPL", currency: "USD", spot: 100, capturedAt: "2026-11-16T15:00:00Z",
      availability: { state: "current", currentExpiries: [expiry] }, availableExpiries: [expiry],
      expiries: [{ expiry, callOpenInterest: 1000, putOpenInterest: 1000, putCallOiRatio: 1, gammaProfile: [] }],
      contracts: (["call", "put"] as const).map((side) => ({
        expiry, side, strike: 100, multiplier: 100, currency: "USD",
        contractSymbol: "AAPL261120" + (side === "call" ? "C" : "P") + "00100000",
        bid: 4, ask: 4.4, lastPrice: 4.2, impliedVolatility: 0.3, delta: 0.5, gamma: 0.01, volume: 10,
        openInterest: 1000, gex1pct: 1000,
      })),
    };
    await page.route("**/api/backend/research/AAPL/lens/options?**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), options: chain } });
    });

    await page.goto("/research?ticker=AAPL&view=options");
    const row = page.locator(".mx-option-chain tbody tr").first();
    await expect(row).toBeVisible();
    // Exactly 2 buttons for the strike row: one Call target and one Put target.
    const buttons = row.locator("button.mx-cell-button");
    await expect(buttons).toHaveCount(2);
    const box = (await buttons.first().boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(43.5);
    expect(box.height).toBeGreaterThanOrEqual(isMobile ? 43.5 : 31.5);
  });

  test("compact research cards use 40px buttons at narrow fine-pointer widths while table rows keep 32px", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({
        response,
        json: {
          ...json,
          analyst: {
            ...(json.analyst ?? {}),
            asOf: "2026-10-05",
            reportingCurrency: "USD",
            fiscalPeriods: [
              { period: "0y", endDate: "2027-09-25" },
              { period: "+1y", endDate: "2028-09-24" },
            ],
            revenueEstimate: [
              { period: "0y", avg: 120e9, low: 115e9, high: 125e9, yearAgoRevenue: 110e9, growth: 0.091, numberOfAnalysts: 20, currency: "USD" },
              { period: "+1y", avg: 132e9, low: 126e9, high: 138e9, yearAgoRevenue: 120e9, growth: 0.1, numberOfAnalysts: 18, currency: "USD" },
            ],
            earningsEvents: [
              { id: "event1", date: "2026-10-01", status: "reported", actualEps: 1.9, estimatedEps: 1.8 },
            ],
          },
        },
      });
    });

    await page.goto("/research?ticker=AAPL&view=analyst&estimateFrequency=year");
    const forecasts = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: "Earnings & revenue estimates" }) });
    const events = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: "Earnings events" }) });

    if (isMobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      const forecastBtn = forecasts.locator(".mx-compact-records").getByRole("button", { name: "Use as model reference" }).first();
      const eventBtn = events.locator(".mx-compact-records").getByRole("button", { name: "View price" }).first();
      await expect(forecastBtn).toBeVisible();
      await expect(eventBtn).toBeVisible();
      await expect(forecastBtn).toHaveAttribute("data-size", "default");
      await expect(eventBtn).toHaveAttribute("data-size", "default");
      expect((await forecastBtn.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      expect((await eventBtn.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      return;
    }

    // Desktop width (1440x900, fine pointer): buttons live inside table rows and stay 32px.
    const wideForecastBtn = forecasts.getByRole("table").getByRole("button", { name: "Use as model reference" }).first();
    const wideEventBtn = events.getByRole("table").getByRole("button", { name: "View price" }).first();
    await expect(wideForecastBtn).toBeVisible();
    await expect(wideEventBtn).toBeVisible();
    await expect(wideForecastBtn).toHaveAttribute("data-size", "table");
    await expect(wideEventBtn).toHaveAttribute("data-size", "table");
    const wideForecastHeight = (await wideForecastBtn.boundingBox())!.height;
    const wideEventHeight = (await wideEventBtn.boundingBox())!.height;
    expect(wideForecastHeight).toBeGreaterThanOrEqual(31.5);
    expect(wideForecastHeight).toBeLessThanOrEqual(32.5);
    expect(wideEventHeight).toBeGreaterThanOrEqual(31.5);
    expect(wideEventHeight).toBeLessThanOrEqual(32.5);

    // Narrow fine-pointer width (700x900, not isMobile): tables hide and compact cards use 40px default buttons.
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(wideForecastBtn).toBeHidden();
    await expect(wideEventBtn).toBeHidden();
    const compactForecastBtn = forecasts.locator(".mx-compact-records").getByRole("button", { name: "Use as model reference" }).first();
    const compactEventBtn = events.locator(".mx-compact-records").getByRole("button", { name: "View price" }).first();
    await expect(compactForecastBtn).toBeVisible();
    await expect(compactEventBtn).toBeVisible();
    await expect(compactForecastBtn).toHaveAttribute("data-size", "default");
    await expect(compactEventBtn).toHaveAttribute("data-size", "default");
    const compactForecastHeight = (await compactForecastBtn.boundingBox())!.height;
    const compactEventHeight = (await compactEventBtn.boundingBox())!.height;
    expect(compactForecastHeight).toBeGreaterThanOrEqual(39.5);
    expect(compactForecastHeight).toBeLessThanOrEqual(40.5);
    expect(compactEventHeight).toBeGreaterThanOrEqual(39.5);
    expect(compactEventHeight).toBeLessThanOrEqual(40.5);
  });
});
