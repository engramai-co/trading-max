import { expect, test, type Locator, type Page } from "@playwright/test";

// A synthetic current chain around a spot of 100: two expirations, calls and puts at three strikes.
const expiries = ["2026-11-20", "2026-12-18"];
const contracts = expiries.flatMap((expiry, e) => [90, 100, 110].flatMap((strike) => (["call", "put"] as const).map((side) => ({
  expiry, side, strike, multiplier: 100, currency: "USD",
  contractSymbol: "AAPL" + expiry.slice(2).replace(/-/g, "") + (side === "call" ? "C" : "P") + String(strike * 1000).padStart(8, "0"),
  bid: 4, ask: 4.4, lastPrice: 4.2, impliedVolatility: 0.3, delta: 0.5, gamma: 0.01, volume: 10,
  openInterest: (side === "call" ? 10 : 20) * strike + e, gex1pct: side === "call" ? 1_000 : -800,
}))));
const chain = {
  ticker: "AAPL", currency: "USD", spot: 100, capturedAt: "2026-11-16T15:00:00Z",
  availability: { state: "current", currentExpiries: expiries }, availableExpiries: expiries,
  expiries: expiries.map((expiry, e) => ({
    expiry, callOpenInterest: 3_000, putOpenInterest: 6_000, putCallOiRatio: 2,
    gammaProfile: [80, 90, 100, 110, 120].map((spot, i) => ({ spot, netGex: (i - 2) * 1_234_567 + e * 100_000 })),
  })),
  contracts,
};
const ISO = /\d{4}-\d{2}-\d{2}/;
// Seven captured expirations, two more than a chart can draw apart.
const seven = ["2026-11-20", "2026-11-27", "2026-12-04", "2026-12-11", "2026-12-18", "2027-01-15", "2027-02-19"];
const sevenChains = {
  ...chain,
  availability: { state: "current", currentExpiries: seven }, availableExpiries: seven,
  expiries: seven.map((expiry, e) => ({ ...chain.expiries[0], expiry,
    gammaProfile: chain.expiries[0].gammaProfile.map((point) => ({ ...point, netGex: point.netGex + e * 50_000 })) })),
  contracts: seven.flatMap((expiry) => contracts.filter((c) => c.expiry === expiries[0]).map((c) => ({ ...c, expiry }))),
};

/** The spoken reading beside the plot, and the card (desktop) or strip (phone) that shows it. */
function reading(page: Page, chart: Locator, isMobile: boolean) {
  return {
    spoken: chart.locator("xpath=../../..").locator("[data-chart-reading]"),
    shown: isMobile ? page.locator(".mx-chart-strip") : chart.locator("..").locator(".mx-chart-popup"),
  };
}

async function openPayoffEditor(page: Page) {
  await page.goto("/research?ticker=AAPL&view=options&optionView=payoff");
  const contract = page.getByRole("combobox", { name: "Contract", exact: true });
  await contract.click();
  await contract.fill("CALL 100");
  await page.getByRole("option", { name: /^CALL 100 · / }).click();
  await page.getByRole("button", { name: "Add to analysis" }).click();
  return page.getByRole("textbox", { name: "Cost per contract" });
}

