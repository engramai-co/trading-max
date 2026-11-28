import { expect, test, type Page, type Route } from "@playwright/test";
import type { IntegrationOverview, IntegrationSummary } from "../lib/types";

type Scope = "web" | "app";
type Locale = "en" | "zh";

/** Loads a Settings tab with its data held, then measures the tab panel while it loads and once it has settled. */
async function reservedPanel(page: Page, isMobile: boolean, scope: Scope, tab: string, locale: Locale, respond: (route: Route) => Promise<void>) {
  await page.setViewportSize(scope === "app" ? { width: 1280, height: 820 } :
    isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.addInitScript(({ app, locale }) => {
    localStorage.setItem("trading_max-locale", locale);
    if (app) {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.setAttribute("data-desktop-chrome", "overlay");
      }, { once: true });
    }
  }, { app: scope === "app", locale });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = tab === "assistant" ? "assistant" : tab === "automation" ? "automation" : "integrations";
  await page.route("**/api/backend/settings/" + request, async (route) => {
    await held;
    return respond(route);
  });
  const path = `${scope === "app" ? "/desktop" : ""}/settings?tab=${tab}`;
  await page.goto(scope === "app" ? new URL(path, process.env.DESKTOP_DEMO_QA_URL).href : path, { waitUntil: "domcontentloaded" });
  const panel = page.getByRole("tabpanel");
  try {
    await expect(panel.getByRole("status").filter({ hasText: /Loading|正在读取数据/ })).toBeVisible();
  } catch (error) {
    release();
    throw error;
  }
  const before = (await panel.boundingBox())!.height;
  release();
  await expect(panel.locator("section").first()).toBeVisible();
  await expect(panel.getByRole("status").filter({ hasText: /Loading|正在读取数据/ })).toHaveCount(0);
  if (tab === "accounts" && scope === "web") {
    await expect(panel.getByRole("button", { name: /Choose CFD activity CSV file|选择 CFD 活动 CSV 文件/ })).toBeVisible();
  }
  const after = (await panel.boundingBox())!.height;
  const panels = await panel.locator(":scope > section").evaluateAll((sections) => sections.map((el) => el.getBoundingClientRect().height));
  return { before, after, panels };
}

function expectReserved(before: number, after: number, panels: number[]) {
  expect(Math.abs(before - after), `loading=${before}px, loaded=${after}px, sections=${panels.join(",")}`).toBeLessThanOrEqual(6);
}

/** Both Trading 212 accounts connected, as the desktop migration leaves them, with or without a connection test. */
function connectedAccounts(lastTestAt: string | null): IntegrationSummary[] {
  return (["invest", "isa"] as const).map((profile) => ({
    integrationId: `synthetic-${profile}`, provider: "trading212", profile, enabled: true, configured: true,
    model: null, baseUrl: null, credentialFingerprint: "synthetic", needsSecret: false,
    lastTestAt, lastTestStatus: lastTestAt ? "succeeded" : "untested", lastErrorCode: null,
    revision: 1, updatedAt: "2026-01-01T00:00:00Z",
  }));
}

for (const tab of ["accounts", "models", "assistant", "automation", "preferences"] as const) {
  for (const scope of ["web", "app"] as const) {
    for (const locale of ["en", "zh"] as const) {
      test(`Settings review reserves the ${scope} ${tab} panel on first load in ${locale}`, async ({ page, isMobile }) => {
        test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a synthetic web preview.");
        test.skip(Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID), "Compare the standard Settings workspace.");
        test.skip(scope === "app" && (isMobile || !process.env.DESKTOP_DEMO_QA_URL), "Requires the desktop preview.");
        const { before, after, panels } = await reservedPanel(page, isMobile, scope, tab, locale, (route) => route.continue());
        expectReserved(before, after, panels);
      });
    }
  }
}

