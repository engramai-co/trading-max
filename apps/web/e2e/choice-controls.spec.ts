import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires the seeded synthetic preview.");

test.beforeEach(async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
});

async function open(page: Page, path: string, locale = "en") {
  await page.addInitScript((language) => localStorage.setItem("trading_max-locale", language), locale);
  await page.goto(path);
}

test("keyboard explores Returns before activating a named panel", async ({ page, browserName }) => {
  await open(page, "/analytics?view=returns");
  const tabs = page.getByRole("tablist", { name: "Performance perspective" });
  const selected = tabs.getByRole("tab", { name: "Return comparison", selected: true });
  const risk = tabs.getByRole("tab", { name: "Risk profile" });
  const panel = page.getByRole("tabpanel", { name: "Return comparison" });
  await expect(selected).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
  if (browserName === "chromium") {
    await page.emulateMedia({ forcedColors: "active" });
    const underline = await selected.locator(".mx-tab-label").evaluate((label) =>
      getComputedStyle(label, "::after").borderBlockEndWidth);
    expect(underline).toBe("2px");
  }
  const historyLength = await page.evaluate(() => history.length);
  await selected.press("End");
  await expect(risk).toBeFocused();
  await expect(page).toHaveURL(/view=returns/);
  await expect(panel).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tabpanel", { name: "Risk profile" })).toBeVisible();
  await expect(risk).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/view=risk/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await tabs.getByRole("tab", { name: "Return comparison" }).click();
  await expect(selected).toBeVisible();
});

test("phone Returns ranges stay reachable through More", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Phone range disclosure.");
  await open(page, "/analytics?range=3M");
  const ranges = page.getByRole("group", { name: "Performance range", exact: true });
  const more = page.getByRole("button", { name: "More periods", exact: true });
  await expect(ranges.getByRole("button")).toHaveCount(3);
  await more.press("Enter");
  const menu = page.getByRole("menu", { name: "More periods", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(more).toBeFocused();
  await more.click();
  await menu.getByRole("menuitem", { name: "1D", exact: true }).click();
  await expect(page.getByRole("button", { name: "More periods · 1D" })).toBeVisible();
  await expect(page).toHaveURL(/range=1D/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("Holdings exposes named panels at both levels", async ({ page }) => {
  await open(page, "/holdings");
  const views = page.getByRole("tablist", { name: "Holdings view" });
  const through = views.getByRole("tab", { name: "Look-through", exact: true });
  const directPanel = page.getByRole("tabpanel", { name: "Direct holdings", exact: true });
  await expect(directPanel).toBeVisible();
  await through.click();
  const throughPanel = page.getByRole("tabpanel", { name: "Look-through", exact: true });
  await expect(throughPanel).toBeVisible();
  const dimensions = throughPanel.getByRole("tablist", { name: "Exposure dimension" });
  const dimension = dimensions.getByRole("tab", { selected: true });
  await expect(dimension).toHaveAttribute("aria-controls", /.+/);
  const nested = throughPanel.getByRole("tabpanel");
  await expect(nested).toHaveAttribute("aria-labelledby", (await dimension.getAttribute("id"))!);
});

test("Settings keeps the active panel while keyboard focus moves", async ({ page }) => {
  await open(page, "/settings?tab=preferences");
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  const selected = tabs.getByRole("tab", { name: "Preferences", exact: true });
  const automation = tabs.getByRole("tab", { name: "Update schedule", exact: true });
  await selected.press("ArrowLeft");
  await expect(automation).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Preferences", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/tab=preferences/);
  await page.keyboard.press("Space");
  const schedule = page.getByRole("tabpanel", { name: "Update schedule", exact: true });
  await expect(schedule).toBeVisible();
  await expect(page).toHaveURL(/tab=automation/);
  await page.keyboard.press("Tab");
  await expect(schedule).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(automation).toBeFocused();

  const models = tabs.getByRole("tab", { name: "Model connections", exact: true });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(models).toBeFocused();
  await expect(schedule).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tabpanel", { name: "Model connections", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const relationships = await tabs.getByRole("tab").evaluateAll((items) => items.map((tab) => {
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
    return panel?.getAttribute("aria-labelledby") === tab.id;
  }));
  expect(relationships).toEqual([true, true, true, true, true]);
});

test("the Chinese exposure tabs fit at 390 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/holdings?view=lookthrough", "zh");
  const tabs = page.getByRole("tablist", { name: "穿透维度" });
  await expect(tabs.getByRole("tab", { name: "来源与覆盖" })).toBeVisible();
  await expect.poll(() => tabs.evaluate((list) => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(1);
});

test("sliding indicators animate through mid-flight reselections and snap in reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page, "/settings?tab=accounts");
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  await expect(tabs.locator("> .mx-indicator")).toBeVisible();

  const result = await tabs.evaluate(async (list) => {
    const items = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const indicator = list.querySelector<HTMLElement>(":scope > .mx-indicator")!;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    // Wait two frames so initial placement and ResizeObserver have settled.
    await nextFrame();
    await nextFrame();
    const initialLeft = indicator.getBoundingClientRect().left;

    // First selection: the first-frame ResizeObserver must not cancel the 180ms slide.
    items[4].click();
    await nextFrame();
    const firstAnims = indicator.getAnimations();
    const firstRunning = firstAnims.some((animation) => animation.playState === "running");
    const firstKeyframes = firstAnims[0]?.effect instanceof KeyframeEffect ? firstAnims[0].effect.getKeyframes() : [];

    // Second selection during the active slide: continues smoothly to the new target.
    items[3].click();
    await nextFrame();
    const secondAnims = indicator.getAnimations();
    const secondRunning = secondAnims.some((animation) => animation.playState === "running");
    const secondKeyframes = secondAnims[0]?.effect instanceof KeyframeEffect ? secondAnims[0].effect.getKeyframes() : [];

    await Promise.all(secondAnims.map((animation) => animation.finished.catch(() => undefined)));
    const settled = indicator.getBoundingClientRect();
    const target = items[3].getBoundingClientRect();
    return {
      initialLeft,
      firstCount: firstAnims.length,
      firstRunning,
      firstFrom: firstKeyframes[0]?.transform,
      secondCount: secondAnims.length,
      secondRunning,
      secondFrom: secondKeyframes[0]?.transform,
      secondTo: secondKeyframes.at(-1)?.transform,
      leftDiff: Math.abs(settled.left - target.left),
      widthDiff: Math.abs(settled.width - target.width),
    };
  });

  expect(result.firstCount).toBe(1);
  expect(result.firstRunning).toBe(true);
  expect(result.secondCount).toBe(1);
  expect(result.secondRunning).toBe(true);
  expect(result.secondFrom).not.toBe(result.firstFrom);
  expect(result.secondFrom).not.toBe(result.secondTo);
  expect(result.leftDiff).toBeLessThan(1);
  expect(result.widthDiff).toBeLessThan(1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const accounts = tabs.getByRole("tab", { name: "Accounts & data", exact: true });
  await accounts.click();
  const reduced = await tabs.evaluate((list) => {
    const indicator = list.querySelector<HTMLElement>(":scope > .mx-indicator")!;
    const active = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
    const a = active.getBoundingClientRect();
    const b = indicator.getBoundingClientRect();
    return {
      animations: indicator.getAnimations().length,
      leftDiff: Math.abs(a.left - b.left),
      widthDiff: Math.abs(a.width - b.width),
    };
  });
  expect(reduced.animations).toBe(0);
  expect(reduced.leftDiff).toBeLessThan(1);
  expect(reduced.widthDiff).toBeLessThan(1);
});
