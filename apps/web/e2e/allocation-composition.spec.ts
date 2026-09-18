import { expect, test } from "@playwright/test";

const countries = [
  { country: "United States", allocationPct: 0.70, valueGbp: 7000 },
  { country: "United Kingdom", allocationPct: 0.10, valueGbp: 1000 },
  ...Array.from({ length: 12 }, (_, i) => ({ country: `Region ${i + 1}`, allocationPct: 0.20 / 12, valueGbp: 2000 / 12 })),
];

test.describe("allocation composition", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  test.beforeEach(async ({ page }) => {
    // Hit-test the final ring geometry rather than its entrance animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/dashboard/lens/holdings-lookthrough", (route) => route.fulfill({ json: {
      runId: "synthetic-allocation",
      lookthrough: {
        available: true, positions: [], sources: [], underlyingCount: 14,
        countryAllocation: countries,
        industryAllocation: [{ industry: "Technology", allocationPct: 0.8, valueGbp: 8000 }, { industry: "Consumer", allocationPct: 0.2, valueGbp: 2000 }],
        gicsSubIndustryAllocation: [],
        lookthroughCoveragePct: 1, gicsCoveragePct: 1, etfValueGbp: 10000,
      },
    } }));
    await page.goto("/holdings?view=lookthrough");
    await page.getByRole("tab", { name: "Countries", exact: true }).click();
    await page.getByRole("group", { name: "Allocation chart" }).getByRole("button", { name: "Composition", exact: true }).click();
  });

  test("clicking or tapping a slice fixes accurate details, including small and grouped categories", async ({ page, isMobile }) => {
    const chart = page.getByRole("group", { name: "Allocation composition", exact: true });
    const details = page.getByRole("region", { name: "Selected category details" });
    const choices = page.getByRole("group", { name: "Choose allocation category" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    await choices.getByRole("button", { name: "United Kingdom", exact: false }).click();
    await expect(details).toContainText("£1,000.00");
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    // The right-hand ring midpoint is within the 70% US slice. Selection
    // must originate from the chart itself, not merely the companion list.
    const x = box.x + box.width / 2 + Math.min(box.width, box.height) * 0.35;
    const y = box.y + box.height / 2;
    if (isMobile) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await expect(details).toContainText("United States");
    await expect(details).toContainText("£7,000.00");
    await expect(details).toContainText("70.0%");
    await page.getByRole("heading", { name: "Look-through details", exact: true }).click();
    await expect(details).toContainText("United States");
    await choices.getByRole("button", { name: "Other categories", exact: false }).click();
    await expect(details).toContainText("£333.33");
    await expect(details).toContainText("3.3%");
    await expect(details).toContainText("Region 11");
    await expect(details).toContainText("Region 12");
    await page.getByRole("tab", { name: "Industries", exact: true }).click();
    await expect(details).toContainText("Technology");
    await expect(details).not.toContainText("United States");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("keyboard navigation changes the persistent details and selection", async ({ page }) => {
    const chart = page.getByRole("group", { name: "Allocation composition", exact: true });
    const details = page.getByRole("region", { name: "Selected category details" });
    await chart.focus();
    await chart.press("ArrowRight");
    await expect(details).toContainText("United Kingdom");
    await chart.press("End");
    await expect(details).toContainText("Other categories");
    await chart.press("Home");
    await expect(details).toContainText("United States");
    await expect(page.getByRole("button", { name: "United States 70.0%" })).toHaveAttribute("aria-pressed", "true");
  });
});
