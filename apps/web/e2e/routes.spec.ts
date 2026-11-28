import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { prepareHistory } from "../lib/portfolio/prepared";

const routes = [
  "/",
  "/holdings",
  "/analytics",
  "/sectors",
  "/review",
  "/review?account=A",
  "/review?account=C",
  "/research",
  "/health",
  "/settings",
];
test.describe("portfolio workspace", () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.",
  );

  for (const route of routes) {
    test(`${route} has a usable heading, no horizontal overflow, and accessible controls`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // The shell heading appears before its data. Wait for both the skeleton and
      // a retained busy result to finish before measuring or scanning the page.
      await expect(page.locator("main :is(.mx-loading, [aria-busy=true])")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText(
        /This page could not be displayed|这一页暂时无法显示/,
      );
      expect.soft(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        "horizontal overflow in pixels",
      ).toBeLessThanOrEqual(1);
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) => animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations).toEqual([]);
    });
  }

  test("fallback headings follow the page title", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const notFound = await page.goto("/this-page-does-not-exist");
    expect(notFound?.status()).toBe(404);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: /页面不存在|Page not found/ })).toBeVisible();
    await expect(main.getByRole("heading", { level: 2, name: /检查页面地址|Check the page address/ })).toBeVisible();
    await expect(page).toHaveTitle("Page not found · Trading Max");
    const documentReads: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documentReads.push(request.url());
    });
    await main.getByRole("link", { name: /返回组合总览|Back to overview/ }).press("Enter");
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle("Overview · Trading Max");
    // A missing path below the desktop catch-all is returned in the client navigation payload.
    await page.evaluate(() => {
      const { next } = window as unknown as { next: { router: { push: (href: string) => void } } };
      next.router.push("/desktop/this-page-does-not-exist");
    });
    await expect(main.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await expect(page).toHaveTitle("Page not found · Trading Max");
    expect(documentReads).toEqual([]);

    await page.route("**/api/backend/indices/catalog", (route) => route.fulfill({ json: [] }));
    await page.goto("/research?type=index&index=missing");
    await expect(main.getByRole("heading", { level: 1, name: /研究|Research/ })).toHaveCount(1);
    await expect(main.getByRole("heading", { level: 2, name: /未找到此指数|Index not found/ })).toBeVisible();
  });

  test("a route render error names the tab, offers a safe route and reloads fresh reads", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let malformed = true;
    const sectors = /\/api\/backend\/sectors(?:\?|$)/;
    await page.route(sectors, (route) => malformed
      ? route.fulfill({ json: { markets: {} } }) : route.fallback());
    const main = page.getByRole("main");
    const heading = main.getByRole("heading", { level: 1, name: "This page could not be displayed" });
    const retry = main.getByRole("button", { name: "Reload page" });
    const holdings = main.getByRole("link", { name: "Open holdings" });

    await page.goto("/");
    await expect(page).toHaveTitle("This page could not be displayed · Trading Max");
    await expect(heading).toBeFocused();
    await expect(main.getByRole("heading", { level: 2, name: "Try reloading" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    await expect(retry).toHaveCSS("outline-width", "2px");
    await expect(retry).toHaveCSS("min-height", isMobile ? "44px" : "40px");
    if (isMobile) {
      await holdings.tap();
    } else {
      await page.keyboard.press("Tab");
      await expect(holdings).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(retry).toBeFocused();
      await holdings.press("Enter");
    }
    await expect(page).toHaveURL(/\/holdings$/);
    await expect(heading).toHaveCount(0);

    await page.goto("/");
    await expect(retry).toBeVisible();
    malformed = false;
    const freshRead = page.waitForRequest(sectors);
    await retry.press("Space");
    await freshRead;
    await expect(main.getByRole("heading", { level: 1, name: "Portfolio overview" })).toHaveCount(1);
    await expect(page).toHaveTitle("Overview · Trading Max");
  });

  test("the phone return comparison keeps its lead percentage together", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/analytics?view=returns");
    const reading = page.locator(".mx-return-reading .mx-number-value").first();
    await expect(reading).toHaveText(/%/);
    const lines = await reading.evaluate((value) => {
      const range = document.createRange();
      range.selectNodeContents(value);
      return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
    });
    expect(lines).toBe(1);
  });

  test("phone research controls keep normal journal labels together", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.goto("/research?ticker=NVDA&view=ledger");
    const label = page.getByRole("button", { name: "Model versions", exact: true }).locator(".mx-segment-label");
    await expect(label).toBeVisible();
    const lines = await label.evaluate((value) => {
      const range = document.createRange();
      range.selectNodeContents(value);
      return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
    });
    expect(lines).toBe(1);
  });

  test("settings tabs update both content and URL without reloading", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("tab", { name: /模型连接|Model connections/ }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /模型连接|Model connections/ }).click();
    await expect(page).toHaveURL(/tab=models/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: /模型连接（可选）|Model connections \(optional\)/,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /个人偏好|Preferences/ }).click();
    await expect(
      page.getByRole("textbox", { name: /显示名称|Display name/ }),
    ).toBeVisible();
  });

  test("the broker form requires a successful candidate test before save", async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/api/backend/settings/integrations/trading212/*/test", (route) => {
      requests++;
      return route.fulfill({ json: { status: "succeeded", validationToken: "synthetic-receipt" } });
    });
    await page.goto("/settings");
    const connect = page.getByRole("button", { name: /^(连接账户：|Connect account: )Invest$/ });
    const connectIsa = page.getByRole("button", { name: /^(连接账户：|Connect account: )Stocks ISA$/ });
    await expect(connectIsa).toBeVisible();
    await connect.click();
    const dialog = page.getByRole("dialog");
    const testConnection = dialog.getByRole("button", { name: /测试连接|Test connection/ });
    const save = dialog.getByRole("button", { name: /保存连接|Save connection/ });
    const key = dialog.getByLabel(/^API Key ID/);
    const secret = dialog.getByLabel(/^API Secret/);
    await expect(key).toHaveAttribute("autocomplete", "off");
    await expect(key).toHaveAttribute("name", "trading212-invest-key-id");
    await expect(secret).toHaveAttribute("autocomplete", "off");
    await expect(secret).toHaveAttribute("name", "trading212-invest-secret");
    await expect(save).toBeDisabled();
    await expect(testConnection).toBeEnabled();
    await testConnection.click();
    await expect(key).toBeFocused();
    await expect(key).toHaveAttribute("aria-invalid", "true");
    await expect(secret).toHaveAttribute("aria-invalid", "true");
    expect(requests).toBe(0);
    await key.fill("synthetic-id");
    await secret.fill("synthetic-secret");
    await expect(dialog.getByText(/^(Closing this form clears unsaved keys\.|关闭此表单会清除未保存的密钥。)$/)).toHaveCount(0);
    await expect(key).toHaveAttribute("aria-invalid", "false");
    await expect(secret).toHaveAttribute("aria-invalid", "false");
    await expect(save).toBeDisabled();
    await testConnection.click();
    await expect(save).toBeEnabled();
    expect(requests).toBe(1);
    await secret.fill("synthetic-new");
    await expect(save).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(connect).toBeFocused();
    await connectIsa.click();
    await expect(dialog.getByLabel(/^API Key ID/)).toHaveValue("");
    await expect(dialog.getByLabel(/^API Secret/)).toHaveValue("");
    await expect(dialog.getByLabel(/^API Secret/)).toHaveAttribute("name", "trading212-isa-secret");
  });

  test("failed data requests offer a retry and recover", async ({ page }) => {
    await page.route("**/api/backend/dashboard/lens/overview?**", (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );
    await page.goto("/");
    const assets = page.getByRole("region", { name: /账户价值|Account value/ });
    const retry = assets.getByRole("button", { name: /重试|Retry/ });
    await expect(assets.getByRole("combobox")).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(assets.locator(".mx-freshness")).toHaveCount(0);
    await expect(page.locator(".mx-overview-holdings")).not.toContainText(/还没有持仓|No holdings yet/);
    await page.unroute("**/api/backend/dashboard/lens/overview?**");
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(assets.locator(".mx-freshness")).toBeVisible();
  });

  for (const mode of ["truncated", "malformed holding date", "invalid timestamp"] as const) {
    test(`rejects the ${mode} Overview response and offers recovery`, async ({ page }) => {
      let invalid = true;
      const at = "2026-11-20T12:00:00Z";
      const truncated = { runId: "synthetic-malformed", brokerAsOf: at };
      const snapshot = { ...truncated, view: "overview", generatedAt: at, researchAsOf: "", totalValueGbp: 100 };
      const responses = {
        truncated,
        "malformed holding date": {
          ...snapshot, holdings: [{ account: "A", ticker: "SYN", name: "Synthetic holding", dayChangeClosedOn: 42 }],
        },
        "invalid timestamp": { ...snapshot, brokerAsOf: "not-a-timestamp" },
      };
      const overview = "**/api/backend/dashboard/lens/overview?**";
      const history = prepareHistory({ ...truncated, dataRevision: "synthetic", nav: [], intradayNav: [] }, { range: "1D", scope: "total" }).chart;
      await page.route("**/api/backend/dashboard/history?**", (route) =>
        invalid ? route.fulfill({ json: history }) : route.fallback());
      await page.route(overview, (route) => invalid
        ? route.fulfill({ json: responses[mode] })
        : route.fallback());
      await page.goto("/");
      const assets = page.getByRole("region", { name: /账户价值|Account value/ });
      const holdings = page.locator(".mx-overview-holdings");
      const retry = assets.getByRole("button", { name: /重试|Retry/ });
      await expect(retry).toBeVisible();
      await expect(page.getByRole("heading", { name: /暂无账户数据|No account data/ })).toHaveCount(0);
      await expect(assets.locator(".mx-freshness")).toHaveCount(0);
      await expect(holdings.getByRole("heading", { level: 3, name: /暂时无法读取数据|Data is temporarily unavailable/ })).toBeVisible();
      await expect(holdings).not.toContainText(/还没有持仓|No holdings yet/);

      invalid = false;
      await retry.press("Enter");
      await expect(assets.locator(".mx-freshness")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: /组合总览|Portfolio overview/ })).toHaveCount(1);
    });
  }

  for (const market of ["us", "global"] as const) {
    test(`a full connection outage has one recovery action for Overview and ${market} quotes`, async ({ page }) => {
      let disconnected = true;
      let healthChecks = 0;
      const marketPath = market === "us" ? "/api/backend/sectors" : "/api/backend/indices/global-contribution";
      await page.addInitScript((selected) => {
        localStorage.setItem("trading_max-locale", "en");
        localStorage.setItem("mx-overview-market", selected);
      }, market);
      await page.clock.install();
      await page.route("**/api/backend/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/health")) healthChecks++;
        if (!disconnected && url.pathname === marketPath) {
          return route.fulfill({ json: { markets: [] } });
        }
        return disconnected ? route.fulfill({ status: 503 }) : route.fallback();
      });
      await page.goto("/");
      const main = page.getByRole("main");
      const holdings = main.locator(".mx-overview-holdings");
      const assets = main.getByRole("region", { name: /账户价值|Account value/ });
      const retry = assets.getByRole("button", { name: /重试|Retry/ });
      await expect(retry).toBeVisible();
      const marketPanel = main.locator(".mx-overview-sectors");
      const unavailable = market === "us" ? "Sector quotes unavailable" : "Global quotes unavailable";
      await expect(marketPanel.getByRole("button", { name: "Retry: " + unavailable, exact: true })).toBeVisible();
      await expect.poll(() => healthChecks).toBe(1);

      await page.clock.fastForward(61_000);
      await expect.poll(() => healthChecks).toBe(2);
      await expect(marketPanel.locator(".mx-retry-reading > span")).toHaveText(unavailable);
      await expect(holdings.getByRole("heading", { level: 3, name: /暂时无法读取数据|Data is temporarily unavailable/ })).toBeVisible();
      await expect(main.getByRole("button", { name: /Retry|Try again/ })).toHaveCount(1);
      await expect(main.getByRole("link", { name: /查看数据状态|Data status/ })).toHaveCount(1);

      disconnected = false;
      const marketResponse = page.waitForResponse(response => new URL(response.url()).pathname === marketPath && response.ok());
      await retry.click();
      await marketResponse;
      await expect(marketPanel.getByRole("heading", { name: market === "us" ? "No sector data yet" : "No global quotes yet" })).toBeVisible();
      await expect(assets.locator(".mx-freshness")).toBeVisible();
    });
  }

  test("timed-out overview reads show timeout guidance without Freshness or empty holdings", async ({ page }) => {
    await page.route("**/api/backend/dashboard/lens/overview?**", (route) =>
      route.fulfill({ status: 504, json: { detail: "Portfolio backend timed out" } }),
    );
    await page.goto("/");
    const assets = page.getByRole("region", { name: /账户价值|Account value/ });
    const holdings = page.locator(".mx-overview-holdings");
    await expect(assets.getByRole("button", { name: /重试|Retry/ })).toBeVisible();
    await expect(assets.locator(".mx-freshness")).toHaveCount(0);
    await expect(holdings.getByRole("heading", { level: 3, name: /数据请求超时|Data request timed out/ })).toBeVisible();
    await expect(holdings).not.toContainText(/还没有持仓|No holdings yet/);
    await page.unroute("**/api/backend/dashboard/lens/overview?**");
    await holdings.getByRole("button", { name: /重新加载|Try again/ }).click();
    await expect(assets.getByRole("button", { name: /重试|Retry/ })).toHaveCount(0);
    await expect(assets.locator(".mx-freshness")).toBeVisible();
  });

  test("data status retries in place after an error", async ({ page }) => {
    let unavailable = true;
    await page.route("**/api/backend/health/details", (route) =>
      unavailable
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { checkedAt: "2026-10-20T12:00:00Z", health: null, readiness: null, refresh: null, jobs: [], errors: [] } }),
    );
    await page.goto("/health");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 2, name: /暂时无法读取数据|Data is temporarily unavailable/ })).toBeVisible();
    const retry = main.getByRole("button", { name: /^(重新检查|Check now)$/ });
    await expect(retry).toBeVisible();
    await expect(main.getByRole("link", { name: /查看数据状态|Data status/ })).toHaveCount(0);
    const documentNavigations: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) documentNavigations.push(request.url());
    });
    unavailable = false;
    await retry.click();
    await expect(main.getByRole("heading", { name: /更新记录|Update history/ })).toBeVisible();
    await expect(page).toHaveURL(/\/health$/);
    expect(documentNavigations).toEqual([]);
  });

  test("Holdings announces a failed read and announces its recovery once", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let unavailable = true;
    await page.route("**/api/backend/dashboard/lens/holdings-positions", (route) => unavailable
      ? route.fulfill({ status: 503, json: {} }) : route.fallback());
    await page.goto("/holdings");
    const main = page.getByRole("main");
    const failure = main.getByRole("status").filter({ hasText: /Holdings.*Data is temporarily unavailable/ });
    await expect(failure).toHaveCount(1);
    unavailable = false;
    await main.getByRole("button", { name: "Try again" }).click();
    await expect(main.getByRole("status").filter({ hasText: /Holdings.*Data is available again/ })).toHaveCount(1);
    await expect(failure).toHaveCount(0);
  });

  test("Holdings announces recovery after an automatic reconnect", async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let unavailable = true;
    await page.route("**/api/backend/dashboard/lens/holdings-positions", (route) => unavailable
      ? route.fulfill({ status: 503, json: {} }) : route.fallback());
    await page.goto("/holdings");
    const main = page.getByRole("main");
    await expect(main.getByRole("status").filter({ hasText: /Holdings.*Data is temporarily unavailable/ })).toHaveCount(1);
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    unavailable = false;
    await context.setOffline(false);
    await expect(main.getByRole("status").filter({ hasText: /Holdings.*Data is available again/ })).toHaveCount(1);
  });

  test("Holdings retry is easy to target and announces recovery once while retaining positions", async ({ page, context, isMobile }) => {
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    let unavailable = false;
    await page.route("**/api/backend/dashboard/lens/holdings-positions", route => route.fulfill(unavailable
      ? { status: 503, json: {} } : { json: {
        runId: "synthetic-holdings-refresh", brokerAsOf: "2026-11-20T21:00:00Z",
        holdings: [{ account: "A", ticker: "SYN", name: "Synthetic holding", currentValueGbp: 200, costGbp: 150, pnlGbp: 50 }],
      } }));
    await page.route("**/api/backend/health", route => route.fulfill({ json: {
      service: "trading_max-api", status: "ok", latestRunId: "synthetic-holdings-refresh",
    } }));
    await page.goto("/holdings");
    const main = page.getByRole("main");
    const positions = main.getByText("Synthetic holding", { exact: true }).filter({ visible: true });
    const badge = main.locator(".mx-update-failure");
    const failure = main.getByRole("status").filter({ hasText: "Holdings · Update failed" });
    const recovery = main.getByRole("status").filter({ hasText: "Holdings · Data is available again." });
    await expect(positions).toBeVisible();
    await expect(failure).toHaveCount(0);
    await expect(recovery).toHaveCount(0);

    unavailable = true;
    await page.clock.fastForward(31_000);
    await context.setOffline(true);
    await context.setOffline(false);
    await expect(badge).toBeVisible();
    await expect(positions).toBeVisible();
    await expect(failure).toHaveCount(1);
    await expect(recovery).toHaveCount(0);

    await badge.scrollIntoViewIfNeeded();
    const targetSize = isMobile ? 44 : 40;
    const hit = await badge.evaluate((button, size) => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const half = size / 2 - 1;
      const points = [[x, y - half], [x, y + half], [x - half, y], [x + half, y]];
      return { x, y: y + half, edges: points.map(([left, top]) => button.contains(document.elementFromPoint(left, top))) };
    }, targetSize);
    expect(hit.edges, `${targetSize}px retry target`).toEqual([true, true, true, true]);

    unavailable = false;
    if (isMobile) await page.touchscreen.tap(hit.x, hit.y);
    else await page.mouse.click(hit.x, hit.y);
    await expect(badge).toHaveCount(0);
    await expect(positions).toBeVisible();
    await expect(recovery).toHaveCount(1);
    await expect(failure).toHaveCount(0);
  });

  test("command search supports keyboard selection and closes after navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .locator(".mx-topbar")
      .getByRole("button", { name: /^(搜索|Search)$/ })
      .click();
    await page
      .getByRole("combobox", {
        name: /^(搜索|Search)$/,
      })
      .fill("research");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/research/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