for (const tested of ["untested", "tested"] as const) {
  for (const scope of ["web", "app"] as const) {
    for (const locale of ["en", "zh"] as const) {
      test(`Settings review reserves the ${scope} accounts panel for ${tested} connected accounts in ${locale}`, async ({ page, isMobile, request }) => {
        test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a synthetic web preview.");
        test.skip(Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID), "Compare the standard Settings workspace.");
        test.skip(scope === "app" && (isMobile || !process.env.DESKTOP_DEMO_QA_URL), "Requires the desktop preview.");
        // The seeded overview keeps its other providers; only the two accounts change.
        const overview = await (await request.get("/api/backend/settings/integrations")).json() as IntegrationOverview;
        overview.integrations = [
          ...overview.integrations.filter((item) => item.provider !== "trading212"),
          ...connectedAccounts(tested === "tested" ? "2026-09-18T09:30:00Z" : null),
        ];
        const { before, after, panels } = await reservedPanel(page, isMobile, scope, "accounts", locale, (route) => route.fulfill({ json: overview }));
        expectReserved(before, after, panels);
      });
    }
  }
}

for (const scope of ["web", "app"] as const) {
  for (const locale of ["en", "zh"] as const) {
    test(`Settings review reserves local onboarding in ${scope} in ${locale}`, async ({ page, isMobile }) => {
      test.skip(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID !== "synthetic-settings-review", "Requires the synthetic local onboarding preview.");
      test.skip(scope === "app" && (isMobile || !process.env.DESKTOP_DEMO_QA_URL), "Requires the desktop preview.");
      await page.setViewportSize(scope === "app" ? { width: 1280, height: 820 } :
        isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.addInitScript(({ app, locale }) => {
        localStorage.setItem("trading_max-locale", locale);
        if (app) document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.setAttribute("data-desktop-chrome", "overlay");
        }, { once: true });
      }, { app: scope === "app", locale });

      const integrations = Promise.withResolvers<void>();
      const status = Promise.withResolvers<void>();
      await page.route("**/api/backend/settings/integrations", async (route) => {
        await integrations.promise;
        return route.continue();
      });
      await page.route("**/api/backend/local-workspace", async (route) => {
        await status.promise;
        return route.fulfill({ json: {
          name: "Synthetic workspace", path: "/synthetic/workspace", connectedAccounts: [],
          readiness: { status: "not_ready" },
          latestFullJob: null, activeJobId: null, confirmed: false, canConfirm: false,
        } });
      });
      const path = `${scope === "app" ? "/desktop" : ""}/settings?tab=accounts&onboarding=1`;
      await page.goto(scope === "app" ? new URL(path, process.env.DESKTOP_DEMO_QA_URL).href : path, { waitUntil: "domcontentloaded" });
      const panel = page.getByRole("tabpanel");
      const loading = panel.getByRole("status").filter({ hasText: /Loading|正在读取(?:数据|本地工作区状态)/ }).first();
      const height = async () => (await panel.boundingBox())!.height;
      let before: number;
      let afterIntegrations: number;
      try {
        await expect(loading).toBeVisible();
        before = await height();
        integrations.resolve();
        await expect(panel.getByRole("heading", { name: /Trading.212 accounts|Trading.212 账户/ })).toBeVisible();
        await expect(loading).toBeVisible();
        afterIntegrations = await height();
      } finally {
        integrations.resolve();
        status.resolve();
      }
      await expect(panel.getByRole("heading", { name: /Set up your local workspace|开始使用你的本地工作区/ })).toBeVisible();
      const loaded = await height();
      const panelHeights = await panel.locator(":scope > section").evaluateAll((sections) => sections.map((el) => el.getBoundingClientRect().height));
      expect(Math.max(Math.abs(before - loaded), Math.abs(afterIntegrations - loaded)),
        `integrations=${before}px, status=${afterIntegrations}px, loaded=${loaded}px, sections=${panelHeights.join(",")}`,
      ).toBeLessThanOrEqual(6);
    });
  }
}
