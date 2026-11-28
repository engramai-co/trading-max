import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { ResearchShell } from "../lib/types";

const searchName = /^(搜索|Search)$/;
async function openSearch(page: Page) {
  // The workspace search lives in the top bar, also on Research.
  await page.getByRole("banner").getByRole("button", { name: searchName }).click();
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
    const account = page.getByRole("combobox", { name: /组合账户|Portfolio account/ });
    await account.focus();
    await expect(account).toHaveCSS("outline-width", "2px");
    const trigger = page.getByRole("button", { name: searchName });
    const input = await openSearch(page);
    await input.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(input).toBeFocused();
    await expect(input.locator("..")).toHaveCSS("outline-width", "2px");
    await input.fill("BE");
    const selected = page.getByRole("option", { selected: true });
    await expect(selected).toContainText("BE");
    await expect(input).toHaveAttribute("aria-activedescendant", await selected.getAttribute("id") ?? "");
    await expect(selected.locator("mark").first()).toHaveText("BE");
    await page.keyboard.press("ArrowDown");
    await expect(input).toBeFocused();
    await expect(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    // Measure contrast only after the dialog's entry fade has finished.
    await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("paused directory reads announce offline and resume without moving search focus", async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/indices/catalog", (route) => route.fulfill({ json: [] }));
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("button", { name: searchName })).toBeEnabled();
    await context.setOffline(true);
    try {
      const input = await openSearch(page);
      const dialog = page.getByRole("dialog", { name: "Search" });
      await expect(dialog.getByRole("status").filter({ hasText: "You’re offline." })).toHaveCount(1);
      await expect(dialog.getByText("Loading research list…")).toHaveCount(0);
      await input.fill("Holdings");
      await expect(dialog.getByRole("option").first()).toContainText("Holdings");
      await context.setOffline(false);
      await expect(dialog.getByRole("status").filter({ hasText: "Research list available." })).toHaveCount(1);
      await expect(input).toBeFocused();
      await input.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("banner").getByRole("button", { name: searchName })).toBeFocused();
    } finally {
      await context.setOffline(false);
    }
  });

  test("a failed index catalog keeps page commands and delays a definitive search result", async ({ page }) => {
    let failing = true;
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.route("**/api/backend/indices/catalog", (route) => route.fulfill(failing
      ? { status: 503, json: {} } : { json: [] }));
    await page.goto("/");
    const input = await openSearch(page);
    const dialog = page.getByRole("dialog", { name: "Search" });
    await expect(dialog.getByRole("status").filter({ hasText: "Index search unavailable." })).toHaveCount(1);
    await input.fill("Holdings");
    await expect(dialog.getByRole("option").first()).toContainText("Holdings");
    await input.fill("Z");
    await expect(dialog.getByText(/No results for/)).toHaveCount(0);
    await expect(dialog.getByText("Research list available.")).toHaveCount(0);
    failing = false;
    await dialog.getByRole("button", { name: "Retry" }).click();
    await expect(dialog.getByRole("status").filter({ hasText: "Research list available." })).toHaveCount(1);
    await expect(dialog.getByText(/No results for/)).toBeVisible();
  });

  test("composition Enter does not navigate and an unknown ticker is not guessed", async ({ page }) => {
    await page.goto("/");
    const input = await openSearch(page);
    await input.fill("BE DCF");
    await expect(page.getByRole("option").first()).toContainText("BE");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: false, keyCode: 229 });
    await input.dispatchEvent("keydown", { key: "Escape", code: "Escape", isComposing: false, keyCode: 229 });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await input.fill("UNKNOWN technical");
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option")).toContainText(/在持仓中搜索|Search holdings/);
    await input.fill("估值");
    await expect(page.getByRole("status").filter({ hasText: /加上代码|Add a ticker/ })).toBeVisible();
  });

  test("search hands a security outside the research list to the finder over the current view and its filters", async ({ page, browserName }) => {
    const searches: string[] = [];
    await page.route("**/api/backend/securities/search?**", (route) => {
      searches.push(new URL(route.request().url()).searchParams.get("q") ?? "");
      return route.fulfill({ json: { query: "Synthetic Example", source: "openfigi", results: [{
        ticker: "SYNX", name: "Synthetic Example Holdings", exchange: "NasdaqGS", bloombergTicker: "SYNX US",
        figi: "BBG000SYNX01", securityType: "Common Stock", alreadyWatched: false,
      }] } });
    });
    const findOption = page.getByRole("option", { name: /在全部证券中查找|Find in all securities/ });
    const finder = page.getByRole("dialog");
    // A lens other than the overview, with a filter, a reading opened and the page scrolled.
    const address = "/research?ticker=AAPL&view=analyst&estimateFrequency=year";
    await page.goto(address);
    // Research keeps one search: the workspace's.
    await expect(page.getByRole("button", { name: searchName })).toHaveCount(1);
    const readings = page.locator("details").filter({ has: page.locator("summary", { hasText: /^(季度读数|Quarterly readings)$/ }) });
    await readings.locator("summary").click();
    await expect(readings).toHaveAttribute("open", "");
    // The page scrolls smoothly; an instant scroll gives a position to compare.
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: "instant" }));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    const entries = await page.evaluate(() => history.length);
    // A trusted pointer click on the already visible sticky trigger avoids
    // Playwright's automatic scroll to place the target inside root scroll padding.
    const searchButton = page.getByRole("banner").getByRole("button", { name: searchName });
    await expect(searchButton).toBeInViewport();
    const searchBox = (await searchButton.boundingBox())!;
    await page.mouse.click(searchBox.x + searchBox.width / 2, searchBox.y + searchBox.height / 2);
    const input = page.getByRole("combobox", { name: searchName });
    await expect(input).toBeFocused();
    await input.fill("Synthetic Example");
    await expect(findOption).toContainText("Synthetic Example");
    await findOption.click();
    await expect(finder.getByText("Synthetic Example Holdings")).toBeVisible();
    expect(searches).toEqual(["Synthetic Example"]);
    await expect(page).toHaveURL((url) => url.pathname + url.search === address);
    const finderInput = finder.getByRole("searchbox");
    await finderInput.click();
    await finderInput.fill("");
    await finderInput.evaluate((el) => {
      const form = el.closest("form");
      const log: Array<{
        type: string;
        isComposing?: boolean;
        key?: string;
        keyCode?: number;
        cancelable?: boolean;
        defaultPrevented?: boolean;
      }> = [];
      let submits = 0;
      const onStart = () => log.push({ type: "compositionstart" });
      const onEnd = () => log.push({ type: "compositionend" });
      const onSubmit = () => { submits += 1; };
      // Observe on window (bubble phase, after React's root listener) so defaultPrevented reflects React's onKeyDown.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.target === el && event.key === "Enter") {
          log.push({
            type: "keydown",
            key: event.key,
            isComposing: event.isComposing,
            keyCode: event.keyCode,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
          });
        }
      };
      el.addEventListener("compositionstart", onStart);
      el.addEventListener("compositionend", onEnd);
      form?.addEventListener("submit", onSubmit);
      window.addEventListener("keydown", onKeyDown);
      const w = window as unknown as Record<string, unknown>;
      w.__tmImeLog = log;
      w.__tmImeSubmits = () => submits;
      w.__tmImeCleanup = () => {
        el.removeEventListener("compositionstart", onStart);
        el.removeEventListener("compositionend", onEnd);
        form?.removeEventListener("submit", onSubmit);
        window.removeEventListener("keydown", onKeyDown);
      };
    });
    if (browserName === "chromium") {
      // Exercise a real browser IME composition path that can reach native implicit form submission.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "Another Synthetic Example",
        selectionStart: 25,
        selectionEnd: 25,
      });
      await page.keyboard.press("Enter");
      await cdp.send("Input.insertText", { text: "Another Synthetic Example" });
      // Also exercise Safari/WKWebView's post-compositionend confirming Enter (keyCode 229).
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 229,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 229,
      });
      await cdp.detach();
    } else {
      // WebKit lacks CDP: drive composition and Safari's cancelable confirming Enter (isComposing / keyCode 229 + keypress/keyup).
      await finderInput.dispatchEvent("compositionstart");
      await page.keyboard.insertText("Another Synthetic Example");
      await finderInput.evaluate((el) => {
        const dispatchEnter = (
          type: "keydown" | "keypress" | "keyup",
          options: { isComposing: boolean; keyCode: number; charCode?: number },
        ) => {
          const event = new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
            isComposing: options.isComposing,
            keyCode: options.keyCode,
            charCode: options.charCode ?? 0,
            which: options.keyCode,
          });
          if (event.keyCode !== options.keyCode) {
            Object.defineProperty(event, "keyCode", { value: options.keyCode });
          }
          return el.dispatchEvent(event);
        };
        // Confirming Enter during composition (isComposing=true): if not prevented, Safari's default action fires keypress and submits the form.
        if (dispatchEnter("keydown", { isComposing: true, keyCode: 229 })) {
          dispatchEnter("keypress", { isComposing: true, keyCode: 13, charCode: 13 });
        }
        dispatchEnter("keyup", { isComposing: false, keyCode: 13 });
        el.dispatchEvent(new CompositionEvent("compositionend", { data: "Another Synthetic Example", bubbles: true }));
        // Safari/WKWebView post-compositionend confirming Enter (isComposing=false, keyCode=229): if not prevented, keypress triggers WebKit's native implicit submit.
        if (dispatchEnter("keydown", { isComposing: false, keyCode: 229 })) {
          dispatchEnter("keypress", { isComposing: false, keyCode: 13, charCode: 13 });
        }
        dispatchEnter("keyup", { isComposing: false, keyCode: 13 });
      });
    }
    const imeBeforeSubmit = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        log: w.__tmImeLog as Array<{ type: string; isComposing?: boolean; keyCode?: number; cancelable?: boolean; defaultPrevented?: boolean }>,
        submits: (w.__tmImeSubmits as () => number)(),
      };
    });
    expect(imeBeforeSubmit.log.some((entry) => entry.type === "compositionstart")).toBe(true);
    expect(imeBeforeSubmit.log.some((entry) => entry.type === "compositionend")).toBe(true);
    expect(imeBeforeSubmit.log.some((entry) => entry.type === "keydown" && entry.isComposing && entry.cancelable && entry.defaultPrevented)).toBe(true);
    expect(imeBeforeSubmit.log.some((entry) => entry.type === "keydown" && !entry.isComposing && entry.keyCode === 229 && entry.cancelable && entry.defaultPrevented)).toBe(true);
    expect(imeBeforeSubmit.submits).toBe(0);
    await expect(finderInput).toHaveValue("Another Synthetic Example");
    expect(searches).toEqual(["Synthetic Example"]);
    await page.keyboard.press("Enter");
    await expect.poll(() => searches).toEqual(["Synthetic Example", "Another Synthetic Example"]);
    const submitsAfterEnter = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const count = (w.__tmImeSubmits as () => number)();
      (w.__tmImeCleanup as (() => void) | undefined)?.();
      return count;
    });
    expect(submitsAfterEnter).toBe(1);
    expect(searches).toHaveLength(2);
    // Base UI lets the browser handle Escape until its composition-end cleanup runs.
    await finderInput.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(finderInput).toBeFocused();
    await expect(finderInput).toHaveValue("Another Synthetic Example");
    // Closing the finder leaves the page as it was, without a history entry, and returns to Search.
    await page.keyboard.press("Escape");
    await expect(finder).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname + url.search === address);
    await expect(page.getByRole("tab", { name: /预期与事件|Estimates/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: /^(年度|Annual)$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(readings).toHaveAttribute("open", "");
    expect(Math.abs(await page.evaluate(() => window.scrollY) - scrolled)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await expect(page.getByRole("banner").getByRole("button", { name: searchName })).toBeFocused();
    // An index keeps its view the same way.
    const indexAddress = "/research?type=index&index=sp-500&view=price";
    await page.goto(indexAddress);
    await expect(page.getByRole("tab", { name: /价格与走势|Price & trend/ })).toHaveAttribute("aria-selected", "true");
    const fromIndex = await openSearch(page);
    await fromIndex.fill("Synthetic Example");
    await findOption.click();
    await expect(finder.getByText("Synthetic Example Holdings")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname + url.search === indexAddress);
    await expect(page.getByRole("tab", { name: /价格与走势|Price & trend/ })).toHaveAttribute("aria-selected", "true");
    // A listed ticker and a lens query stay within the research list.
    const again = await openSearch(page);
    await again.fill("ARM");
    await expect(findOption).toHaveCount(0);
    await again.fill("Synthetic 估值");
    await expect(findOption).toHaveCount(0);
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
    // Phones name the page as the dock does.
    await expect(page.getByRole("option").filter({ hasText: /总览|Overview|Home/ })).toHaveCount(1);
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

  test("mobile navigation uses legible short labels, visible selection and constant stroke across pointer and keyboard navigation", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.goto("/");
    const dock = page.locator(".mx-mobile-dock");
    await expect(dock).toBeVisible();
    await expect(dock.getByRole("link")).toHaveText(["总览", "持仓", "收益", "市场", "研究", "复盘"]);
    expect(await dock.getByRole("link").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    expect(await dock.getByRole("link").evaluateAll((links) => links.every((link) => link.getBoundingClientRect().height >= 56))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const expectDockSelection = async (name: string) => {
      const active = dock.getByRole("link", { name, exact: true });
      await expect(active).toHaveAttribute("aria-current", "page");
      await expect.poll(() => dock.locator('[aria-current="page"]').evaluate((el) => {
        const group = el.closest(".mx-nav-group")!;
        const indicator = group.querySelector(".mx-nav-indicator")!;
        const dockEl = el.closest(".mx-mobile-dock")!;
        const inactive = Array.from(group.querySelectorAll("a")).find((a) => a !== el)!;
        const a = el.getBoundingClientRect();
        const b = indicator.getBoundingClientRect();
        const indStyle = getComputedStyle(indicator);
        return {
          aligned: Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1,
          visible: indStyle.visibility === "visible" && indStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && indStyle.backgroundColor !== getComputedStyle(dockEl).backgroundColor,
          inkDistinct: getComputedStyle(el).color !== getComputedStyle(inactive).color,
        };
      })).toEqual({ aligned: true, visible: true, inkDistinct: true });
      for (const icon of await dock.locator(".mx-nav-icon > svg").all()) {
        await expect(icon).toHaveCSS("stroke-width", "2px");
      }
      expect(await dock.locator(".mx-nav-icon > svg").evaluateAll((icons) => icons.reduce((count, icon) => count + icon.getAnimations().length, 0))).toBe(0);
    };

    await dock.getByRole("link", { name: "持仓", exact: true }).tap();
    await expect(page).toHaveURL(/\/holdings$/);
    await expect(dock.locator(".mx-nav-group")).toHaveAttribute("data-motion", "pointer");
    await expectDockSelection("持仓");

    const research = dock.getByRole("link", { name: "研究", exact: true });
    await research.focus();
    await research.press("Enter");
    await expect(page).toHaveURL(/\/research$/);
    await expect(dock.locator(".mx-nav-group")).not.toHaveAttribute("data-motion", "pointer");
    await expectDockSelection("研究");
  });

  test("mobile More menu keeps visible selection and constant stroke across pointer and keyboard navigation", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.goto("/");
    const more = page.getByRole("button", { name: /^(更多|More)$/ });
    const menu = page.getByRole("menu");
    const statusItem = menu.getByRole("menuitem", { name: /^(数据状态|Data status)$/ });
    const settingsItem = menu.getByRole("menuitem", { name: /^(设置|Settings)$/ });

    const expectMoreSelection = async (activeName: RegExp, inactiveName: RegExp) => {
      const activeItem = menu.getByRole("menuitem", { name: activeName });
      const inactiveItem = menu.getByRole("menuitem", { name: inactiveName });
      await expect(activeItem).toHaveAttribute("aria-current", "page");
      await expect(inactiveItem).not.toHaveAttribute("aria-current");
      await expect(activeItem.locator("svg.lucide-check")).toHaveCount(1);
      await expect(activeItem.locator("svg.lucide-check")).toBeVisible();
      await expect(inactiveItem.locator("svg.lucide-check")).toHaveCount(0);
      // Destination icons render at 18px beside a 16px check, and the current row reads in semibold.
      for (const item of [activeItem, inactiveItem]) {
        await expect(item.locator("svg:not(.lucide-check)")).toHaveCSS("width", "18px");
      }
      await expect(activeItem.locator("svg.lucide-check")).toHaveCSS("width", "16px");
      await expect(activeItem).toHaveCSS("font-weight", "600");
      await expect(inactiveItem).not.toHaveCSS("font-weight", "600");
      // Destinations are links, but read as menu items: no link underline.
      for (const item of [activeItem, inactiveItem]) await expect(item).toHaveCSS("text-decoration-line", "none");
      await expect.poll(async () => {
        const [menuBg, activeBg] = await Promise.all([
          menu.evaluate((el) => getComputedStyle(el).backgroundColor),
          activeItem.evaluate((el) => getComputedStyle(el).backgroundColor),
        ]);
        return activeBg !== "rgba(0, 0, 0, 0)" && activeBg !== menuBg;
      }).toBe(true);
      for (const item of [activeItem, inactiveItem]) {
        for (const svg of await item.locator("svg").all()) {
          await expect(svg).toHaveCSS("stroke-width", "2px");
        }
        expect(await item.locator("svg").evaluateAll((icons) => icons.reduce((count, icon) => count + icon.getAnimations().length, 0))).toBe(0);
      }
    };

    // Unselected on overview.
    await more.tap();
    await expect(menu).toHaveCSS("opacity", "1");
    await expect(statusItem).not.toHaveAttribute("aria-current");
    await expect(settingsItem).not.toHaveAttribute("aria-current");
    await expect(statusItem.locator("svg")).toHaveCSS("stroke-width", "2px");
    await expect(settingsItem.locator("svg")).toHaveCSS("stroke-width", "2px");

    // Pointer navigation to Settings.
    await settingsItem.tap();
    await expect(page).toHaveURL(/\/settings$/);
    await more.tap();
    await expect(menu).toHaveCSS("opacity", "1");
    await expectMoreSelection(/^(设置|Settings)$/, /^(数据状态|Data status)$/);
    expect((await new AxeBuilder({ page }).include('[role="menu"]').analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Keyboard navigation from Settings to Data status.
    await more.focus();
    await more.press("Enter");
    await expect(menu).toHaveCSS("opacity", "1");
    await expectMoreSelection(/^(设置|Settings)$/, /^(数据状态|Data status)$/);
    await expect(statusItem).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(settingsItem).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(statusItem).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/health$/);

    // Re-open via keyboard and check visible selection in both dark and light schemes.
    await more.focus();
    await more.press("Enter");
    await expect(menu).toHaveCSS("opacity", "1");
    await expectMoreSelection(/^(数据状态|Data status)$/, /^(设置|Settings)$/);

    await menu.getByRole("menuitemradio", { name: /^(浅色|Light)$/ }).tap();
    await expect(menu).toHaveCount(0);
    await more.tap();
    await expect(menu).toHaveCSS("opacity", "1");
    await expectMoreSelection(/^(数据状态|Data status)$/, /^(设置|Settings)$/);
  });

  for (const size of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
    test(`mobile tools and bottom menu fit ${size.width}×${size.height} in English`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile");
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/");
      // The dock holds the main pages; one menu adds only what the dock lacks.
      await page.getByRole("button", { name: "更多", exact: true }).tap();
      await page.getByRole("menuitem", { name: "Switch to English" }).tap();
      const tools = page.locator(".mx-topbar button");
      expect(await tools.evaluateAll((buttons) => buttons.filter((button) => button.getClientRects().length)
        .every((button) => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44))).toBe(true);
      await expect(page.locator(".mx-topbar").getByRole("button", { name: "Choose appearance" })).toBeHidden();
      await expect(page.locator(".mx-mobile-dock")).toBeVisible();
      // Six cells at 320px: Holdings and Research, the longest names, still fit without clipping.
      const dockLinks = page.locator(".mx-mobile-dock").getByRole("link");
      await expect(dockLinks).toHaveText(["Home", "Holdings", "Returns", "Markets", "Research", "Review"]);
      await page.evaluate(() => document.fonts.ready);
      for (const link of await dockLinks.all()) {
        const sizes = await link.evaluate((element) => {
          const label = element.lastElementChild!;
          const text = label.getBoundingClientRect();
          const cell = element.getBoundingClientRect();
          return {
            direction: getComputedStyle(element).flexDirection,
            size: parseFloat(getComputedStyle(label).fontSize),
            fits: text.left >= cell.left && text.right <= cell.right,
          };
        });
        expect.soft(sizes.direction).toBe("column");
        expect.soft(sizes.size).toBeGreaterThanOrEqual(12);
        expect.soft(sizes.fits).toBe(true);
      }
      const research = page.locator(".mx-mobile-dock").getByRole("link", { name: "Research" });
      await research.tap();
      await expect(research).toHaveAttribute("aria-current", "page");
      expect(await research.evaluate((link) => {
        const label = link.lastElementChild!.getBoundingClientRect();
        const cell = link.getBoundingClientRect();
        return label.left >= cell.left && label.right <= cell.right;
      })).toBe(true);
      await page.goBack();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "More", exact: true }).tap();
      const menu = page.getByRole("menu");
      await expect(menu).toHaveCSS("opacity", "1");
      await expect(menu.getByRole("menuitem")).toHaveText(["Data status", "Settings", "中文"]);
      await expect(menu.getByRole("menuitemradio")).toHaveText(["Light", "Dark", "System · Light"]);
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      expect((await new AxeBuilder({ page }).include('[role="menu"]').analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      const input = await openSearch(page);
      await expect(input).toHaveCSS("font-size", "16px");
      await input.fill("TWR");
      await page.getByRole("option").first().tap();
      await expect(page).toHaveURL(/view=returns$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  }

  test("appearance commands expose their selected value and return keyboard focus", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: isMobile ? "More" : "Choose appearance", exact: true });
    const menu = page.getByRole("menu");
    const appearance = menu.getByRole("group", { name: "Appearance" });
    const light = appearance.getByRole("menuitemradio", { name: "Light", exact: true });
    const dark = appearance.getByRole("menuitemradio", { name: "Dark", exact: true });
    const system = appearance.getByRole("menuitemradio", { name: "System · Light" });
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(isMobile ? menu.getByRole("menuitem", { name: "Data status" }) : light).toBeFocused();
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("End");
    await expect(system).toBeFocused();
    await page.keyboard.press("Space");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
    await trigger.press("Enter");
    await expect(appearance.getByRole("menuitemradio", { checked: true })).toHaveText("System · Light");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  for (const width of [320, 390]) {
    test(`keyboard focus clears both shell bars at ${width}px`, async ({ page, isMobile }) => {
      test.skip(!isMobile);
      await page.setViewportSize({ width, height: 667 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.addStyleTag({ content: ":root { --shell-safe-top: 59px; --shell-safe-bottom: 34px; }" });
      const header = page.locator(".mx-topbar");
      const dock = page.locator(".mx-mobile-dock");
      await expect(page.locator("html")).toHaveCSS("scroll-padding-top", "123px");
      await expect(page.locator("html")).toHaveCSS("scroll-padding-bottom", "102px");
      const account = page.getByRole("combobox", { name: /Portfolio account|组合账户/ });
      const more = header.getByRole("button", { name: /More|更多/ });
      await more.focus();
      await page.evaluate(() => {
        const target = document.querySelector<HTMLElement>('main [role="combobox"]')!;
        window.scrollBy(0, target.getBoundingClientRect().top - 60);
      });
      await page.keyboard.press("Tab");
      await expect(account).toBeFocused();
      await expect.poll(async () => (await account.boundingBox())!.y >= (await header.boundingBox())!.height).toBe(true);

      const market = page.getByRole("button", { name: /选择市场，当前：|Choose market, now:/ });
      await expect(market).toBeAttached();
      // Position the picker under the dock before an ordinary reverse Tab.
      await market.press("Tab");
      await market.evaluate((target) => {
        const dockTop = document.querySelector(".mx-mobile-dock")!.getBoundingClientRect().top;
        window.scrollBy(0, target.getBoundingClientRect().top - dockTop - 8);
      });
      await page.keyboard.press("Shift+Tab");
      await expect(market).toBeFocused();
      await expect.poll(async () => {
        const box = (await market.boundingBox())!;
        return box.y + box.height <= (await dock.boundingBox())!.y;
      }).toBe(true);
    });
  }

  test("short landscape keeps the safe area clear and makes room below the top bar", async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.addStyleTag({ content: ":root { --shell-safe-left: 59px; --shell-safe-right: 47px; }" });
    const main = page.getByRole("main");
    const top = page.locator(".mx-topbar");
    const dock = page.locator(".mx-mobile-dock");
    await expect(main).toHaveCSS("padding-left", "59px");
    await expect(main).toHaveCSS("padding-right", "47px");
    await expect(dock).toHaveCSS("height", "48px");
    const skip = page.getByRole("link", { name: /跳到正文|Skip to content/ });
    await skip.focus();
    expect((await skip.boundingBox())!.x).toBeGreaterThanOrEqual(59);
    await skip.press("Enter");
    await expect(main).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 250));
    await expect.poll(async () => (await top.boundingBox())!.y).toBeLessThan(-60);
    await expect(dock).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(844);
  });

  test("short landscape shows Search on focus return and More on upward scroll", async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // Wait for the client workspace before sending a scroll from the top.
    await expect(page.getByRole("combobox", { name: /Portfolio account|组合账户/ })).toBeEnabled();
    const header = page.getByRole("banner");
    const search = header.getByRole("button", { name: searchName });
    const more = header.getByRole("button", { name: /^(More|更多)$/ });
    await page.evaluate(() => window.scrollTo(0, 750));
    await expect(search).not.toBeInViewport();
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("combobox", { name: searchName })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(search).toBeFocused();
    await expect.soft(search).toBeInViewport({ ratio: 1, timeout: 1500 });
    expect(await page.evaluate(() => window.scrollY)).toBe(750);

    // Once the header loses focus, scrolling down hides it and scrolling up shows it at the current position.
    await search.blur();
    await page.evaluate(() => window.scrollTo(0, 850));
    await expect(more).not.toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 750));
    await expect.soft(more).toBeInViewport({ ratio: 1, timeout: 1500 });
    expect(await page.evaluate(() => window.scrollY)).toBe(750);
  });

  test("the portrait Returns chart jump keeps its 80px landing", async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.goto("/analytics?view=returns");
    await page.locator(".mx-monthly-returns summary").click();
    await page.locator(".mx-monthly-returns .mx-heat-pill").first().click();
    const chart = page.locator(".mx-performance-chart");
    await expect.poll(async () => Math.round((await chart.boundingBox())!.y), { timeout: 2500 }).toBe(80);
  });

  test("shell controls and content fit from 320 to 1920 CSS pixels", async ({ page, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.goto("/");
    for (const width of [320, 375, 767, 768, 959, 960, 1199, 1200, 1440, 1920]) {
      await page.setViewportSize({ width, height: 820 });
      const box = (await page.getByRole("main").boundingBox())!;
      expect(box.x).toBe(width <= 767 ? 0 : Math.max(76, (width + 76 - 1800) / 2));
      const result = await page.evaluate(() => {
        const { clientWidth, scrollWidth } = document.documentElement;
        const controls = Array.from(document.querySelectorAll<HTMLElement>(".mx-topbar button, .mx-mobile-dock a"));
        const visible = controls.filter((control) => control.getClientRects().length);
        return {
          pageFits: scrollWidth <= clientWidth,
          controlsFit: visible.every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= clientWidth && rect.width >= (control.closest("nav") ? 44 : 40);
          }),
        };
      });
      expect(result, `viewport ${width}px, ${isMobile ? "coarse" : "fine"} pointer`).toEqual({ pageFits: true, controlsFit: true });
    }
  });

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

  test("desktop rail keeps six adjacent, named icons with hover and focus hints", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/");
    const rail = page.locator(".mx-sidebar");
    await expect(rail.locator("[data-search-trigger]")).toHaveCount(0);
    await expect(page.locator("[data-search-trigger]")).toHaveCount(1);
    await expect(page.locator(".mx-topbar").getByRole("button", { name: searchName })).toBeVisible();
    const nav = rail.getByRole("navigation", { name: /主导航|Primary navigation/ });
    await expect(nav.locator(".mx-nav-group")).toHaveCount(1);
    await expect(nav.getByRole("link")).toHaveCount(6);
    expect((await rail.boundingBox())!.width).toBe(76);
    const cells = await nav.getByRole("link").evaluateAll((links) => links.map((link) => {
      const { x, y, height, width } = link.getBoundingClientRect();
      return { x, y, height, width };
    }));
    expect(cells.map(({ width, height }) => [width, height])).toEqual(Array(6).fill([48, 48]));
    expect(cells.slice(1).map((cell, i) => cell.y - cells[i].y)).toEqual(Array(5).fill(52));
    expect(await nav.innerText()).toBe("");
    expect(await nav.getByRole("link").evaluateAll((links) => links.every((link) => link.getAttribute("aria-label") && link.getBoundingClientRect().height >= 44))).toBe(true);
    const research = nav.getByRole("link", { name: /^(研究|Research)$/ });
    await expect(nav.locator('.mx-nav-icon > svg[width="20"][stroke="currentColor"][aria-hidden="true"]')).toHaveCount(6);
    await expect(nav.locator(".mx-nav-icon svg")).toHaveCount(6);
    const researchShape = await research.locator(".mx-nav-icon svg").innerHTML();
    expect(researchShape).not.toBe(await page.locator(".mx-topbar-search svg").innerHTML());
    expect(researchShape).not.toBe(await nav.getByRole("link", { name: /收益与风险|Performance/ }).locator(".mx-nav-icon svg").innerHTML());
    await research.hover();
    const hint = page.locator('[data-slot="tooltip-content"]');
    await expect(hint).toHaveText(/^(研究|Research)$/);
    await expect(hint).toHaveAttribute("aria-hidden", "true");
    await expect(research).not.toHaveAttribute("aria-describedby");
    await hint.hover();
    await expect(hint).toBeVisible();
    await page.mouse.move(300, 80);
    await expect(hint).toHaveCount(0);
    await research.focus();
    await expect(hint).toHaveText(/^(研究|Research)$/);
    await page.keyboard.press("Escape");
    await expect(hint).toHaveCount(0);
    await expect(research).toBeFocused();
  });

  test("rail keeps a constant stroke width and visible selection across pointer and keyboard navigation", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/analytics");
    const rail = page.locator(".mx-sidebar");
    const nav = rail.getByRole("navigation", { name: /主导航|Primary navigation/ });
    const utilityNav = rail.getByRole("navigation", { name: /工作区管理|Workspace management/ });

    const expectRailSelection = async (scope: typeof nav, name: RegExp) => {
      const active = scope.getByRole("link", { name });
      await expect(active).toHaveAttribute("aria-current", "page");
      await expect.poll(() => scope.locator('[aria-current="page"]').evaluate((el) => {
        const group = el.closest(".mx-nav-group")!;
        const indicator = group.querySelector(".mx-nav-indicator")!;
        const sidebar = el.closest(".mx-sidebar")!;
        const inactive = Array.from(group.querySelectorAll("a")).find((a) => a !== el)!;
        const a = el.getBoundingClientRect();
        const b = indicator.getBoundingClientRect();
        const indStyle = getComputedStyle(indicator);
        return {
          aligned: Math.abs(a.top - b.top) < 1 && Math.abs(a.height - b.height) < 1,
          visible: indStyle.visibility === "visible" && indStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && indStyle.backgroundColor !== getComputedStyle(sidebar).backgroundColor,
          inkDistinct: getComputedStyle(el).color !== getComputedStyle(inactive).color,
        };
      })).toEqual({ aligned: true, visible: true, inkDistinct: true });
      for (const icon of await rail.locator(".mx-nav-icon > svg").all()) {
        await expect(icon).toHaveCSS("stroke-width", "2px");
      }
      expect(await rail.locator(".mx-nav-icon > svg").evaluateAll((icons) => icons.reduce((count, icon) => count + icon.getAnimations().length, 0))).toBe(0);
    };

    await expectRailSelection(nav, /收益与风险|Performance/);

    const research = nav.getByRole("link", { name: /^(研究|Research)$/ });
    await research.click();
    await expect(nav.locator(".mx-nav-group")).toHaveAttribute("data-motion", "pointer");
    await expectRailSelection(nav, /^(研究|Research)$/);

    const review = nav.getByRole("link", { name: /投资复盘|Review/ });
    await page.mouse.move(300, 80);
    await review.focus();
    await review.press("Enter");
    await expect(nav.locator(".mx-nav-group")).not.toHaveAttribute("data-motion", "pointer");
    await expectRailSelection(nav, /投资复盘|Review/);

    const settings = utilityNav.getByRole("link", { name: /^(设置|Settings)$/ });
    await settings.click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(utilityNav.locator(".mx-nav-group")).toHaveAttribute("data-motion", "pointer");
    await expectRailSelection(utilityNav, /^(设置|Settings)$/);

    const status = utilityNav.getByRole("link", { name: /数据状态|Data status/ });
    await page.mouse.move(300, 80);
    await status.focus();
    await status.press("Enter");
    await expect(page).toHaveURL(/\/health$/);
    await expect(utilityNav.locator(".mx-nav-group")).not.toHaveAttribute("data-motion", "pointer");
    await expectRailSelection(utilityNav, /数据状态|Data status/);
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
