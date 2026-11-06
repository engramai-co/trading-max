import { expect, test, type Page } from "@playwright/test";
import { pnlsAt, prepareHistory } from "../lib/portfolio/prepared";
import type { NavPoint } from "../lib/types";

/**
 * Phones: the overview's day drivers wrap at every phone width and its statistics share rows, so each control needs
 * a 44px hit area that never meets another control's and each figure needs room of its own. Synthetic half-hourly
 * valuations of account A over five weekdays.
 */
const days = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"];
/** With estimated, one of today's valuations is a reconstruction, so an estimate tag sits beside today's figure. */
const nav = (estimated: boolean) => days.flatMap((day, index) => Array.from({ length: 15 }, (_, step): NavPoint => {
  const value = 50_000 + index * 400 + step * 40;
  return {
    date: `${day}T${String(8 + Math.floor(step / 2)).padStart(2, "0")}:${step % 2 ? "30" : "00"}:00Z`,
    intraday: true, valuationSource: estimated && index === days.length - 1 && step === 7 ? "reconstructed" : "broker",
    flowStatus: "verified",
    invest: value, isa: null, total: value, household: value, cfd: null,
    investNetContributionsGbp: 40_000, totalNetContributionsGbp: 40_000,
    investTwr: null, isaTwr: null, totalTwr: null,
    investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null,
  };
}));
const brokerAsOf = nav(false).at(-1)!.date;
const prepared = (range: "1D" | "1W", estimated = false) => prepareHistory(
  { runId: "synthetic-phone", dataRevision: "synthetic", brokerAsOf, intradayNav: nav(estimated) },
  { range, scope: "invest" },
);
// Three named positions, the rest and an unattributed share: four entries and a tag, more than a phone line holds.
const contributions = [
  { ticker: "NVDA", name: "Synthetic Nvidia", contributionGbp: -1234.56 },
  { ticker: "EQGB", name: "Synthetic Nasdaq ETF", contributionGbp: 845.12 },
  { ticker: "MU", name: "Synthetic Micron", contributionGbp: 321.09 },
  { ticker: "AAPL", name: "Synthetic Apple", contributionGbp: 12.34 },
];
const attribution = (range: "1D" | "1W") => {
  const { points, endDay } = prepared(range).chart.history;
  return { day: endDay!, accounts: { A: { since: points[0].date, asOf: points.at(-1)!.date, contributions } } };
};
/**
 * Large values: seven- and eight-figure statistics that cannot share a 320px row. One researched holding fills the
 * holdings research panel without crossing an attention threshold.
 */
const lens = (large: boolean) => ({
  runId: "synthetic-phone", brokerAsOf,
  holdings: [{
    ticker: "NVDA", name: "Synthetic Nvidia", account: "A",
    currentValueGbp: 10_000, allocationPct: 18, costGbp: 8_000, pnlGbp: 2_000, pnlPct: 0.25,
  }],
  technical: [{ ticker: "NVDA", score: 55, rsi: 50 }],
  valuations: [{ ticker: "NVDA", ev5Upside: 0.15 }],
  totalValueGbp: large ? 12_345_678.9 : 56_160, totalCashGbp: large ? 12_345_678.9 : 1_000,
  totalUnrealizedPnlGbp: large ? -1_234_567.89 : 5_000,
  accounts: [{
    code: "A", isInvestable: true, totalValueGbp: large ? 12_345_678.9 : 56_160,
    cashGbp: large ? 12_345_678.9 : 1_000, unrealizedPnlGbp: large ? -1_234_567.89 : 5_000,
  }],
  dayAttribution: attribution("1D"),
  windowAttribution: { ...attribution("1W"), startDay: days[0] },
});
const failing = { checkedAt: brokerAsOf, issues: [{ scope: "accounts", consecutiveFailures: 3, failingSince: "2026-11-03T06:00:00Z" }] };

