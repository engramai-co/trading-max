import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { ResearchShell } from "../lib/types";

const searchName = /搜索页面或证券|Search pages or securities/;
async function openSearch(page: Page) {
  await page.getByRole("button", { name: searchName }).click();
  const input = page.getByRole("combobox", { name: searchName });
  await expect(input).toBeFocused();
  return input;
}

test.describe("workspace navigation refinements", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Use an isolated synthetic local service.");

  test.beforeEach(async ({ page, request }) => {
    const directory = await (await request.get("/api/backend/research/shell")).json() as ResearchShell;
    const sample = directory.instruments[0];
    await page.route("**/api/backend/research/shell", (route) => route.fulfill({ json: {
      ...directory, instruments: [...directory.instruments, { ...sample, ticker: "ARM", name: "Arm Holdings · Synthetic navigation test" }],
    } }));
  });

  for (const [query, href] of [
    ["ARM 技术面", "/research?ticker=ARM&view=technical"],
    ["BE DCF", "/research?ticker=BE&view=valuation"],
    ["ETF", "/holdings?view=lookthrough"],
    ["TWR", "/analytics?view=returns"],
  ]) {
    test(`search opens ${query} directly`, async ({ page }) => {
      await page.goto("/");
      const input = await openSearch(page);
      await input.fill(query);
      await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  }

  test("search has accessible keyboard selection, literal highlights and focus return", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByRole("button", { name: searchName });
    const input = await openSearch(page);
    await input.fill("BE");
    const selected = page.getByRole("option", { selected: true });
    await expect(selected).toContainText("BE");
    await expect(input).toHaveAttribute("aria-activedescendant", await selected.getAttribute("id") ?? "");
    await expect(selected.locator("mark").first()).toHaveText("BE");
    await page.keyboard.press("ArrowDown");
    await expect(input).toBeFocused();
    await expect(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("composition Enter does not navigate and an unknown ticker is not guessed", async ({ page }) => {
    await page.goto("/");
    const input = await openSearch(page);
    await input.fill("BE DCF");
    await expect(page.getByRole("option").first()).toContainText("BE");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await input.fill("UNKNOWN technical");
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option")).toContainText(/在持仓中搜索|Search holdings/);
    await input.fill("估值");
    await expect(page.getByRole("status").filter({ hasText: /加上证券代码|Include a ticker/ })).toBeVisible();
  });

  test("static deep links remain available when the directory fails", async ({ page }) => {
    await page.unroute("**/api/backend/research/shell");
    await page.route("**/api/backend/research/shell", (route) => route.fulfill({ status: 503, json: {} }));
    await page.goto("/");
    const input = await openSearch(page);
    await input.fill("TWR");
    await expect(page.getByRole("option").first()).toContainText("TWR");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/analytics\?view=returns$/);
  });

  test("recent views are session-only, bounded and clearable on both sizes", async ({ page }) => {
    await page.goto("/");
    let input = await openSearch(page);
    await input.fill("TWR");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/view=returns/);
    await openSearch(page);
    await expect(page.getByRole("option").first()).toContainText("TWR");
    await page.getByRole("button", { name: /清除最近访问|Clear recent/ }).click();
    await expect(page.locator(".mx-command-group").filter({ hasText: /最近访问|Recent/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.reload();
    input = await openSearch(page);
    await expect(input).toHaveValue("");
    await expect(page.getByRole("option").filter({ hasText: /组合总览|Overview/ })).toHaveCount(1);
    expect(await page.evaluate(() => Object.keys(localStorage).some((key) => /recent|navigation-history/.test(key)))).toBe(false);
  });

  test("search reuses a cached research directory without starting updates", async ({ page }) => {
    let directories = 0;
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/backend/research/shell")) directories++;
      if (request.url().includes("/api/backend/") && request.method() !== "GET") writes.push(request.url());
    });
    await page.goto("/research?ticker=BE");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator(".mx-research-page .mx-security-header")).toBeVisible();
    const loaded = directories;
    await openSearch(page);
    await expect(page.getByRole("option").filter({ hasText: "BE" })).not.toHaveCount(0);
    await page.keyboard.press("Escape");
    await openSearch(page);
    expect(directories).toBe(loaded);
    expect(writes).toEqual([]);
  });

  test("desktop search preserves separate management windows", async ({ page }) => {
    await page.goto("/desktop");
    const input = await openSearch(page);
    await input.fill("settings");
    const popup = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const settings = await popup;
    await expect(settings).toHaveURL(/\/desktop\/settings$/);
    await expect(page).toHaveURL(/\/desktop$/);
    await settings.close();
  });

  test("mobile navigation uses legible short labels without overflow", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.goto("/");
    const dock = page.locator(".mx-mobile-dock");
    await expect(dock).toBeVisible();
    await expect(dock.getByRole("link")).toHaveText(["总览", "持仓", "收益", "研究", "复盘"]);
    expect(await dock.getByRole("link").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    expect(await dock.getByRole("link").evaluateAll((links) => links.every((link) => link.getBoundingClientRect().height >= 56))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dock.getByRole("link", { name: "持仓", exact: true }).tap();
    await expect(dock.getByRole("link", { name: "持仓", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(dock.locator(".mx-nav-group")).toHaveAttribute("data-motion", "pointer");
    await expect(dock.getByRole("link", { name: "持仓", exact: true }).locator(".mx-nav-icon-fill")).toHaveCSS("opacity", "1");
    await expect.poll(() => dock.locator('[aria-current="page"]').evaluate((active) => {
      const indicator = active.parentElement!.querySelector(".mx-nav-indicator")!;
      const a = active.getBoundingClientRect();
      const b = indicator.getBoundingClientRect();
      return Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1;
    })).toBe(true);
  });

  for (const size of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
    test(`mobile tools and bottom menu fit ${size.width}×${size.height} in English`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile");
      await page.setViewportSize(size);
      await page.goto("/");
      await page.getByRole("button", { name: "Switch to English" }).tap();
      const tools = page.locator(".mx-topbar button");
      expect(await tools.evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44))).toBe(true);
      await expect(page.locator(".mx-mobile-dock")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const opener = page.getByRole("button", { name: "Open navigation", exact: true });
      await opener.tap();
      const menu = page.locator(".mx-mobile-menu");
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.y).toBeGreaterThan(0);
      expect(Math.abs(box.y + box.height - size.height)).toBeLessThan(1);
      await expect(menu.getByRole("link")).toHaveCount(8);
      expect((await new AxeBuilder({ page }).include(".mx-mobile-menu").analyze()).violations).toEqual([]);
      await menu.getByRole("button", { name: "Close navigation", exact: true }).tap();
      await expect(menu).toHaveCount(0);
      const input = await openSearch(page);
      await expect(input).toHaveCSS("font-size", "16px");
      await input.fill("TWR");
      await page.getByRole("option").first().tap();
      await expect(page).toHaveURL(/view=returns$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  }

  test("mobile dock stays aligned after rotation, reduced-motion taps and history", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const dock = page.locator(".mx-mobile-dock");
    await dock.getByRole("link", { name: "研究", exact: true }).tap();
    await expect(page).toHaveURL(/\/research$/);
    await expect(dock.locator(".mx-nav-group")).not.toHaveAttribute("data-motion", "pointer");
    expect(await dock.locator(".mx-nav-indicator").evaluate((indicator) => indicator.getAnimations().length)).toBe(0);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(dock).toBeVisible();
    await expect.poll(() => dock.locator('[aria-current="page"]').evaluate((active) => {
      const indicator = active.parentElement!.querySelector(".mx-nav-indicator")!;
      return Math.abs(active.getBoundingClientRect().left - indicator.getBoundingClientRect().left) < 1;
    })).toBe(true);
    await page.goBack();
    await expect(dock.getByRole("link", { name: "总览", exact: true })).toHaveAttribute("aria-current", "page");
    await expect.poll(() => dock.locator('[aria-current="page"]').evaluate((active) => {
      const indicator = active.parentElement!.querySelector(".mx-nav-indicator")!;
      return Math.abs(active.getBoundingClientRect().left - indicator.getBoundingClientRect().left) < 1;
    })).toBe(true);
  });

  test("desktop rail keeps five adjacent, named icons with hover and focus hints", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/");
    const rail = page.locator(".mx-sidebar");
    await expect(rail.locator("[data-search-trigger]")).toHaveCount(0);
    await expect(page.locator("[data-search-trigger]")).toHaveCount(1);
    await expect(page.locator(".mx-topbar").getByRole("button", { name: searchName })).toBeVisible();
    const nav = rail.getByRole("navigation", { name: /主导航|Primary navigation/ });
    await expect(nav.locator(".mx-nav-group")).toHaveCount(1);
    await expect(nav.getByRole("link")).toHaveCount(5);
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(80);
    expect(await nav.innerText()).toBe("");
    expect(await nav.getByRole("link").evaluateAll((links) => links.every((link) => link.getAttribute("aria-label") && link.getBoundingClientRect().height >= 44))).toBe(true);
    const research = nav.getByRole("link", { name: /证券研究|Research/ });
    const researchShape = await research.locator(".mx-nav-icon-outline path").first().getAttribute("d");
    expect(researchShape).not.toBe(await page.locator(".mx-topbar-search path").first().getAttribute("d"));
    expect(researchShape).not.toBe(await nav.getByRole("link", { name: /收益与风险|Performance/ }).locator(".mx-nav-icon-outline path").first().getAttribute("d"));
    await research.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/证券研究|Research/);
    await page.mouse.move(300, 80);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await research.focus();
    await expect(page.getByRole("tooltip")).toHaveText(/证券研究|Research/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(research).toBeFocused();
  });

  test("selection fills the icon across the former groups, without keyboard motion", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/analytics");
    const nav = page.getByRole("navigation", { name: /主导航|Primary navigation/ });
    const research = nav.getByRole("link", { name: /证券研究|Research/ });
    await research.click();
    await expect(research).toHaveAttribute("aria-current", "page");
    await expect(nav.locator(".mx-nav-group")).toHaveAttribute("data-motion", "pointer");
    await expect(research.locator(".mx-nav-icon-fill")).toHaveCSS("opacity", "1");
    await expect(research.locator(".mx-nav-icon-outline")).toHaveCSS("opacity", "0");
    const review = nav.getByRole("link", { name: /投资复盘|Review/ });
    await review.focus();
    await review.press("Enter");
    await expect(review).toHaveAttribute("aria-current", "page");
    await expect(nav.locator(".mx-nav-group")).not.toHaveAttribute("data-motion", "pointer");
    expect(await nav.locator(".mx-nav-icon > svg").evaluateAll((icons) => icons.reduce((count, icon) => count + icon.getAnimations().length, 0))).toBe(0);
    await expect(review.locator(".mx-nav-icon-fill")).toHaveCSS("opacity", "1");
  });

  test("reduced-motion and back navigation leave the indicator at the active row", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: /主导航|Primary navigation/ });
    await nav.getByRole("link", { name: /持仓与穿透|Holdings/ }).click();
    await expect(page).toHaveURL(/\/holdings$/);
    expect(await page.locator(".mx-sidebar .mx-nav-indicator").evaluateAll((items) => items.reduce((count, item) => count + item.getAnimations().length, 0))).toBe(0);
    expect(await nav.locator(".mx-nav-icon > svg").evaluateAll((icons) => icons.reduce((count, icon) => count + icon.getAnimations().length, 0))).toBe(0);
    await page.goBack();
    await expect(nav.getByRole("link", { name: /组合总览|Overview/ })).toHaveAttribute("aria-current", "page");
    const aligned = await nav.locator('[aria-current="page"]').evaluate((active) => {
      const indicator = active.parentElement!.querySelector(".mx-nav-indicator")!;
      return Math.abs(active.getBoundingClientRect().top - indicator.getBoundingClientRect().top) < 1;
    });
    expect(aligned).toBe(true);
  });
});
