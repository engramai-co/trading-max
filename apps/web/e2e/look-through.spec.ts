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

async function open(page: Page, locale: "zh" | "en" = "en") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
  // No write leaves the page.
  await page.route("**/*", (route) => route.request().method() === "GET" ? route.fallback() : route.abort());
  // Every backend request is answered here, so no real service is reached.
  await page.route("**/api/backend/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dashboard/lens/holdings-lookthrough")) return route.fulfill({ json: {
      runId: "synthetic-lookthrough", lookthrough: {
        available: true, positions, underlyingCount: positions.length, sources: [],
        countryAllocation: [], industryAllocation: [], gicsSubIndustryAllocation: [],
        lookthroughCoveragePct: 1, gicsCoveragePct: 1, etfValueGbp: 30000,
      },
    } });
    if (path.endsWith("/analysis")) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: path.endsWith("/profile") ? { accountLabels: {} } : {} });
  });
  await page.route("**/api/company-logo/**", (route) => route.fulfill({ status: 204 }));
  await page.goto("/holdings?view=lookthrough");
  await expect(page.getByRole("button", { name: /SYN01/ }).first()).toBeVisible();
}

test.describe("look-through companies", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an isolated local web build.");

  test("phones lead with the companies and fold country, sector and ownership under one counted control", async ({ page, isMobile }) => {
    test.skip(!isMobile, "The phone layout");
    await open(page);
    const first = page.getByRole("button", { name: /SYN01/ });
    const dock = page.getByRole("navigation", { name: "Quick navigation", exact: true });
    expect((await first.boundingBox())!.y).toBeLessThan((await dock.boundingBox())!.y);
    const above = page.getByRole("navigation", { name: "Underlying asset pages, above the list", exact: true });
    const below = page.getByRole("navigation", { name: "Underlying asset pages, below the list", exact: true });
    await expect(above).toBeVisible();
    await expect(below).toHaveCount(1);
    const country = page.getByRole("combobox", { name: "Filter country", exact: true });
    const toggle = page.getByRole("button", { name: /^Filters/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(country).toBeHidden();
    await above.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(above).toContainText("2 / 3");
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
          page.getByRole("textbox", { name: zh ? "搜索底层资产" : "Search underlying assets", exact: true }),
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