async function open(page: Page, locale: "zh" | "en", { estimated = false, large = false } = {}) {
  await page.clock.install({ time: new Date(brokerAsOf) });
  await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
  // No write leaves the page, and every backend request is answered here.
  await page.route("**/*", (route) => route.request().method() === "GET" ? route.fallback() : route.abort());
  await page.route("**/api/backend/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/dashboard/history")) {
      const history = prepared(url.searchParams.get("range") === "1W" ? "1W" : "1D", estimated);
      const openings = url.searchParams.getAll("opening");
      return route.fulfill({ json: openings.length ? { ...history.chart, openings: pnlsAt(history, openings) } : history.chart });
    }
    const json = url.pathname.includes("/dashboard/lens/overview") ? lens(large)
      : url.pathname.endsWith("/refresh/attention") ? failing
        : url.pathname.endsWith("/profile") ? { accountLabels: {} } : {};
    return route.fulfill({ json });
  });
  await page.route("**/api/company-logo/**", (route) => route.fulfill({ status: 204 }));
  await page.goto("/?scope=invest&range=1W");
  await expect(page.locator(".mx-overview-statistics .mx-day-drivers a")).toHaveCount(3);
  await expect(page.locator(".mx-overview-history .mx-day-drivers a")).toHaveCount(3);
  await expect(page.locator(".mx-attention a")).toHaveCount(1);
  await expect(page.locator(".mx-overview-research .mx-row-link")).toHaveCount(1);
  if (estimated) await expect(page.locator(".mx-overview-statistics .mx-number .mx-tag-help")).toHaveCount(1);
}

async function resize(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => innerWidth)).toBe(width);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `overflow at ${width}px`).toBeLessThanOrEqual(0);
}

/** Each control in main with the area a tap reaches: its box and positioned pseudo-elements, cut by clipping ancestors. */
function hitAreas() {
  type Box = { left: number; top: number; right: number; bottom: number };
  const cut = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  });
  const inner = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      left: r.left + parseFloat(s.borderLeftWidth), top: r.top + parseFloat(s.borderTopWidth),
      right: r.right - parseFloat(s.borderRightWidth), bottom: r.bottom - parseFloat(s.borderBottomWidth),
    };
  };
  const clip = (el: Element, box: Box) => {
    let out = box;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") out = cut(out, inner(a));
    }
    return out;
  };
  const selector = "main :is(a[href], button, [role=button], [role=tab], summary, input:not([type=hidden]), select)";
  // A closed disclosure's content keeps layout boxes in some engines but cannot be reached; its summary can.
  const reachable = (el: Element) => {
    const closed = el.closest("details:not([open])");
    return !closed || el.closest("summary")?.parentElement === closed;
  };
  return [...document.querySelectorAll(selector)]
    .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only")
      && reachable(el))
    .map((el, index) => {
      el.setAttribute("data-hit-index", String(index));
      const r = el.getBoundingClientRect();
      let box: Box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      if (getComputedStyle(el).position !== "static") {
        for (const which of ["::before", "::after"]) {
          const p = getComputedStyle(el, which);
          if (p.content === "none" || p.content === "normal" || p.position !== "absolute" || p.pointerEvents === "none") continue;
          const own = inner(el);
          const extra = {
            left: own.left + parseFloat(p.left), top: own.top + parseFloat(p.top),
            right: own.right - parseFloat(p.right), bottom: own.bottom - parseFloat(p.bottom),
          };
          box = {
            left: Math.min(box.left, extra.left), top: Math.min(box.top, extra.top),
            right: Math.max(box.right, extra.right), bottom: Math.max(box.bottom, extra.bottom),
          };
        }
      }
      const area = clip(el, box);
      const parent = el.parentElement?.closest("[data-hit-index]");
      return {
        name: el.tagName.toLowerCase() + " " + (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 32),
        index, parent: parent ? Number(parent.getAttribute("data-hit-index")) : null,
        driver: Boolean(el.closest(".mx-day-drivers")), ...area,
      };
    });
}

