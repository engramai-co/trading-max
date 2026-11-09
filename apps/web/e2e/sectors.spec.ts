import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Entirely synthetic market data: invented tickers, weights and moves.
const SECTORS: Array<[string, string, number, number]> = [
  ["45", "Information Technology", 0.31, 0.0145],
  ["40", "Financials", 0.13, -0.0059],
  ["50", "Communication Services", 0.1, 0.0043],
  ["25", "Consumer Discretionary", 0.1, -0.0005],
  ["35", "Health Care", 0.09, -0.0006],
  ["20", "Industrials", 0.08, 0.0012],
  ["30", "Consumer Staples", 0.05, -0.0128],
  ["10", "Energy", 0.03, -0.0002],
  ["55", "Utilities", 0.025, -0.0039],
  ["60", "Real Estate", 0.02, -0.0068],
  ["15", "Materials", 0.02, -0.0073],
];

function fixture(code = "us") {
  const now = Date.now();
  const open = new Date(now - 3 * 3600_000);
  const close = new Date(now + 3.5 * 3600_000);
  const day = open.toISOString().slice(0, 10);
  const times = Array.from({ length: 36 }, (_, index) => new Date(open.getTime() + index * 300_000).toISOString());
  const session = { date: day, open: open.toISOString(), close: close.toISOString(), breakStart: null, breakEnd: null };
  const groups = SECTORS.map(([key, name, weight, change], index) => {
    const members = Array.from({ length: 6 }, (_, member) => ({
      symbol: "SYN" + key + member,
      name: "SYNTHETIC COMPANY " + key + member,
      // The last member has no industry group, so each sector also lists "Other".
      subgroup: member === 5 ? "" : key + (member % 2 ? "20" : "10"),
      change: change + (member - 2.5) * 0.004,
      weight: weight / 6,
      exposureGbp: member === 0 ? 1200 : 0,
      researchTicker: member === 0 ? "SYN" + key + member : null,
    }));
    return {
      key,
      name,
      nameZh: null,
      change,
      weight,
      breadth: { up: change > 0 ? 4 : 2, flat: 0, down: change > 0 ? 2 : 4 },
      memberCount: 6,
      leader: { symbol: members[5].symbol, name: members[5].name, change: members[5].change },
      path: times.map((_, step) => change * Math.sin((step + 1) / 12)),
      ranks: [index + 1, ((index + 3) % 11) + 1, ((index + 5) % 11) + 1, index < 3 ? 1 : 7, index + 1],
      streak: index === 0 ? 2 : 0,
      exposureGbp: 1200,
      subgroups: [
        ...[10, 20].map((suffix) => ({
          key: key + suffix,
          name: suffix === 10 ? "Software & Services" : "Semiconductors & Semiconductor Equipment",
          change: change + (suffix === 10 ? 0.002 : -0.002),
          weight: (weight * 5) / 12,
          breadth: { up: 2, flat: 0, down: 1 },
          memberCount: suffix === 10 ? 3 : 2,
          exposureGbp: suffix === 10 ? 1200 : 0,
        })),
        { key: "", name: "", change, weight: weight / 6, breadth: { up: 1, flat: 0, down: 0 }, memberCount: 1, exposureGbp: 0 },
      ],
      members,
    };
  });
  const market = (code: string, timezone: string) => ({
    market: code,
    calendar: "SYNTH",
    timezone,
    sessions: code === "us" ? [session] : [],
    sessionDate: code === "us" ? day : null,
    complete: false,
    asOf: code === "us" ? times.at(-1) : null,
    fetchedAt: code === "us" ? new Date(now).toISOString() : null,
    exposureGbp: 0,
    lastError: null,
    lastErrorAt: null,
  });
  return {
    market: code,
    markets: [market("us", "UTC"), market("uk", "Europe/London"), market("hk", "Asia/Hong_Kong"), market("kr", "Asia/Seoul")],
    monitor: { enabled: true, phase: "idle", intervalSeconds: 600, nextRunAt: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null },
    board: {
      market: code,
      sessionDate: day,
      complete: false,
      asOf: times.at(-1),
      fetchedAt: new Date(now).toISOString(),
      times,
      rankSessions: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", day],
      memberCount: 66,
      pricedCount: 66,
      source: { universe: "Synthetic 66", fund: "Synthetic fund", fundTicker: "SYN", url: "https://example.invalid", asOf: day, prices: "Synthetic" },
      exposureGbp: 13200,
      exposureBasisGbp: 100000,
      groupings: [{ kind: "gics", groups }],
    },
  };
}

async function open(page: Page) {
  await page.route("**/api/backend/sectors**", async (route) => {
    const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
    // Hong Kong answers slowly, so a switch can be watched mid-flight.
    if (code === "hk") await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ json: fixture(code) });
  });
  await page.goto("/sectors");
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}

