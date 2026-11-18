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

  test("the payoff reads a signed, toned result at each underlying price", async ({ page, isMobile }) => {
    await page.goto("/research?ticker=AAPL&view=options&optionView=payoff");
    const contract = page.getByRole("combobox", { name: "Contract", exact: true });
    await contract.click();
    await contract.fill("CALL 100");
    await page.getByRole("option", { name: /^CALL 100 · / }).click();
    await page.getByRole("button", { name: "Add to analysis" }).click();
    const chart = page.getByRole("group", { name: "Hypothetical expiration P/L" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const { spoken, shown } = reading(page, chart, isMobile);
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
    const picked = page.locator(".mantine-MultiSelect-root").filter({ has: field }).locator(".mantine-Pill-label");
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