/** The statistics' cells and where each figure's text ends, with the lead figure against its panel. */
function statistics() {
  const textRight = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().right;
  };
  const cells = [...document.querySelectorAll(".mx-overview-statistics > .mx-metric")].map((cell) => {
    const box = cell.getBoundingClientRect();
    const figure = cell.querySelector(".mx-number")!;
    return {
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      figureRight: textRight(figure), figureBottom: figure.getBoundingClientRect().bottom,
    };
  });
  const lead = document.querySelector(".mx-overview-totals > .mx-metric-large .mx-number")!;
  const summary = lead.closest(".mx-summary")!;
  const room = summary.getBoundingClientRect().right - parseFloat(getComputedStyle(summary).paddingRight);
  return { cells, leadRight: textRight(lead), room };
}

test.describe("overview on phones", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires an isolated local web build.");

  for (const [locale, estimated] of [["zh", false], ["en", false], ["zh", true]] as const) {
    test(`controls keep their own 44px hit areas at every phone width (${locale}${estimated ? ", estimated today" : ""})`, async ({ page, isMobile }) => {
      test.skip(!isMobile, "The phone layout");
      await open(page, locale, { estimated });
      for (const width of [320, 360, 375, 390]) {
        await resize(page, width);
        const areas = await page.evaluate(hitAreas);
        const small = areas.filter((a) => a.driver && (a.right - a.left < 43.5 || a.bottom - a.top < 43.5))
          .map((a) => `${a.name} ${Math.round(a.right - a.left)}x${Math.round(a.bottom - a.top)}`);
        expect.soft(small, `driver hit areas under 44px at ${width}px`).toEqual([]);
        const meeting: string[] = [];
        for (const a of areas) {
          for (const b of areas) {
            if (b.index <= a.index || a.parent === b.index || b.parent === a.index) continue;
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w > 0.5 && h > 0.5) meeting.push(`${a.name} × ${b.name}: ${Math.round(w)}x${Math.round(h)}`);
          }
        }
        expect.soft(meeting, `hit areas that meet another control's at ${width}px`).toEqual([]);
      }
    });
  }

  for (const locale of ["zh", "en"] as const) {
    test(`each statistic keeps its figure in its own cell (${locale})`, async ({ page, isMobile }) => {
      test.skip(!isMobile, "The phone layout");
      await open(page, locale, { large: true });
      for (const width of [320, 360, 375, 390]) {
        await resize(page, width);
        const { cells, leadRight, room } = await page.evaluate(statistics);
        expect.soft(leadRight, `the lead figure runs past its panel at ${width}px`).toBeLessThanOrEqual(room + 0.5);
        cells.forEach((cell, i) => {
          expect.soft(cell.figureRight, `statistic ${i} runs past its cell at ${width}px`).toBeLessThanOrEqual(cell.right + 0.5);
          for (const other of cells.slice(i + 1)) {
            const w = Math.min(cell.right, other.right) - Math.max(cell.left, other.left);
            const h = Math.min(cell.bottom, other.bottom) - Math.max(cell.top, other.top);
            expect.soft(w > 0.5 && h > 0.5, `statistics overlap at ${width}px`).toBe(false);
          }
        });
      }
    });
  }

  test("ordinary statistics share a row in two equal columns", async ({ page, isMobile }) => {
    test.skip(!isMobile, "The phone layout");
    await open(page, "zh");
    for (const width of [375, 390]) {
      await resize(page, width);
      const [pnl, cash] = (await page.evaluate(statistics)).cells;
      expect(cash.left, `one row at ${width}px`).toBeGreaterThan(pnl.right);
      expect(Math.abs(pnl.right - pnl.left - (cash.right - cash.left)), `equal columns at ${width}px`).toBeLessThan(1);
      expect(Math.abs(pnl.figureBottom - cash.figureBottom), `one baseline at ${width}px`).toBeLessThan(1);
    }
  });
});