test.describe("option and rating charts read through the reading card", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a seeded local preview.");

  test.beforeEach(async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/backend/research/AAPL/lens/options?**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), options: chain } });
    });
  });

  test("open interest reads both sides at a strike, keyed to their bars", async ({ page, isMobile }) => {
    await page.goto("/research?ticker=AAPL&view=options&optionView=interest");
    const chart = page.getByRole("group", { name: "Open interest for selected expirations" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const { spoken, shown } = reading(page, chart, isMobile);
    await chart.press("Home");
    await expect(spoken).toHaveAttribute("data-chart-reading", "selected");
    await expect(spoken).toContainText("Strike 90");
    await expect(spoken).toContainText("Calls 900");
    await expect(spoken).toContainText("Puts 1,800");
    await expect(shown).toBeVisible();
    await expect(shown.locator('.mx-reading-key[data-kind="bar"]')).toHaveCount(2);
    await chart.press("Escape");
    await expect(shown).toBeHidden();
    await expect(spoken).toHaveAttribute("data-chart-reading", "latest");
  });

  test("gamma reads every selected expiration by its date, finer than the axis", async ({ page, isMobile }) => {
    await page.goto("/research?ticker=AAPL&view=options&optionView=gamma&expiries=" + expiries.join(","));
    const chart = page.getByRole("group", { name: "Spot scenarios for selected expirations" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const { spoken, shown } = reading(page, chart, isMobile);
    await chart.press("Home");
    await expect(spoken).toContainText("80.00");
    await expect(spoken).toContainText("\u22122.469m");
    await expect(spoken).toContainText("\u22122.369m");
    await expect(spoken).not.toContainText(ISO);
    await expect(spoken).not.toContainText("USD");
    await expect(shown).toBeVisible();
    // The first expiration leads in a solid key; the second is keyed dashed, as its line is drawn.
    await expect(shown.locator(".mx-reading-key")).toHaveCount(2);
    await expect(shown.locator(".mx-reading-key[data-dashed]")).toHaveCount(1);
    await chart.press("End");
    await expect(spoken).toContainText("120.00");
    await chart.press("Escape");
    await expect(shown).toBeHidden();
  });

  test("IME commits into a fee at the original selection", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Uses Chromium's native IME events via CDP.");
    const fee = await openPayoffEditor(page);
    await fee.fill("1234");
    await expect(fee).toHaveValue("1234");
    await fee.evaluate((input: HTMLInputElement) => input.setSelectionRange(4, 4));
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", { text: "5", selectionStart: 1, selectionEnd: 1 });
      await expect(fee).toHaveValue("12345");
      await cdp.send("Input.insertText", { text: "5" });
      await expect(fee).toHaveValue("12345");
      expect(await fee.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([5, 5]);
      const chart = page.getByRole("group", { name: "Hypothetical expiration P/L" });
      await chart.press("Home");
      await expect(reading(page, chart, false).spoken).toContainText("12,765.00");

      await fee.focus();
      await fee.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 3));
      await cdp.send("Input.imeSetComposition", { text: "9", selectionStart: 1, selectionEnd: 1 });
      await expect(fee).toHaveValue("1945");
      await cdp.send("Input.insertText", { text: "9" });
      await expect(fee).toHaveValue("1945");
      expect(await fee.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 2]);

      await cdp.send("Input.imeSetComposition", { text: "8", selectionStart: 1, selectionEnd: 1 });
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
      await expect(fee).toHaveValue("1945");
      expect(await fee.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 2]);
    } finally {
      await cdp.detach();
    }
  });

  test("blurring during IME composition clamps the fee", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Uses Chromium's native IME events via CDP.");
    const fee = await openPayoffEditor(page);
    await fee.fill("1");
    await fee.press("ControlOrMeta+A");
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", { text: "-5", selectionStart: 2, selectionEnd: 2 });
      await expect(fee).toHaveValue("-5");
      const premium = page.getByRole("textbox", { name: /^Assumed premium/ });
      await premium.click();
      await expect(premium).toBeFocused();
      await expect(fee).toHaveValue("0");
    } finally {
      await cdp.detach();
    }
  });

  test("a refreshed chain retains the selected label while its contract is unavailable", async ({ page }) => {
    const now = new Date("2026-11-16T15:00:00Z");
    await page.clock.setFixedTime(now);
    let omitContract = false;
    await page.route("**/api/backend/research/AAPL/lens/options?**", async (route) => {
      const options = omitContract ? {
        ...chain,
        contracts: chain.contracts.filter(contract => !(
          contract.expiry === expiries[0] && contract.side === "call" && contract.strike === 100
        )),
      } : chain;
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), options } });
    });
    await page.goto("/research?ticker=AAPL&view=options&optionView=payoff");
    const contract = page.getByRole("combobox", { name: "Contract", exact: true });
    const add = page.getByRole("button", { name: "Add to analysis" });
    await contract.fill("CALL 100");
    const choice = page.getByRole("option", { name: /^CALL 100 · / });
    const label = (await choice.textContent())!;
    await choice.click();
    await expect(contract).toHaveValue(label);
    await expect(add).toBeEnabled();

    omitContract = true;
    await page.clock.setFixedTime(new Date(now.getTime() + 120_000));
    const refresh = page.waitForResponse(response => response.url().includes("/lens/options?"));
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await refresh;
    await contract.click();
    await expect(choice).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(contract).toHaveValue(label);
    await expect(add).toBeDisabled();
  });

  test("native paste and cut support undo and redo", async ({ page }) => {
    const fee = await openPayoffEditor(page);
    const premium = page.getByRole("textbox", { name: /^Assumed premium/ });
    // Seed each baseline through a controlled step so WebKit has no setup typing transaction to undo.
    await fee.fill("76");
    await fee.press("ArrowUp");
    await expect(fee).toHaveValue("77");
    await premium.fill("12");
    await premium.press("ControlOrMeta+A");
    await premium.press("ControlOrMeta+C");
    await fee.press("ControlOrMeta+A");
    await fee.press("ControlOrMeta+V");
    await expect(fee).toHaveValue("12");
    await fee.press("ControlOrMeta+Z");
    await expect(fee).toHaveValue("77");
    await fee.press("ControlOrMeta+Shift+Z");
    await expect(fee).toHaveValue("12");

    await fee.fill("122");
    await fee.press("ArrowUp");
    await expect(fee).toHaveValue("123");
    await fee.evaluate(async (input: HTMLInputElement) => {
      // Select after NumericFormat's post-render caret correction for the step.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      input.setSelectionRange(0, 1);
    });
    await fee.press("ControlOrMeta+X");
    await expect(fee).toHaveValue("23");
    await fee.press("ControlOrMeta+Z");
    await expect(fee).toHaveValue("123");
    await fee.press("ControlOrMeta+Shift+Z");
    await expect(fee).toHaveValue("23");

    // Copy external comma-decimal text from a plain field so paste runs the normalizer.
    const external = page.getByTestId("clipboard-source");
    await page.evaluate(() => {
      const source = document.createElement("input");
      source.dataset.testid = "clipboard-source";
      source.value = "1,25";
      document.body.append(source);
    });
    await external.press("ControlOrMeta+A");
    await external.press("ControlOrMeta+C");
    await fee.press("ControlOrMeta+A");
    await fee.press("ControlOrMeta+V");
    await expect(fee).toHaveValue("1.25");
    await fee.press("ControlOrMeta+Z");
    await expect(fee).toHaveValue("23");
    await fee.press("ControlOrMeta+Shift+Z");
    await expect(fee).toHaveValue("1.25");
  });

  test("fees round-trip through copy and cut", async ({ page }) => {
    const fee = await openPayoffEditor(page);
    const premium = page.getByRole("textbox", { name: /^Assumed premium/ });
    await fee.fill("1234");
    await expect(fee).toHaveValue("1234");
    await fee.press("ControlOrMeta+A");
    await fee.press("ControlOrMeta+C");
    await fee.fill("0");
    await fee.press("ControlOrMeta+A");
    await fee.press("ControlOrMeta+V");
    await expect(fee).toHaveValue("1234");
    await premium.press("ControlOrMeta+A");
    await premium.press("ControlOrMeta+V");
    await expect(premium).toHaveValue("1234");

    await fee.fill("1234.5");
    await expect(fee).toHaveValue("1234.5");
    await fee.evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 3));
    await fee.press("ControlOrMeta+X");
    await expect(fee).toHaveValue("4.5");
    await premium.press("ControlOrMeta+A");
    await premium.press("ControlOrMeta+V");
    await expect(premium).toHaveValue("123");
  });

  test("the payoff reads a signed, toned result at each underlying price", async ({ page, isMobile }) => {
    const fee = await openPayoffEditor(page);
    await fee.fill("1234567890.5");
    await expect(fee).toHaveValue("1234567890.5");
    const feeBox = (await fee.boundingBox())!;
    expect(feeBox.x + feeBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // Typing and pasting comma-decimal values match Mantine NumberInput (thousandSeparator unset).
    await fee.click();
    await fee.press("ControlOrMeta+A");
    await fee.pressSequentially("1,25");
    await expect(fee).toHaveValue("1.25");
    const pasteInto = async (text: string) => {
      await fee.evaluate((el, value) => {
        const input = el as HTMLInputElement;
        input.focus();
        input.setSelectionRange(0, input.value.length);
        const dt = new DataTransfer();
        dt.setData("text/plain", value);
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, text);
    };
    await pasteInto("1.234,56");
    await expect(fee).toHaveValue("1234.56");
    await pasteInto("1 234,567");
    await expect(fee).toHaveValue("1234.567");
    await pasteInto("£1,234");
    await expect(fee).toHaveValue("1.234");
    await pasteInto("1,234");
    await expect(fee).toHaveValue("1.234");
    const chart = page.getByRole("group", { name: "Hypothetical expiration P/L" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const { spoken, shown } = reading(page, chart, isMobile);
    // Fee 1.234 on top of the 420.00 premium yields +4,578.77 at expiry 150.00 (not +3,346.00 from 1,234).
    await expect(spoken).toContainText("+4,578.77");
    await pasteInto("1,25");
    await expect(fee).toHaveValue("1.25");
    // Fee 1.25 on top of the 420.00 premium yields +4,578.75 at expiry 150.00 (not +4,455.00 from 125).
    await expect(spoken).toContainText("+4,578.75");
    await fee.fill("1234567890123456");
    await expect(fee).toHaveValue("1234567890123456");
    await fee.press("ArrowDown");
    await expect(fee).toHaveValue("1234567890123455");
    await fee.press("ArrowUp");
    await expect(fee).toHaveValue("1234567890123456");
    await fee.fill("0");
    await fee.press("ArrowUp");
    await expect(fee).toHaveValue("1");
    await fee.press("ArrowDown");
    await expect(fee).toHaveValue("0");
    // The premium is the mid quote, 4.20 on 100 shares: below the strike the call loses 420.00.
    await chart.press("Home");
    await expect(spoken).toContainText("Underlying at expiry 0.00");
    await expect(spoken).toContainText("\u2212420.00");
    await expect(shown.locator(".mx-reading-primary")).toHaveAttribute("data-tone", "down");
    await chart.press("End");
    await expect(spoken).toContainText("+4,580.00");
    await expect(shown.locator(".mx-reading-primary")).toHaveAttribute("data-tone", "up");
    await chart.press("Escape");
    await expect(shown).toBeHidden();
  });

  test("the rating history reads each month as one compact bar with all five ratings", async ({ page }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { ...json, analyst: { ...json.analyst, recommendations: [
        { period: "0m", strongBuy: 6, buy: 19, hold: 14, sell: 0, strongSell: 2 },
        { period: "-1m", strongBuy: 5, buy: 18, hold: 15, sell: 1, strongSell: 2 },
      ] } } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst&analystView=ratings");
    const history = page.locator("summary").filter({ hasText: "Historical rating distribution" });
    const months = page.getByRole("list", { name: "Analyst counts by rating category" });
    await expect(months).toBeHidden();
    await history.press("Enter");
    // The current month leads; each bar is read with every rating, zeros included, and ends on its total.
    const rows = months.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Current");
    await expect(rows.first().getByRole("img")).toHaveAccessibleName("Strong buy 6, Buy 19, Hold 14, Sell 0, Strong sell 2");
    await expect(rows.first().locator("strong")).toHaveText("41");
    await expect(rows.nth(1)).toContainText("1 month ago");
    await expect(rows.nth(1)).not.toContainText("1 months");
    await expect(rows.nth(1).getByRole("img")).toHaveAccessibleName("Strong buy 5, Buy 18, Hold 15, Sell 1, Strong sell 2");
    // Only ratings with analysts take a share of the bar, and no chart is drawn for them.
    await expect(rows.first().locator(".mx-rating-history-bar > span")).toHaveCount(4);
    await expect(page.getByRole("group", { name: "Analyst counts by rating category" })).toHaveCount(0);
  });

  test("the expiration picker stops at five and says why the rest are unavailable", async ({ page, isMobile }) => {
    await page.route("**/api/backend/research/AAPL/lens/options?**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), options: sevenChains } });
    });
    // A link asking for six keeps the first five.
    await page.goto("/research?ticker=AAPL&view=options&optionView=gamma&expiries=" + seven.slice(0, 6).join(","));
    const field = page.getByRole("combobox", { name: "Select captured expirations" });
    const picked = page.locator('[data-slot="picker"]').filter({ has: field }).locator('[data-slot="picker-chip-label"]');
    await expect(picked).toHaveText([/^20 Nov( 2026)?$/, /^27 Nov( 2026)?$/, /^4 Dec( 2026)?$/, /^11 Dec( 2026)?$/, /^18 Dec( 2026)?$/]);
    // The keyboard opens the list; the pills cover most of the field.
    await field.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option")).toHaveCount(7);
    const unavailable = page.getByRole("option", { disabled: true });
    await expect(unavailable).toHaveCount(2);
    await expect(unavailable.first()).toHaveAccessibleName(/^15 Jan 2027, limit of 5 expirations reached$/);
    await expect(page.getByRole("option", { name: /^20 Nov( 2026)?$/ })).toBeEnabled();
    await page.keyboard.press("Escape");
    // Five lines, five strokes: every key the reading shows is drawn differently.
    const chart = page.getByRole("group", { name: "Spot scenarios for selected expirations" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const { spoken, shown } = reading(page, chart, isMobile);
    await chart.press("Home");
    for (const date of ["20 Nov", "27 Nov", "4 Dec", "11 Dec", "18 Dec"]) await expect(spoken).toContainText(date);
    await expect(spoken).not.toContainText("15 Jan");
    const keys = await shown.locator(".mx-reading-key").evaluateAll((items) =>
      items.map((key) => [key.getAttribute("style"), key.hasAttribute("data-dashed"), key.hasAttribute("data-dotted")].join("|")));
    expect(keys.length).toBeGreaterThan(2);
    expect(new Set(keys).size).toBe(keys.length);
    await chart.press("Escape");
  });

  test("expirations read as dates in pickers, tables and chart names", async ({ page }) => {
    await page.goto("/research?ticker=AAPL&view=options&expiries=" + expiries.join(","));
    const content = page.locator(".mx-research-content");
    const views = page.getByRole("group", { name: "Options analysis" });
    // The chain names its expiration above the strike column.
    await expect(content.getByRole("columnheader", { name: /^20 Nov( 2026)?$/ })).toBeVisible();
    await expect(content).not.toContainText(ISO);
    await views.getByRole("button", { name: "Implied volatility" }).click();
    await expect(page.getByRole("group", { name: /^20 Nov( 2026)? IV smile$/ })).toBeVisible();
    await expect(content).not.toContainText(ISO);
    await views.getByRole("button", { name: "Open interest" }).click();
    await expect(page.getByRole("region", { name: "Exact records" })).toContainText("18 Dec");
    await expect(content).not.toContainText(ISO);
    await views.getByRole("button", { name: "Expiry payoff" }).click();
    await page.getByRole("combobox", { name: "Contract", exact: true }).click();
    await expect(page.getByRole("option").first()).toHaveAccessibleName(/^(CALL|PUT) \d+ · 20 Nov( 2026)?$/);
  });
});
