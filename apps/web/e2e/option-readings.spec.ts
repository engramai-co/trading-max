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

  test("the rating distribution lists a period's ratings and folds the rest", async ({ page, isMobile }) => {
    await page.route("**/api/backend/research/AAPL/lens/analyst?**", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { ...json, analyst: { ...json.analyst, recommendations: [
        { period: "0m", strongBuy: 6, buy: 19, hold: 14, sell: 0, strongSell: 2 },
        { period: "-1m", strongBuy: 5, buy: 18, hold: 15, sell: 1, strongSell: 2 },
      ] } } });
    });
    await page.goto("/research?ticker=AAPL&view=analyst&analystView=ratings");
    const chart = page.getByRole("group", { name: "Analyst counts by rating category" });
    await expect(chart).toHaveAttribute("data-tm-chart-ready", "true");
    const { spoken, shown } = reading(page, chart, isMobile);
    await chart.press("End");
    await expect(spoken).toContainText("Current");
    await expect(spoken).toContainText("Strong buy 6");
    await expect(spoken).toContainText("Strong sell 2");
    // A rating no analyst holds is left out.
    await expect(spoken).not.toContainText(/\bSell 0/);
    await expect(shown).toBeVisible();
    await expect(shown.locator(".mx-reading-more")).toHaveText(isMobile ? "2 more" : "1 more");
    await chart.press("Escape");
    await expect(shown).toBeHidden();
  });
});
