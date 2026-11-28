import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Sixty synthetic companies: forty in the United States, so a phone filter still spans two 25-row pages.
const positions = Array.from({ length: 60 }, (_, i) => ({
  entityId: `synthetic-${i + 1}`,
  ticker: `SYN${String(i + 1).padStart(2, "0")}`,
  name: `Synthetic Holding ${i + 1}`,
  country: i % 3 === 0 ? "United Kingdom" : "United States",
  valueGbp: 1000 - i * 10,
  allocationPct: (1000 - i * 10) / 50000,
  directValueGbp: i % 2 ? 0 : 1000 - i * 10,
  indirectValueGbp: i % 2 ? 1000 - i * 10 : 0,
  gics: { sectorName: i % 2 ? "Information Technology" : "Financials" },
  etfContributors: [],
}));

async function open(
  page: Page,
  locale: "zh" | "en" = "en",
  state: { runId: string; brokerAsOf: string; unavailable?: boolean } = {
    runId: "synthetic-lookthrough", brokerAsOf: "2026-11-04T15:00:00Z",
  },
  customPositions = positions,
) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
  // No write leaves the page.
  await page.route("**/*", (route) => route.request().method() === "GET" ? route.fallback() : route.abort());
  // Every backend request is answered here, so no real service is reached.
  await page.route("**/api/backend/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/health")) return route.fulfill({ json: {
      service: "trading_max-api", status: "ok", latestRunId: state.runId,
    } });
    if (path.endsWith("/dashboard/lens/holdings-lookthrough")) return route.fulfill(state.unavailable ? { status: 503, json: {} } : { json: {
      runId: state.runId, lookthrough: {
        brokerAsOf: state.brokerAsOf,
        available: true, positions: customPositions, underlyingCount: customPositions.length, sources: [],
        countryAllocation: [], industryAllocation: [], gicsSubIndustryAllocation: [],
        lookthroughCoveragePct: 1, gicsCoveragePct: 1, etfValueGbp: 30000,
      },
    } });
    if (path.endsWith("/analysis")) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: path.endsWith("/profile") ? { accountLabels: {} } : {} });
  });
  await page.route("**/api/company-logo/**", (route) => route.fulfill({ status: 204 }));
  await page.goto("/holdings?view=lookthrough");
  await expect(page.getByRole("button", { name: new RegExp(customPositions[0].ticker) }).first()).toBeVisible();
}