test.describe("sector map", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");

  test("opens on the strongest sector and follows pointer and arrow keys", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await open(page);
    const map = page.getByRole("group", { name: /板块地图|sector map/ });
    await expect(map.locator(".mx-sector-block")).toHaveCount(11);
    const selected = map.locator('.mx-sector-block[aria-pressed="true"]');
    await expect(selected).toHaveAttribute("data-key", "45");
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/信息技术|Information Technology/);
    await selected.focus();
    await page.keyboard.press("ArrowRight");
    await expect(map.locator('.mx-sector-block[aria-pressed="true"]')).not.toHaveAttribute("data-key", "45");
    await expect(map.locator(".mx-sector-block:focus")).toHaveAttribute("aria-pressed", "true");
    await map.locator('[data-key="30"]').click();
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/日常消费品|Consumer Staples/);
    await expect(page).toHaveURL(/sector=30/);
    // A tile click opens its industry group in the detail.
    await map.locator('[data-key="45"] [data-subgroup="4510"]').click();
    await expect(page.locator('.mx-sector-subgroup[aria-expanded="true"]')).toHaveCount(1);
    // So does the "Other" tile, whose key is empty.
    await map.locator('[data-key="45"] [data-subgroup=""]').click();
    await expect(page.locator('.mx-sector-subgroup[aria-expanded="true"]')).toHaveText(/其他|Other/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await settle(page);
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  });

  test("a market switch never shows the previous board under the new name", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await open(page);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    await page.getByRole("group", { name: /市场|Market/ }).getByRole("button", { name: /港股|Hong Kong/ }).click();
    await expect(page).toHaveURL(/market=hk/);
    await expect(page.locator(".mx-sector-map")).toHaveCount(0);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /港股|Hong Kong/);
  });

  test("a failed refresh keeps the board on screen and says so", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    let served = 0;
    await page.route("**/api/backend/sectors**", async (route) => {
      served += 1;
      // The first answer arrives; every later refresh fails.
      if (served === 1) await route.fulfill({ json: fixture("us") });
      else await route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
    });
    await page.clock.install();
    await page.goto("/sectors");
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    // Selecting a sector names the market in the URL; the board it came from stays.
    await page.locator('.mx-sector-map [data-key="30"]').click();
    await expect(page).toHaveURL(/market=us/);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    // The next minute's refresh fails (with its one retry); the board stays and the clock says so.
    await page.clock.runFor(65_000);
    await page.clock.runFor(5_000);
    await expect(page.locator(".mx-sectors-clock")).toContainText(/刷新失败|Refresh failed/);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
  });

  test("a rejected market switch keeps the board on screen and offers a retry", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    let hongKongUp = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/backend/sectors**", async (route) => {
      const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
      if (code === "hk" && !hongKongUp) await route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
      else {
        // Hong Kong's recovery is held back so the retry can be watched in flight.
        if (code === "hk") await held;
        await route.fulfill({ json: fixture(code) });
      }
    });
    await page.goto("/sectors");
    const markets = page.getByRole("group", { name: /市场|Market/ });
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    await markets.getByRole("button", { name: /港股|Hong Kong/ }).click();
    const retry = page.locator(".mx-sectors-retry");
    await expect(retry).toBeVisible();
    // The US board stays, under its own name, and the switch says so.
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /美股|US/);
    await expect(markets.getByRole("button", { name: /美股|US/ })).toHaveAttribute("aria-pressed", "true");
    hongKongUp = true;
    await retry.click();
    // While the retry is in flight the fallback stays, and asking again waits for it.
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /美股|US/);
    await expect(page.locator(".mx-sector-block")).toHaveCount(11);
    release();
    await expect(page.locator(".mx-sector-map")).toHaveAttribute("aria-label", /港股|Hong Kong/);
    await expect(retry).toHaveCount(0);
  });

  test("a fallback board ignores the failed market's sector on phones", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.route("**/api/backend/sectors**", async (route) => {
      const code = new URL(route.request().url()).searchParams.get("market") ?? "us";
      if (code === "hk") await route.fulfill({ status: 503, json: { detail: "synthetic outage" } });
      else await route.fulfill({ json: fixture(code) });
    });
    await page.goto("/sectors");
    const rows = page.locator(".mx-sector-list > li");
    await expect(rows).toHaveCount(11);
    // A link into a Hong Kong sector arrives while Hong Kong is unavailable.
    await page.evaluate(() => window.history.pushState(null, "", "/sectors?market=hk&sector=45"));
    await expect(page.locator(".mx-sectors-retry")).toBeVisible();
    // The US list stays, with the market switch, rather than opening a US sector under the link's name.
    await expect(page.locator(".mx-sector-detail")).toHaveCount(0);
    await expect(rows).toHaveCount(11);
    await expect(page.getByRole("group", { name: /市场|Market/ }).getByRole("button", { name: /美股|US/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("phones read a ranked list and open a sector as its own step", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await open(page);
    const rows = page.locator(".mx-sector-list > li");
    await expect(rows).toHaveCount(11);
    await expect(rows.first()).toContainText(/信息技术|Information Technology/);
    await rows.first().getByRole("button").tap();
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/信息技术|Information Technology/);
    await expect(page.locator(".mx-sector-detail h2")).toBeFocused();
    await page.locator(".mx-sector-back").tap();
    await expect(rows).toHaveCount(11);
    await expect(rows.first().getByRole("button")).toBeFocused();
    // Forward reopens the sector, and the page's Back still returns to the list behind it.
    await page.goForward();
    await expect(page.locator(".mx-sector-detail h2")).toHaveText(/信息技术|Information Technology/);
    await page.locator(".mx-sector-back").tap();
    await expect(rows).toHaveCount(11);
    await expect(page).not.toHaveURL(/sector=/);
    // The browser's Back also returns focus to the row that opened the sector.
    await rows.nth(2).getByRole("button").tap();
    await expect(page.locator(".mx-sector-detail h2")).toBeFocused();
    await page.goBack();
    await expect(rows.nth(2).getByRole("button")).toBeFocused();
    // The focus target is spent: switching markets afterwards moves focus nowhere.
    await page.getByRole("group", { name: /市场|Market/ }).getByRole("button", { name: /英股|UK/ }).tap();
    await expect(page.locator(".mx-sector-list button:focus")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.locator(".mx-sector-list button").evaluateAll((buttons) =>
      buttons.every((button) => button.getBoundingClientRect().height >= 44))).toBe(true);
  });
});
