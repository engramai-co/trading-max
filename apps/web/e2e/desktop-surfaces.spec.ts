import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import type { HealthDetails, RefreshJob } from "../lib/types";

async function capture(page: Page, name: string) {
  if (!process.env.DESKTOP_QA_EVIDENCE) return;
  await mkdir(process.env.DESKTOP_QA_EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${process.env.DESKTOP_QA_EVIDENCE}/desktop-page-${name}.png`, animations: "disabled" });
}

test.describe("desktop surfaces", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Use an isolated synthetic local service.");

  test("the investment workspace keeps reports together and opens management separately", async ({ page }) => {
    await page.goto("/desktop");
    await expect(page.locator(".mx-desktop-app")).toBeVisible();
    await expect(page.locator(".mx-desktop-tools")).toBeVisible();
    expect((await page.locator(".mx-sidebar").boundingBox())!.width).toBeLessThanOrEqual(80);
    await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
    await capture(page, "workspace");
    await expect(page.locator('.mx-desktop-tools a[href="/desktop/settings"]')).toHaveAttribute("target", "_blank");
    await expect(page.locator('.mx-desktop-tools a[href="/desktop/activity"]')).toHaveAttribute("target", "_blank");
    const holdings = page.getByRole("navigation", { name: /主导航|Primary navigation/ }).getByRole("link", { name: /持仓与穿透|Holdings/ });
    await expect(holdings).toHaveAttribute("href", "/desktop/holdings");
    await holdings.click();
    await expect(page).toHaveURL(/\/desktop\/holdings/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  for (const route of ["settings", "activity", "imports"]) {
    test(`${route} has focused, accessible controls without the investment sidebar`, async ({ page }) => {
      await page.goto("/desktop/" + route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
      await expect(page.locator(".mx-sidebar")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await capture(page, route);
    });
  }

  test("settings reuses the broker validation gate and separates imports", async ({ page }) => {
    await page.goto("/desktop/settings");
    await expect(page.getByRole("heading", { name: /CFD 历史账本|CFD history ledger/ })).toHaveCount(0);
    await page.getByRole("button", { name: /连接账户|Connect$/, exact: false }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /保存连接|Save connection/ })).toBeDisabled();
    await dialog.getByLabel(/^API Key ID/).fill("synthetic-test-id");
    await dialog.getByLabel(/^API Secret/).fill("synthetic-test-secret");
    await expect(dialog.getByRole("button", { name: /保存连接|Save connection/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /个人偏好|Preferences/ }).click();
    await expect(page).toHaveURL(/\/desktop\/settings\?tab=preferences/);
  });

  test("the isolated demo makes import restrictions visible before choosing a file", async ({ page }) => {
    await page.goto("/desktop/imports");
    await expect(page.getByText(/这是只读演示|This demonstration is read-only/)).toBeVisible();
    await expect(page.getByRole("button", { name: /CFD 活动 CSV 文件|CFD activity CSV file/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /导入账本|Import ledger/ })).toBeDisabled();
    await page.goto("/desktop/activity");
    await page.getByRole("button", { name: /查看服务详情|Service details/, exact: true }).click();
    await expect(page.getByRole("button", { name: /开始更新|Start update/ })).toBeDisabled();
  });

  test("an older schedule failure remains visible after recent live successes", async ({ page, request }) => {
    const data = await (await request.get("/api/backend/health/details")).json() as HealthDetails;
    const failed: RefreshJob = { jobId: "synthetic-failed-history", scope: "accounts", status: "failed", trigger: "nightly", createdAt: "2026-09-28T10:00:00Z", startedAt: "2026-09-28T10:00:00Z", finishedAt: "2026-09-28T10:01:00Z", scheduledFor: null, snapshotRunId: null, returnCode: 1, error: "Synthetic history conflict", skipSync: false, tickers: [], stages: [] };
    data.jobs = [{ ...failed, jobId: "synthetic-live-success", scope: "live", status: "succeeded", error: null, createdAt: "2026-09-29T10:00:00Z" }];
    if (data.refresh) { data.refresh.latestFullJob = failed; data.refresh.latestJob = data.jobs[0]; }
    await page.route("**/api/backend/health/details", (route) => route.fulfill({ json: data }));
    await page.goto("/desktop/activity");
    await page.getByRole("button", { name: /查看原因|View issue/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Synthetic history conflict");
    await expect(page.getByRole("dialog")).toContainText(/没有留下阶段记录|No stage details were recorded/);
    await expect(page.getByRole("dialog")).not.toContainText(/任务已排队|The task is queued/);
    await capture(page, "activity-error");
    await page.getByRole("button", { name: /使用相同范围重新准备更新|Prepare another update with this scope/ }).click();
    await expect(page.locator(".mx-activity-controls")).toHaveAttribute("open", "");
    await expect(page.getByRole("combobox", { name: /更新范围|Update scope/ })).toHaveValue(/账户与流水|Accounts & history/);
  });

  test("synthetic CSV import handles invalid files, duplicates, and the next update step", async ({ page }) => {
    test.skip(!process.env.DESKTOP_IMPORT_QA_URL, "Requires an isolated empty workspace with no broker credentials.");
    await page.goto(process.env.DESKTOP_IMPORT_QA_URL + "/desktop/imports");
    const input = page.locator('input[type="file"]');
    await input.setInputFiles({ name: "invalid.csv", mimeType: "text/csv", buffer: Buffer.from("invalid\nrow\n") });
    await page.getByRole("button", { name: /导入账本|Import ledger/ }).click();
    await expect(page.getByText(/导入未完成|Import failed/)).toBeVisible();
    const csv = "Record Type,Date (UTC),Account currency,Transaction ID,Transaction type,Amount (account currency),Info\nTransaction,2026-01-01T00:00:00Z,GBP,synthetic-desktop-qa,Deposit,10,\n";
    const file = { name: "synthetic-desktop-qa.csv", mimeType: "text/csv", buffer: Buffer.from(csv) };
    await input.setInputFiles(file);
    await page.getByRole("button", { name: /导入账本|Import ledger/ }).click();
    await expect(page.getByRole("link", { name: /更新 CFD 复盘|Update CFD review/ })).toHaveAttribute("href", "/desktop/activity?scope=cfd");
    await input.setInputFiles(file);
    await page.getByRole("button", { name: /导入账本|Import ledger/ }).click();
    await expect(page.getByText(/这个文件已导入|This file was already imported/)).toBeVisible();
    await capture(page, "import-success");
    await page.goto(process.env.DESKTOP_IMPORT_QA_URL + "/desktop/activity?scope=cfd");
    await expect(page.locator(".mx-activity-controls")).toHaveAttribute("open", "");
    await expect(page.getByRole("link", { name: /继续设置账户|Continue account setup/ })).toBeVisible();
    // A ready workspace can prepare CFD recomputation; an empty workspace must
    // retain the first-sync gate instead of manufacturing account NAV history.
    await page.goto("/desktop/activity?scope=cfd");
    await expect(page.getByRole("combobox", { name: /更新范围|Update scope/ })).toHaveValue(/CFD/);
  });
});

test.describe("unchanged browser presentation", () => {
  test.skip(!process.env.DESKTOP_BASELINE_URL || !process.env.PLAYWRIGHT_BASE_URL, "Supply the previous release and candidate synthetic web servers.");
  for (const path of ["/", "/holdings", "/analytics", "/research", "/review", "/settings", "/health"]) {
    test(`${path} preserves browser navigation and layout`, async ({ browser, request }, info) => {
      const responses = new Map<string, { status: number; body: string }>();
      const shots: Buffer[] = [];
      const structures: unknown[] = [];
      for (const base of [process.env.DESKTOP_BASELINE_URL!, process.env.PLAYWRIGHT_BASE_URL!]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", locale: "zh-CN", reducedMotion: "reduce" });
        await page.clock.setFixedTime(new Date("2026-09-29T00:00:00Z"));
        await page.route("**/api/backend/**", async (route) => {
          const url = new URL(route.request().url());
          const key = url.pathname + url.search;
          if (!responses.has(key)) {
            const response = await request.get(process.env.DESKTOP_BASELINE_URL + key);
            responses.set(key, { status: response.status(), body: await response.text() });
          }
          await route.fulfill({ ...responses.get(key)!, contentType: "application/json" });
        });
        await page.goto(base + path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
        await expect(page.locator(".mx-desktop-tools")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        structures.push(await page.locator(".mx-sidebar a, .mx-topbar, .mx-page-heading, .mx-tabs, .mx-panel").evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { tag: node.tagName, href: node.getAttribute("href"), x: r.x, y: r.y, width: r.width, height: r.height }; })));
        // The chart container is present before ECharts loads its canvas. Mask
        // that stable boundary so lazy chart creation cannot race the capture.
        shots.push(await page.screenshot({ animations: "disabled", fullPage: false, mask: [page.locator(".mx-freshness"), page.locator(".mx-plot"), page.locator(".mx-company-logo")] }));
        await page.close();
      }
      if (process.env.DESKTOP_QA_EVIDENCE) {
        await mkdir(process.env.DESKTOP_QA_EVIDENCE, { recursive: true });
        const name = path.slice(1) || "overview";
        for (const [index, buffer] of shots.entries()) await writeFile(`${process.env.DESKTOP_QA_EVIDENCE}/browser-${name}-${index ? "after" : "before"}.png`, buffer);
      }
      await info.attach("browser-layout-comparison", { body: JSON.stringify(structures), contentType: "application/json" });
      expect(structures[1]).toEqual(structures[0]);
      expect(shots[1].equals(shots[0])).toBe(true);
    });
  }
});