test.describe("look-through companies", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  test("a retained refresh failure and its recovery are each announced once", async ({ page, context }) => {
    await page.clock.install();
    const state = { runId: "synthetic-lookthrough-refresh", brokerAsOf: "2026-11-20T21:00:00Z", unavailable: false };
    await open(page, "en", state);
    const main = page.getByRole("main");
    const company = main.getByRole("button", { name: /SYN01/ }).first();
    const badge = main.locator(".mx-update-failure");
    const failure = main.getByRole("status").filter({ hasText: "Look-through holdings · Update failed" });
    const recovery = main.getByRole("status").filter({ hasText: "Look-through holdings · Data is available again." });
    await expect(failure).toHaveCount(0);
    await expect(recovery).toHaveCount(0);

    state.unavailable = true;
    await page.clock.fastForward(31_000);
    await context.setOffline(true);
    await context.setOffline(false);
    await expect(badge).toBeVisible();
    await expect(company).toBeVisible();
    await expect(failure).toHaveCount(1);
    await expect(recovery).toHaveCount(0);

    state.unavailable = false;
    await badge.click();
    await expect(badge).toHaveCount(0);
    await expect(company).toBeVisible();
    await expect(recovery).toHaveCount(1);
    await expect(failure).toHaveCount(0);
  });

  test("phones lead with the companies and fold country, sector and ownership under one counted control", async ({ page, isMobile }) => {
    test.skip(!isMobile, "The phone layout");
    await open(page);
    const first = page.getByRole("button", { name: /SYN01/ });
    const dock = page.getByRole("navigation", { name: "Quick navigation", exact: true });
    expect((await first.boundingBox())!.y).toBeLessThan((await dock.boundingBox())!.y);
    const above = page.getByRole("navigation", { name: "Underlying holding pages, above the list", exact: true });
    const below = page.getByRole("navigation", { name: "Underlying holding pages, below the list", exact: true });
    await expect(above).toBeVisible();
    await expect(below).toHaveCount(1);
    const country = page.getByRole("combobox", { name: "Filter country", exact: true });
    const toggle = page.getByRole("button", { name: /^Filters/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(country).toBeHidden();
    await expect(above.getByRole("button", { name: "First page", exact: true })).toBeDisabled();
    const next = above.getByRole("button", { name: "Next page", exact: true });
    await next.focus();
    await expect(next).toHaveCSS("outline-width", "2px");
    await next.press("Space");
    await expect(next).toBeFocused();
    await expect(above).toContainText("2 / 3");
    await above.getByRole("button", { name: "Last page", exact: true }).click();
    await expect(next).toBeDisabled();
    await below.getByRole("button", { name: "First page", exact: true }).click();
    await expect(above).toContainText("1 / 3");
    await next.click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await country.click();
    await page.getByRole("option", { name: "United States", exact: true }).click();
    // A filter returns to the first page and is counted on the control.
    await expect(above).toContainText("1 / 2");
    await expect(page.getByRole("button", { name: "Filters (1 active)", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "40 / 60" })).toBeVisible();
    expect((await page.getByRole("button", { name: "Clear filters", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await toggle.click();
    await expect(country).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "40 / 60" })).toBeVisible();
    // Clearing from the keyboard keeps focus on the filter control.
    await page.getByRole("button", { name: "Clear filters", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
    await expect(above).toContainText("1 / 3");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("new snapshots leave the company drawer and its filter in place", async ({ page, isMobile }) => {
    await page.clock.install();
    const state = { runId: "synthetic-first", brokerAsOf: "2026-11-04T15:00:00Z" };
    await open(page, "en", state);
    if (isMobile) await page.getByRole("button", { name: /^Filters/ }).click();
    const country = page.getByRole("combobox", { name: "Filter country" });
    await country.click();
    await page.getByRole("option", { name: "United Kingdom", exact: true }).click();
    await page.getByRole("button", { name: /SYN01/ }).first().click();
    const drawer = page.getByRole("dialog", { name: "Underlying exposure" });
    await expect(drawer).toContainText("Synthetic Holding 1");

    const freshness = page.locator(".mx-freshness").first();
    const first = await freshness.textContent();
    state.runId = "synthetic-second";
    state.brokerAsOf = "2026-11-04T15:10:00Z";
    await page.clock.fastForward(60_000);
    await expect(freshness).not.toHaveText(first!);
    await expect(drawer).toContainText("Synthetic Holding 1");
    await page.keyboard.press("Escape");
    await expect(country).toHaveValue("United Kingdom");
    await expect(page).toHaveURL(/holdings\?view=lookthrough$/);
  });

  test("wider screens keep every filter inline", async ({ page, isMobile }) => {
    test.skip(isMobile, "The desktop layout");
    await open(page);
    await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Filter country", exact: true }).click();
    await page.getByRole("option", { name: "United Kingdom", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "20 / 60" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Filter country", exact: true })).toHaveValue("All countries");
    await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
  });

  test("the exposure sheet requests and shows the quote basis only on touch", async ({ page, isMobile }) => {
    await open(page);
    const priceRequests: string[] = [];
    await page.route("**/api/backend/research/SYN01/prices*", (route) => {
      priceRequests.push(route.request().url());
      return route.fulfill({ json: {
        ticker: "SYN01",
        requestedInterval: "15m",
        actualInterval: "15m",
        currency: "USD",
        timezone: "America/New_York",
        points: [
          { date: "2026-11-03T16:00:00", close: 120 },
          { date: "2026-11-04T09:30:00", close: 122 },
          { date: "2026-11-04T10:00:00", close: 125 },
        ],
      } });
    });
    const holding = page.getByRole("button", { name: /SYN01/ }).first();
    if (isMobile) await holding.tap();
    else await holding.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Underlying exposure" });
    await expect(drawer.getByText("Total exposure", { exact: true })).toBeVisible();
    if (!isMobile) {
      // Keyboard activation opens the sheet without warming the hover preview's cache.
      const close = drawer.getByRole("button", { name: "Close underlying exposure" });
      await expect(close).toBeFocused();
      await expect(drawer).not.toContainText(/Market quote|Market close|\+4\.17%/);
      await close.press("Escape");
      await expect(drawer).toHaveCount(0);
      expect(priceRequests).toHaveLength(0);
      return;
    }
    await expect(drawer).toContainText("Market quote");
    await expect(drawer).toContainText("US$125.00");
    await expect(drawer).toContainText("+4.17%");
    await expect(drawer.locator('time[datetime="2026-11-04T10:00:00"]')).toBeVisible();
    expect(priceRequests).toHaveLength(1);
  });
});

for (const { height, title } of [
  { height: 568, title: "the dock covers none of the controls" },
  { height: 667, title: "the first company starts above the dock" },
] as const) {
  test.describe("look-through companies on a 320 × " + height + " phone", () => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
    test.use({ viewport: { width: 320, height } });

    for (const locale of ["zh", "en"] as const) {
      test(title + " (" + locale + ")", async ({ page, isMobile }) => {
        test.skip(!isMobile, "The phone layout");
        const zh = locale === "zh";
        await open(page, locale);
        const dock = (await page.getByRole("navigation", { name: zh ? "快捷导航" : "Quick navigation", exact: true }).boundingBox())!;
        if (height === 667) {
          expect((await page.getByRole("button", { name: /SYN01/ }).boundingBox())!.y).toBeLessThan(dock.y);
          return;
        }
        const sort = page.getByRole("combobox", { name: zh ? "敞口排序" : "Sort exposure", exact: true });
        const views = page.getByRole("group", { name: zh ? "公司视图" : "Company view", exact: true }).getByRole("button");
        // Phones use the compact label, so sort and the view switch share one row.
        await expect(views).toHaveText(zh ? ["排名", "组成"] : ["Rank", "Mix"], { useInnerText: true });
        const centre = async (control: typeof sort) => { const box = (await control.boundingBox())!; return box.y + box.height / 2; };
        expect(Math.abs((await centre(sort)) - (await centre(views.first())))).toBeLessThan(2);
        for (const control of [
          page.getByRole("searchbox", { name: zh ? "搜索底层持仓" : "Search underlying holdings", exact: true }),
          page.getByRole("button", { name: zh ? "筛选" : "Filters", exact: true }),
          sort,
          views.first(),
          views.last(),
        ]) {
          const box = (await control.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.y + box.height).toBeLessThanOrEqual(dock.y);
        }
      });
    }
  });
}

const largePositions = Array.from({ length: 5100 }, (_, i) => ({
  entityId: `large-${i + 1}`,
  ticker: `L${String(i + 1).padStart(4, "0")}`,
  name: i === 0 ? "Zeta Holding 1" : i === 5099 ? "Alpha Holding 5100" : `Synthetic Holding ${i + 1}`,
  country: i % 3 === 0 ? "United Kingdom" : "United States",
  valueGbp: 10000 - i,
  allocationPct: (10000 - i) / 25000000,
  directValueGbp: i % 2 ? 0 : 10000 - i,
  indirectValueGbp: i % 2 ? 10000 - i : 0,
  gics: { sectorName: i % 2 ? "Information Technology" : "Financials" },
  etfContributors: [],
}));

test.describe("look-through 5,100 companies", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  test("Show all keeps every row in one layout and preserves sorting, filtering and pagination", async ({ page, isMobile }) => {
    await open(page, "en", undefined, largePositions);

    if (isMobile) {
      await expect(page.locator(".mx-mobile-holdings")).toHaveCount(1);
      await expect(page.locator(".mx-desktop-holdings")).toHaveCount(0);
    } else {
      await expect(page.locator(".mx-desktop-holdings")).toHaveCount(1);
      await expect(page.locator(".mx-mobile-holdings")).toHaveCount(0);
    }

    const pager = page.getByLabel(
      isMobile ? "Underlying holding pages, below the list" : "Underlying holding pages",
      { exact: true },
    );
    await expect(pager).toContainText(isMobile ? "1 / 204" : "1 / 51");

    const footer = page.locator(".mx-exposure-paging").last();
    const expand = footer.getByRole("button", { name: "Show all 5,100", exact: true });
    const collapse = footer.getByRole("button", { name: "Show in pages", exact: true });
    const rowLocator = isMobile
      ? page.locator(".mx-mobile-holdings .mx-holding-mobile")
      : page.locator(".mx-desktop-holdings tbody tr");
    const firstButton = isMobile
      ? rowLocator.first().filter({ hasText: "L0001" })
      : rowLocator.first().getByRole("button", { name: /L0001/ });

    await expand.scrollIntoViewIfNeeded();
    await expect(firstButton).not.toBeInViewport();
    await expand.press("Enter");
    await expect(collapse).toBeFocused();
    await expect(firstButton).not.toBeInViewport();
    await expect(pager).toHaveCount(0);

    await expect(rowLocator).toHaveCount(5100);
    await firstButton.scrollIntoViewIfNeeded();
    await expect(firstButton).toBeInViewport();

    const lastButton = isMobile
      ? rowLocator.last().filter({ hasText: "L5100" })
      : rowLocator.last().getByRole("button", { name: /L5100/ });
    await lastButton.scrollIntoViewIfNeeded();
    await expect(lastButton).toBeInViewport();
    if (isMobile) await lastButton.tap();
    else await lastButton.click();
    const drawer = page.getByRole("dialog", { name: "Underlying exposure" });
    await expect(drawer).toContainText("Alpha Holding 5100");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("combobox", { name: "Sort exposure", exact: true }).click();
    await page.getByRole("option", { name: "Name A–Z", exact: true }).click();
    await expect(rowLocator.first()).toContainText("Alpha Holding 5100");

    const search = page.getByRole("searchbox", { name: "Search underlying holdings", exact: true });
    await search.fill("L2500");
    await expect(page.getByRole("status").filter({ hasText: "1 / 5,100" })).toBeVisible();
    await expect(page.getByRole("button", { name: /L2500/ })).toBeVisible();
    await page.getByRole("combobox", { name: "Sort exposure", exact: true }).click();
    await page.getByRole("option", { name: "Largest indirect", exact: true }).click();
    await expect(rowLocator).toHaveCount(1);
    await expect(rowLocator.first()).toContainText("L2500");

    await collapse.click();
    await expect(search).toHaveValue("L2500");
    await search.fill("");
    await expect(pager).toBeVisible();
    await expect(expand).toBeVisible();
    // Clearing the search remounts the footer, which fades in even with reduced motion.
    await expect(footer).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test("a refreshed snapshot preserves focus beyond the first page of expanded holdings", async ({ page, isMobile }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  await page.clock.install();
  const state = { runId: "synthetic-first", brokerAsOf: "2026-11-04T15:00:00Z" };
  const holdings = largePositions.slice(0, 120);
  await open(page, "en", state, holdings);

  await page.getByRole("button", { name: "Show all 120", exact: true }).click();
  const selector = isMobile ? ".mx-mobile-holdings .mx-holding-mobile" : ".mx-desktop-holdings tbody tr";
  const rows = page.locator(selector);
  await expect(rows).toHaveCount(120);
  const holding = page.getByRole("button", { name: /L0120/ });
  await holding.focus();
  await expect(holding).toBeFocused();

  holdings[0] = { ...holdings[0], name: "Refreshed Holding 1" };
  state.runId = "synthetic-second";
  state.brokerAsOf = "2026-11-04T15:10:00Z";
  await page.clock.fastForward(60_000);
  await expect(rows.first()).toContainText("Refreshed Holding 1");
  await expect(rows).toHaveCount(120);
  await expect(holding).toBeFocused();
});

test("printing immediately after Show all includes every batch and reopening yields again", async ({ page, isMobile }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");
  await open(page, "en", undefined, largePositions.slice(0, 120));

  // Keep the next batch pending until beforeprint so this covers smaller expanded lists too.
  await page.evaluate(() => {
    Object.defineProperty(window, "scheduler", {
      configurable: true,
      value: { yield: () => new Promise(() => {}) },
    });
  });
  const expand = page.getByRole("button", { name: "Show all 120", exact: true });
  await expand.click();
  const selector = isMobile ? ".mx-mobile-holdings .mx-holding-mobile" : ".mx-desktop-holdings tbody tr";
  const counts = await page.evaluate((rows) => {
    const before = document.querySelectorAll(rows).length;
    window.dispatchEvent(new Event("beforeprint"));
    return { before, onPrint: document.querySelectorAll(rows).length };
  }, selector);
  const firstPageSize = isMobile ? 25 : 100;
  expect(counts).toEqual({ before: firstPageSize, onPrint: 120 });

  // Emulate a paper width on the opposite side of the screen's layout breakpoint.
  const screenViewport = page.viewportSize()!;
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ ...screenViewport, width: isMobile ? 840 : 640 });
  const paper = await page.evaluate(() => ({
    printing: window.matchMedia("print").matches,
    narrow: window.matchMedia("(max-width: 767px)").matches,
  }));
  expect(paper).toEqual({ printing: true, narrow: !isMobile });
  const lastHolding = page.locator(selector).last();
  await expect(lastHolding).toContainText("L0120");
  await expect(lastHolding).toBeVisible();
  await page.setViewportSize(screenViewport);
  await page.emulateMedia({ media: "screen" });

  await page.getByRole("button", { name: "Show in pages", exact: true }).click();
  await expand.click();
  await expect(page.locator(selector)).toHaveCount(firstPageSize);
});
