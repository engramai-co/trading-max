import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test.describe("published event source freshness", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Use an isolated local preview.");
  for (const locale of ["en", "zh"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${locale} ${theme} keeps source failures beside their last observation`, async ({ page, isMobile }) => {
        await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript((language) => localStorage.setItem("trading_max-locale", language), locale);
        const failures = theme === "light" ? 1 : 2;
        const clock = "2026-11-18T08:00:00Z";
        const worker = { healthy: true };
        const queue = { queued: 0, running: 0, succeeded: 1, failed: 0, interrupted: 0 };
        await page.route("**/api/backend/health/details", (route) => route.fulfill({ json: {
          checkedAt: clock,
          health: { status: "ok", latestRunId: "fixture", worker, queue, artifactAgeSeconds: 120,
            eventRefreshes: [
              { kind: "news", checkedAt: clock, asOf: clock, failedSources: 0 },
              { kind: "macro", checkedAt: clock, asOf: "2026-11-17T08:00:00Z", failedSources: failures },
            ] },
          readiness: { status: "ready", latestRunId: "fixture", worker, queue }, refresh: {}, jobs: [], errors: [],
        } }));
        await page.goto("/health");
        const summary = page.locator("summary", { hasText: locale === "en" ? "News and calendar freshness" : "新闻与日历数据时间" });
        const block = page.locator("details").filter({ has: summary });
        await expect(block.getByText(locale === "en" ? (failures === 1 ? "1 source refresh failed" : "2 source refreshes failed") : `${failures} 个来源更新失败`)).toBeVisible();
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(block).not.toHaveAttribute("open", "");
        await page.keyboard.press("Enter");
        await expect(block.getByText(locale === "en" ? "Security news" : "证券新闻", { exact: true })).toBeVisible();
        expect((await new AxeBuilder({ page }).include("details:has(summary:focus)").analyze()).violations).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.EVENT_QA_SHOTS) {
          await mkdir(process.env.EVENT_QA_SHOTS, { recursive: true });
          await summary.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${process.env.EVENT_QA_SHOTS}/${isMobile ? "mobile" : "desktop"}-${locale}-${theme}.png`, animations: "disabled" });
        }
      });
    }
  }
});
