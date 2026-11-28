import { expect, test } from "@playwright/test";

for (const tab of ["accounts", "models", "assistant", "automation", "preferences"] as const) {
  for (const scope of ["web", "app"] as const) {
    for (const locale of ["en", "zh"] as const) {
      test(`Settings review reserves the ${scope} ${tab} panel on first load in ${locale}`, async ({ page, isMobile }) => {
        test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a synthetic web preview.");
        test.skip(Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID), "Compare the standard Settings workspace.");
        test.skip(scope === "app" && (isMobile || !process.env.DESKTOP_DEMO_QA_URL), "Requires the desktop preview.");
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
          return route.continue();
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
        expect(Math.abs(before - after), `loading=${before}px, loaded=${after}px, sections=${panels.join(",")}`).toBeLessThanOrEqual(6);
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
