import { expect, test, type Page } from "@playwright/test";
import { portfolioRange } from "../lib/portfolio/history";
import { pnlsAt, prepareHistory } from "../lib/portfolio/prepared";
import { snapshotCacheStorageKey } from "../lib/snapshot-cache";
import type { NavPoint } from "../lib/types";

const friday = "2026-11-20";
const saturday = "2026-11-21T12:00:00Z";
const runId = "synthetic-overview-geometry";
const nav: NavPoint[] = ["2026-11-19", friday].map((date, index) => ({
  date, total: 2000 + index * 50, totalNetContributionsGbp: 2000,
  invest: null, isa: null, household: null, cfd: null, cfdProxyDrawdown: null,
  totalTwr: null, investTwr: null, isaTwr: null,
  totalDrawdown: null, investDrawdown: null, isaDrawdown: null,
  flowStatus: "daily_official", valuationSource: "broker", intraday: false,
}));
const holdings = (count: number, mixedQuoteDates = false) => Array.from({ length: count }, (_, index) => ({
  account: "A", ticker: "SYN" + index, name: "Synthetic holding " + index,
  currentValueGbp: count + 79 - index, costGbp: count + 71, pnlGbp: 8 - index, priceCurrency: "GBP",
  ...(mixedQuoteDates && { dayChangeDate: index % 10 === 0 ? "2026-11-19" : friday, dayChangeGbp: 1, dayChangePct: 0.01 }),
}));
const lens = {
  view: "overview", generatedAt: saturday, researchAsOf: "",
  runId, brokerAsOf: friday + "T21:00:00Z", dataRevision: runId, nav,
  intradayNav: ["19", "20", "21"].map((hour, index) => ({
    ...nav[1], date: `${friday}T${hour}:00:00Z`, total: 2030 + index * 10, intraday: true,
  })),
  accounts: [{ code: "A", isInvestable: true, totalValueGbp: 2050 }],
  totalValueGbp: 2050, totalCashGbp: 100, totalUnrealizedPnlGbp: 50,
  holdings: holdings(20),
};

async function mockOverview(page: Page, controls: {
  beforeLens?: () => Promise<void>;
  beforeHistory?: () => Promise<void>;
  beforeProfile?: () => Promise<void>;
  lensFails?: () => boolean;
  noAccounts?: () => boolean;
  assistantEnabled?: () => boolean;
  longRangeFails?: () => boolean;
  holdingCount?: () => number;
  mixedQuoteDates?: boolean;
  emptyHistory?: boolean;
  warning?: boolean;
  fullPage?: boolean;
  beforeSupportingReads?: () => Promise<void>;
} = {}) {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.clock.setFixedTime(new Date(saturday));
  await page.route("**/api/backend/**", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname.endsWith("/dashboard/lens/overview")) {
      await controls.beforeLens?.();
      if (controls.noAccounts?.()) return route.fulfill({ json: { ...lens, accounts: [], holdings: [], totalValueGbp: null } });
      const count = controls.holdingCount?.() ?? lens.holdings.length;
      return route.fulfill(controls.lensFails?.() ? { status: 503, json: {} } : { json: { ...lens,
        holdings: controls.fullPage ? holdings(13, true).map((row, index) => ({ ...row, dayChangeDate: friday, isFund: index >= 8 }))
          : count > lens.holdings.length ? holdings(count, controls.mixedQuoteDates) : lens.holdings.slice(0, count),
        ...(controls.fullPage && { dayAttribution: { day: friday, accounts: {
          A: { since: lens.intradayNav[0].date, asOf: lens.brokerAsOf, contributions: [
            { ticker: "SYN0", name: "Synthetic stock", contributionGbp: 12 },
            { ticker: "SYN8", name: "Synthetic fund", contributionGbp: 8 },
          ] },
          B: { since: lens.intradayNav[0].date, asOf: lens.brokerAsOf, contributions: [] },
        } } }),
      } });
    }
    if (pathname.endsWith("/dashboard/history")) {
      const range = portfolioRange(searchParams.get("range"), "1D");
      await controls.beforeHistory?.();
      if (range === "3M" && controls.longRangeFails?.()) return route.fulfill({ status: 503, json: {} });
      const input = controls.emptyHistory ? { ...lens, nav: [], intradayNav: [] } : lens;
      const history = prepareHistory(input, { range, scope: "total" });
      const openings = searchParams.getAll("opening");
      return route.fulfill({ json: openings.length ? { ...history.chart, openings: pnlsAt(history, openings) } : history.chart });
    }
    if (pathname.endsWith("/profile")) {
      await controls.beforeProfile?.();
      return route.fulfill({ json: { profileId: "local", accountLabels: {}, assistantEnabled: controls.assistantEnabled?.() ?? controls.fullPage } });
    }
    if (controls.fullPage && pathname.endsWith("/sectors")) {
      await controls.beforeSupportingReads?.();
      return route.fulfill({ json: {
        markets: [{ market: "us", timezone: "America/New_York", sessions: [], asOf: lens.brokerAsOf }],
        board: { market: "us", asOf: lens.brokerAsOf, source: {}, groupings: [{ kind: "gics",
          groups: Array.from({ length: 11 }, (_, i) => ({
            key: String((i + 2) * 5), name: "Synthetic sector " + i, change: 0.01, weight: 0.15 - i * 0.01,
          })),
        }] },
      } });
    }
    if (controls.fullPage && pathname.endsWith("/assistant/status")) return route.fulfill({ json: { ready: true, code: null } });
    if (controls.fullPage && pathname.endsWith("/assistant/roles/daily/reading")) {
      await controls.beforeSupportingReads?.();
      return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ type: "empty" }) + "\n" });
    }
    const json = pathname.endsWith("/health") ? { status: "ok", latestRunId: runId }
      : pathname.endsWith("/refresh/attention") && controls.warning !== false ? { issues: [{
        scope: "accounts", consecutiveFailures: 3, failingSince: friday + "T20:00:00Z",
      }] }
      : {};
    return route.fulfill({ json });
  });
}

function layoutKeys(page: Page) {
  return page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith("mx-overview-layout-") && !key.endsWith(":generation")));
}

async function mockWorkspaceScope(page: Page, workspace: string) {
  await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
  // Swap the server-delivered opaque scope, while keeping the same origin and profile response.
  await page.route(url => url.pathname === "/", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const scope = /\\"scope\\":\\"([a-f0-9]{64})\\"/.exec(body)?.[1];
    expect(scope, "server-delivered snapshot scope").toBeDefined();
    await route.fulfill({ response, body: body.replaceAll(scope!, workspace.repeat(64)) });
  });
}

async function holdHydration(page: Page) {
  const gate = Promise.withResolvers<void>();
  let scriptHeld = false;
  await page.route(url => url.pathname.includes("/_next/static/") && url.pathname.endsWith(".js"), async route => {
    scriptHeld = true;
    await gate.promise;
    await route.continue();
  });
  return {
    release: gate.resolve,
    waitForScripts: () => expect.poll(() => scriptHeld).toBe(true),
  };
}

test.describe("Overview loading and recovery", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local build.");

  test("the whole 1D Overview keeps its geometry on reload and in a fresh tab", async ({ page, context, isMobile }) => {
    const viewport = isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const route = "/?range=1D";
    const selectors = {
      summary: ".mx-overview-portfolio",
      history: ".mx-overview-history",
      plot: ".mx-overview-history :is(.mx-plot, .mx-loading-chart)",
      sectors: ".mx-overview-sectors",
      holdings: ".mx-overview-holdings",
      brief: ".mx-overview-brief, .mx-digest",
    };
    const measure = (tab: Page) => tab.evaluate(selectors => ({
      panels: Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        return [name, bounds ? { top: bounds.top + scrollY, height: bounds.height } : { top: 0, height: 0 }];
      })),
      lead: document.querySelector(".mx-overview-lead")?.getBoundingClientRect().height,
      balances: document.querySelector(".mx-overview-totals, .mx-loading-summary")?.getBoundingClientRect().height,
      document: document.documentElement.scrollHeight,
    }), selectors);
    let supportingReads: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    const setup = async (tab: Page) => {
      await tab.setViewportSize(viewport);
      await tab.emulateMedia({ reducedMotion: "reduce" });
      await mockOverview(tab, { fullPage: true, warning: false, beforeSupportingReads: async () => supportingReads?.promise });
      await tab.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    };
    const loaded = async (tab: Page) => {
      await expect(tab.locator(".mx-ledger:not(.mx-ledger-pending)")).toBeVisible();
      await expect(tab.locator(".mx-overview-history .mx-plot")).toBeVisible();
      await expect(tab.locator(isMobile ? ".mx-overview-sector-grid a" : ".mx-overview-sector-map a")).toHaveCount(11);
      await expect(tab.locator(".mx-digest:not([data-waiting])")).toBeVisible();
      if (isMobile) await expect(tab.locator(".mx-overview-lead .mx-day-drivers a")).toHaveCount(2);
      await tab.evaluate(() => document.fonts.ready);
      await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return measure(tab);
    };
    const verify = async (tab: Page, visit: () => Promise<unknown>, label: string) => {
      const warnings: string[] = [];
      tab.on("pageerror", error => {
        if (/hydrat|Minified React error #(418|423|425)/i.test(error.message)) warnings.push(error.message);
      });
      tab.on("console", message => {
        if (/hydrat|Minified React error #(418|425)/i.test(message.text())) warnings.push(message.text());
      });
      const hydration = await holdHydration(tab);
      supportingReads = Promise.withResolvers<void>();
      let before;
      let hydrated;
      try {
        try {
          await visit();
          await hydration.waitForScripts();
          await expect(tab.locator(".mx-overview-read")).toHaveAttribute("data-layout-bootstrap", "true");
          await expect(tab.locator(".mx-ledger-pending")).toHaveCSS("display", "grid");
          before = await measure(tab);
          await expect.soft(tab.locator(".mx-ledger-pending"), label).toHaveCSS("--mx-ledger-rows", "13", { timeout: 1_000 });
        } finally {
          hydration.release();
        }
        await expect(tab.locator(".mx-ledger:not(.mx-ledger-pending)")).toBeVisible();
        await expect(tab.locator(".mx-overview-history .mx-plot")).toBeVisible();
        await expect(tab.locator(".mx-overview-sectors .mx-loading")).toBeVisible();
        await expect(tab.locator(".mx-digest")).toBeVisible();
        hydrated = await measure(tab);
      } finally {
        supportingReads.resolve();
      }
      const after = await loaded(tab);
      await test.info().attach(label + " geometry", { body: JSON.stringify({ before, hydrated, after }), contentType: "application/json" });
      for (const [phase, snapshot] of [["pre-hydration", before], ["hydrated", hydrated]] as const) {
        const measurement = label + " " + phase;
        for (const [name, rect] of Object.entries(snapshot.panels)) {
          const now = after.panels[name];
          expect.soft(Math.abs(rect.top - now.top), measurement + " " + name + " top").toBeLessThanOrEqual(2);
          expect.soft(Math.abs(rect.height - now.height), measurement + " " + name + " height").toBeLessThanOrEqual(2);
        }
        expect.soft(Math.abs(snapshot.document - after.document), measurement + " document height").toBeLessThanOrEqual(2);
      }
      expect(warnings).toEqual([]);
    };
    await setup(page);
    await page.goto(route);
    await loaded(page);
    await expect.poll(() => layoutKeys(page)).toHaveLength(1);
    await verify(page, () => page.reload({ waitUntil: "commit" }), "same-tab reload");

    const fresh = await context.newPage();
    try {
      await setup(fresh);
      await verify(fresh, () => fresh.goto(route, { waitUntil: "commit" }), "fresh tab");
    } finally {
      await fresh.close();
    }

    // Simulate the pre-1.82 record in an existing workspace. Only the wide chart row was shorter.
    const [key] = await layoutKeys(page);
    await page.evaluate(({ key, isMobile }) => {
      const entry = JSON.parse(localStorage.getItem(key)!);
      delete entry.reading.periodFigure;
      if (!isMobile) {
        entry.reading.history -= 3;
        entry.reading.plotTop -= 3;
        entry.sectors -= 3;
      }
      localStorage.setItem(key, JSON.stringify(entry));
    }, { key, isMobile });
    await verify(page, () => page.reload({ waitUntil: "commit" }), "1.81 cached layout");
  });

  test("cold Overview reserves the loaded period figure height without a saved layout", async ({ page, isMobile }) => {
    test.skip(isMobile, "The period figure is displayed only in the wide layout.");
    const history = Promise.withResolvers<void>();
    await mockOverview(page, { beforeHistory: () => history.promise });
    const panel = page.locator(".mx-overview-history");
    const pending = panel.locator(".mx-overview-history-pending .mx-period-figure");
    const loaded = panel.locator(".mx-data-body .mx-period-figure");
    const height = (figure: typeof pending) => figure.evaluate(node => node.getBoundingClientRect().height);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    let before;
    try {
      await expect(pending).toBeVisible();
      expect(await layoutKeys(page)).toHaveLength(0);
      await page.evaluate(() => document.fonts.ready);
      before = await height(pending);
    } finally {
      history.resolve();
    }
    await expect(loaded.getByRole("link", { name: "View performance" })).toBeVisible();
    expect(await height(loaded)).toBe(before);
  });

  test("cold Overview reserves the whole stale-data warning without a saved layout", async ({ page, isMobile }) => {
    test.skip(isMobile, "The narrow layout has its own summary reservation.");
    const lensRead = Promise.withResolvers<void>();
    await mockOverview(page, { beforeLens: () => lensRead.promise, warning: false });
    const placeholder = page.locator(".mx-overview-attention-placeholder");
    const warning = page.locator(".mx-attention");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    let reserved;
    try {
      await expect(placeholder).toBeVisible();
      expect(await layoutKeys(page)).toHaveLength(0);
      await page.evaluate(() => document.fonts.ready);
      reserved = await placeholder.evaluate(node => node.getBoundingClientRect().height);
    } finally {
      lensRead.resolve();
    }
    await expect(warning.getByRole("link", { name: "No account update for 15 hours" })).toBeVisible();
    const loaded = await warning.evaluate(node => node.getBoundingClientRect().height + parseFloat(getComputedStyle(node).marginTop));
    expect(reserved).toBe(loaded);
  });

  test("known holdings reserve the same geometry and scroll with the page", async ({ page, isMobile }) => {
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const summary = Promise.withResolvers<void>();
    const profile = Promise.withResolvers<void>();
    let reloading = false;
    let history: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    let holdingCount = 20;
    await mockOverview(page, { beforeLens: async () => { if (reloading) await summary.promise; },
      beforeProfile: async () => { if (reloading) await profile.promise; },
      beforeHistory: async () => history?.promise, holdingCount: () => holdingCount });
    await page.goto("/");
    const chartPanel = page.locator(".mx-overview-history");
    const ledger = page.locator(".mx-overview-holdings");
    const last = ledger.getByRole("link", { name: /SYN19/ });
    const loadedPlot = chartPanel.locator(".mx-plot");
    const selectors = [".mx-overview-portfolio", ".mx-overview-history", ".mx-overview-sectors", ".mx-overview-holdings"];
    const measure = (plot: string) => page.evaluate(({ selectors, plot }) => [...selectors, plot].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { y: box.y + scrollY, height: box.height };
    }), { selectors, plot });
    const finished = () => expect(chartPanel.locator("[data-tm-chart-ready=true]")).toBeVisible();
    await finished();
    await page.evaluate(() => document.fonts.ready);
    await expect(last).toHaveCount(1);
    await last.evaluate(node => window.scrollTo(0, node.getBoundingClientRect().top + scrollY - innerHeight / 2));
    await expect(last).toBeInViewport();
    expect(await ledger.locator(".mx-ledger").evaluate(node => [...node.querySelectorAll("*")].some(child => {
      const overflow = getComputedStyle(child).overflowY;
      return (overflow === "auto" || overflow === "scroll") && child.scrollHeight > child.clientHeight;
    }))).toBe(false);
    await expect.poll(() => layoutKeys(page)).not.toHaveLength(0);
    const body = ledger.locator(".mx-ledger");
    const savedHeight = await body.evaluate(element => element.getBoundingClientRect().height);
    const hydrationIssues: string[] = [];
    const hydrationMessage = (message: string) => {
      if (/hydrat|did not match|Minified React error #(?:418|423|425)/i.test(message)) hydrationIssues.push(message);
    };
    page.on("console", message => {
      if (message.type() === "error" || message.type() === "warning") hydrationMessage(message.text());
    });
    page.on("pageerror", error => hydrationMessage(error.message));
    const hydration = await holdHydration(page);

    // Keep the SSR document on screen first, then hold the data while React hydrates.
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    reloading = true;
    history = Promise.withResolvers<void>();
    const pending = ledger.locator(".mx-ledger-pending");
    await page.reload({ waitUntil: "commit" });
    let beforeHydration, cold, waiting;
    try {
      await hydration.waitForScripts();
      await expect(pending).toHaveCSS("--mx-ledger-rows", "20");
      expect(await pending.evaluate(element => element.getBoundingClientRect().height)).toBe(savedHeight);
      // WebKit can defer fonts.ready until the blocked scripts finish. Wait for paint without waiting for them.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      beforeHydration = await measure(".mx-overview-history .mx-loading-chart");
      const lensRequested = page.waitForRequest(request => request.url().includes("/dashboard/lens/overview?"));
      hydration.release();
      await lensRequested;
      await expect(ledger.locator(".mx-ledger-pending[data-measured]")).toBeVisible();
      await expect(page.locator(".mx-overview-sectors .mx-empty")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      cold = await measure(".mx-overview-history .mx-loading-chart");
      const requested = page.waitForRequest(request => request.url().includes("/dashboard/history?"));
      summary.resolve();
      await requested;
      await expect(ledger.locator(".mx-ledger-pending[data-measured]")).toBeVisible();
      waiting = await measure(".mx-overview-history .mx-loading-chart");
    } finally {
      hydration.release();
      summary.resolve();
      history.resolve();
      profile.resolve();
    }
    await finished();
    await expect(loadedPlot).toBeVisible();
    const loaded = await measure(".mx-overview-history .mx-plot");
    await test.info().attach("overview-geometry", { body: JSON.stringify({ selectors, beforeHydration, cold, waiting, loaded }), contentType: "application/json" });
    const scale = await page.evaluate(() => devicePixelRatio);
    expect(Math.round(beforeHydration[3].y * scale), "Holdings top through hydration").toBe(Math.round(cold[3].y * scale));
    expect(beforeHydration[3].height, "Holdings height through hydration").toBe(cold[3].height);
    expect(beforeHydration[3], "Holdings from first paint to loaded").toEqual(loaded[3]);
    expect(hydrationIssues).toEqual([]);
    for (const before of [cold, waiting]) {
      before.forEach((rect, index) => {
        const label = selectors[index] ?? "P&L plot";
        expect(Math.abs(rect.y - loaded[index].y), label + " top").toBeLessThanOrEqual(1);
        expect(Math.abs(rect.height - loaded[index].height), label + " height").toBeLessThanOrEqual(1);
      });
    }

    // When a different snapshot size becomes known, its rows replace the cached reservation immediately.
    holdingCount = 4;
    history = Promise.withResolvers<void>();
    await page.reload();
    try {
      await expect(ledger.locator(".mx-ledger-pending")).toHaveCSS("--mx-ledger-rows", "4");
      await expect(ledger.locator(".mx-ledger-pending")).not.toHaveAttribute("data-measured");
    } finally {
      history.resolve();
    }
    await finished();
    await expect(last).toHaveCount(0);
  });

  const ledgerSizes = [[320, false], [320, true], [390, false], [390, true], [1440, false], [1440, true]] as const;
  for (const [width, doubleText] of ledgerSizes) {
    test("240 holdings reserve their height on reload at " + width + "px with " + (doubleText ? "200%" : "100%") + " text", async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (doubleText) {
        // Simulate enlarged text in both engines, including the phone's pixel-based type tokens.
        await page.addInitScript(() => {
          const apply = () => {
            const root = document.documentElement;
            if (!root) return false;
            root.style.fontSize = "200%";
            root.style.setProperty("--mx-text-body", "26px");
            root.style.setProperty("--mx-text-label", "24px");
            return true;
          };
          if (!apply()) new MutationObserver((_, observer) => {
            if (apply()) observer.disconnect();
          }).observe(document, { childList: true });
        });
      }
      let ready: ReturnType<typeof Promise.withResolvers<void>> | undefined;
      await mockOverview(page, {
        holdingCount: () => 240,
        mixedQuoteDates: true,
        beforeLens: async () => ready?.promise,
      });
      await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
      await page.goto("/");
      const overview = page.locator(".mx-overview-read");
      const ledger = overview.locator(".mx-overview-holdings");
      const pending = ledger.locator(".mx-ledger-pending");
      const loaded = ledger.locator(".mx-ledger:not(.mx-ledger-pending)");
      const phone = width < 768;
      const items = ledger.locator(phone ? ".mx-ledger-list .mx-ledger-item" : ".mx-ledger-table .mx-ledger-row");
      const last = items.getByRole("link", { name: /SYN239/ });
      const height = (locator: typeof loaded) => locator.evaluate(element => element.getBoundingClientRect().height);
      await expect(items).toHaveCount(240);
      await expect(items.locator(".mx-tag-warn").filter({ hasText: /^19 Nov$/ })).toHaveCount(24);
      await expect(last).toBeVisible();
      if (phone) await expect(items.first().locator("dd").first()).toHaveCSS("font-size", doubleText ? "26px" : "13px");
      await page.evaluate(() => document.fonts.ready);
      const loadedHeight = await height(loaded);
      if (phone) expect(loadedHeight).toBeGreaterThan(20_000);
      const hydrationIssues: string[] = [];
      const hydrationMessage = (message: string) => {
        if (/hydrat|did not match|Minified React error #(?:418|423|425)/i.test(message)) hydrationIssues.push(message);
      };
      page.on("pageerror", error => hydrationMessage(error.message));
      page.on("console", message => {
        if (message.type() === "error" || message.type() === "warning") hydrationMessage(message.text());
      });
      for (const invalidHeight of [false, true]) {
        if (invalidHeight) {
          const [key] = await layoutKeys(page);
          const rows = await page.evaluate(key => {
            const reservation = JSON.parse(localStorage.getItem(key)!);
            localStorage.setItem(key, JSON.stringify({ ...reservation, ledger: 500_000 }));
            return reservation.rows;
          }, key);
          expect(rows).toEqual({ stocks: 240, funds: 0, dateTagged: 24 });
        }
        const hydration = await holdHydration(page);
        ready = Promise.withResolvers<void>();
        try {
          await page.reload({ waitUntil: "commit" });
          await hydration.waitForScripts();
          await expect(overview).toHaveAttribute("data-layout-bootstrap", "true");
          await expect(pending).toHaveCSS("--mx-ledger-rows", "240");
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const firstPaint = await height(pending);
          expect(Math.abs(firstPaint - loadedHeight), "first paint height difference").toBeLessThanOrEqual(invalidHeight ? 2 : 0);

          hydration.release();
          await expect(overview).not.toHaveAttribute("data-layout-bootstrap");
          if (invalidHeight) await expect(pending).not.toHaveAttribute("data-measured");
          else await expect(pending).toHaveAttribute("data-measured", "true");
          await expect(pending).toHaveCSS("--mx-ledger-rows", "240");
          const hydrated = await height(pending);
          expect(Math.abs(hydrated - loadedHeight), "hydrated height difference").toBeLessThanOrEqual(invalidHeight ? 2 : 0);
          await test.info().attach(invalidHeight ? "count-fallback" : "measured-reservation", {
            body: JSON.stringify({ firstPaint, hydrated, loadedHeight }), contentType: "application/json",
          });
        } finally {
          hydration.release();
          ready.resolve();
        }
        await expect(last).toBeVisible();
        expect(await height(loaded)).toBe(loadedHeight);
      }
      expect(hydrationIssues).toEqual([]);
    });
  }

  test("a dated ledger remeasures its reservation at a narrower width", async ({ page, isMobile }) => {
    test.skip(isMobile, "Two widths in the desktop cache bucket");
    await page.setViewportSize({ width: 1440, height: 900 });
    let hold = false;
    const waiting = Promise.withResolvers<void>();
    await mockOverview(page, { holdingCount: () => 40, mixedQuoteDates: true,
      beforeLens: () => hold ? waiting.promise : Promise.resolve() });
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    await page.goto("/");
    const loaded = page.locator(".mx-overview-holdings .mx-ledger:not(.mx-ledger-pending)");
    await expect(loaded.getByRole("link", { name: /SYN39/ })).toBeVisible();
    await expect.poll(() => layoutKeys(page)).toHaveLength(1);
    const wide = await loaded.evaluate(node => node.getBoundingClientRect().height);
    await page.setViewportSize({ width: 1280, height: 900 });
    const narrow = await loaded.evaluate(node => node.getBoundingClientRect().height);
    expect(narrow - wide).toBeGreaterThan(20);
    // Preserve the first visit's measurement while the window changes.
    await page.goto("/holdings");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(loaded.getByRole("link", { name: /SYN39/ })).toBeVisible();
    const [key] = await layoutKeys(page);
    await expect.poll(() => page.evaluate(name => JSON.parse(localStorage.getItem(name) ?? "{}").ledger, key)).toBe(wide);
    hold = true;
    const hydration = await holdHydration(page);
    try {
      // Change the viewport when no Overview layout writer is mounted.
      await page.goto("/holdings", { waitUntil: "commit" });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/", { waitUntil: "commit" });
      await hydration.waitForScripts();
      const pending = page.locator(".mx-overview-holdings .mx-ledger-pending");
      const height = () => pending.evaluate(node => node.getBoundingClientRect().height);
      await expect(pending).toHaveCSS("--mx-ledger-rows", "40");
      await expect.poll(async () => Math.abs(await height() - narrow)).toBeLessThanOrEqual(2);
      hydration.release();
      await expect(page.locator(".mx-overview-read")).not.toHaveAttribute("data-layout-bootstrap");
      await expect.poll(async () => Math.abs(await height() - narrow)).toBeLessThanOrEqual(2);
    } finally {
      hydration.release();
      waiting.resolve();
    }
  });

  test("oversized entries fall back to defaults and invalid heights keep valid counts", async ({ page, isMobile }) => {
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const first = Promise.withResolvers<void>();
    const reloaded = Promise.withResolvers<void>();
    let lensGate = first.promise;
    await mockOverview(page, { beforeLens: () => lensGate });
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    await page.goto("/");
    const overview = page.locator(".mx-overview-read");
    const pending = overview.locator(".mx-ledger-pending");
    const height = () => pending.evaluate(element => element.getBoundingClientRect().height);
    let defaultHeight: number;
    try {
      await expect(pending).toHaveCSS("--mx-ledger-rows", "5");
      defaultHeight = await height();
    } finally {
      first.resolve();
    }
    await expect(overview.getByRole("link", { name: /SYN19/ })).toBeVisible();
    await expect.poll(() => layoutKeys(page)).toHaveLength(1);
    const [key] = await layoutKeys(page);
    const poison = (oversized: boolean) => page.evaluate(({ key, oversized }) => {
      const entry = { rows: { stocks: 20, funds: 0 }, ledger: 500_000 };
      localStorage.setItem(key, JSON.stringify(oversized ? { ...entry, padding: "x".repeat(128 * 1024) } : entry));
    }, { key, oversized });
    await poison(true);
    lensGate = reloaded.promise;
    const hydration = await holdHydration(page);
    const countsOnly = JSON.stringify({ rows: { stocks: 20, funds: 0 } });
    const cached = () => page.evaluate(key => localStorage.getItem(key), key);
    let unmeasuredHeight: number;

    try {
      await page.reload({ waitUntil: "commit" });
      await hydration.waitForScripts();
      await expect(overview).toHaveAttribute("data-layout-bootstrap", "true");
      await expect(pending).toHaveCSS("--mx-ledger-rows", "5");
      expect(await height()).toBe(defaultHeight);
      expect(await layoutKeys(page)).toEqual([]);

      // Feed React a separate malformed value after the head script has finished.
      await poison(false);
      hydration.release();
      await expect(overview).not.toHaveAttribute("data-layout-bootstrap");
      await expect(pending).not.toHaveAttribute("data-measured");
      await expect(pending).toHaveCSS("--mx-ledger-rows", "20");
      unmeasuredHeight = await height();
      expect(unmeasuredHeight).toBeGreaterThan(defaultHeight);
      expect(unmeasuredHeight).toBeLessThan(3_000);
      await expect.poll(cached).toBe(countsOnly);
    } finally {
      hydration.release();
      reloaded.resolve();
    }
    const last = overview.getByRole("link", { name: /SYN19/ });
    await expect(last).toBeVisible();

    // A bad live measurement keeps counts and chart geometry. First paint still uses the row-based ledger height.
    await expect.poll(cached).toContain('"ledger":');
    await page.addStyleTag({ content: ".mx-overview-holdings .mx-ledger:not(.mx-ledger-pending) { min-height: 500000px }" });
    await expect.poll(async () => JSON.parse((await cached()) ?? "{}")).toEqual({
      rows: { stocks: 20, funds: 0 },
      reading: expect.objectContaining({ range: "1D" }),
      sectors: expect.any(Number),
    });
    const later = Promise.withResolvers<void>();
    lensGate = later.promise;
    const laterHydration = await holdHydration(page);
    try {
      await page.reload({ waitUntil: "commit" });
      await laterHydration.waitForScripts();
      await expect(pending).toHaveCSS("--mx-ledger-rows", "20");
      expect(Math.abs(await height() - unmeasuredHeight)).toBeLessThanOrEqual(2);
    } finally {
      laterHydration.release();
      later.resolve();
    }
    await expect(last).toBeVisible();
  });

  test("an older tab cannot restore reservations after a same-origin workspace switch", async ({ page, context, isMobile }) => {
    const viewport = isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    await page.setViewportSize(viewport);
    const changedWorkspace = Promise.withResolvers<void>();
    await mockOverview(page);
    await mockWorkspaceScope(page, "a");
    await page.goto("/");
    const oldLedger = page.locator(".mx-overview-holdings");
    await expect(oldLedger.getByRole("link", { name: /SYN19/ })).toBeVisible();
    await expect.poll(() => layoutKeys(page)).toHaveLength(1);
    const [oldKey] = await layoutKeys(page);

    const next = await context.newPage();
    try {
      await next.setViewportSize(viewport);
      await mockOverview(next, { beforeLens: () => changedWorkspace.promise, holdingCount: () => 4 });
      await mockWorkspaceScope(next, "b");
      await next.goto("/");
      const newLedger = next.locator(".mx-overview-holdings");
      await expect.poll(() => layoutKeys(next)).toEqual([]);
      const pending = newLedger.locator(".mx-ledger-pending");
      await expect(pending).toHaveCSS("--mx-ledger-rows", "5");
      await expect(pending).not.toHaveAttribute("data-measured");
      changedWorkspace.resolve();
      await expect(newLedger.getByRole("link", { name: /SYN3/ })).toBeVisible();
      await expect.poll(() => layoutKeys(next)).toHaveLength(1);
      const [newKey] = await layoutKeys(next);
      expect(newKey).not.toBe(oldKey);

      await page.bringToFront();
      const ledger = oldLedger.locator(".mx-ledger");
      const height = await ledger.evaluate(node => node.getBoundingClientRect().height);
      await ledger.evaluate((node, size) => { (node as HTMLElement).style.minHeight = (size + 64) + "px"; }, height);
      await expect.poll(() => ledger.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(height);
      const afterResize = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await afterResize();
      expect(await layoutKeys(next)).toEqual([newKey]);

      await page.setViewportSize({ ...viewport, width: isMobile ? 320 : 1000 });
      await afterResize();
      expect(await layoutKeys(next)).toEqual([newKey]);
    } finally {
      changedWorkspace.resolve();
      await next.close();
    }
  });

  test("a successful empty account read clears all saved geometry for its key", async ({ page }) => {
    let noAccounts = false;
    await mockOverview(page, { noAccounts: () => noAccounts, fullPage: true });
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    await page.goto("/");
    await expect(page.locator(".mx-digest")).toBeVisible();
    await expect.poll(async () => {
      const [key] = await layoutKeys(page);
      return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "{}"), key);
    }).toMatchObject({ ledger: expect.any(Number), sectors: expect.any(Number), brief: expect.any(Number) });

    noAccounts = true;
    await page.reload();
    await expect(page.getByRole("heading", { name: "No account data" })).toBeVisible();
    await expect.poll(() => layoutKeys(page)).toEqual([]);
  });

  test("an older same-workspace tab waits for a new nonempty read after the reservation is cleared", async ({ page, context, browserName }) => {
    test.skip(browserName !== "webkit", "Covers the same-workspace race in WebKit.");
    const viewport = { width: 390, height: 844 };
    let count = 20;
    await page.setViewportSize(viewport);
    await mockOverview(page, { holdingCount: () => count });
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    await page.goto("/");
    const ledger = page.locator(".mx-overview-holdings");
    await expect(ledger.getByRole("link", { name: /SYN19/ })).toBeVisible();
    await expect.poll(() => layoutKeys(page)).toHaveLength(1);
    const [key] = await layoutKeys(page);

    const next = await context.newPage();
    try {
      await next.setViewportSize(viewport);
      await mockOverview(next, { noAccounts: () => true });
      await next.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
      await next.goto("/");
      await expect(next.getByRole("heading", { name: "No account data" })).toBeVisible();
      await expect.poll(() => layoutKeys(next)).toEqual([]);

      await page.bringToFront();
      const table = ledger.locator(".mx-ledger");
      await table.evaluate(node => {
        (node as HTMLElement).style.minHeight = (node.getBoundingClientRect().height + 64) + "px";
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await layoutKeys(next)).toEqual([]);
    } finally {
      await next.close();
    }

    count = 4;
    await page.clock.setFixedTime(new Date(Date.parse(saturday) + 60_000));
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await context.setOffline(false);
    await expect(ledger.getByRole("link", { name: /SYN19/ })).toHaveCount(0);
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "{}").rows?.stocks, key)).toBe(4);
  });

  test("a disabled MaxAI brief releases its reservation while holdings are still loading", async ({ page }) => {
    let assistantEnabled = true;
    const portfolio = Promise.withResolvers<void>();
    await mockOverview(page, { fullPage: true, assistantEnabled: () => assistantEnabled,
      beforeLens: () => assistantEnabled ? Promise.resolve() : portfolio.promise });
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    await page.goto("/");
    await expect(page.locator(".mx-digest")).toBeVisible();
    await expect.poll(async () => {
      const [key] = await layoutKeys(page);
      return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "{}").brief ?? 0, key);
    }).toBeGreaterThan(0);

    assistantEnabled = false;
    const hydration = await holdHydration(page);
    const profile = page.waitForResponse(response => new URL(response.url()).pathname === "/api/backend/profile");
    const brief = page.locator(".mx-overview-brief");
    try {
      await page.reload({ waitUntil: "commit" });
      await hydration.waitForScripts();
      await expect(brief).toBeVisible();
      hydration.release();
      expect((await (await profile).json()).assistantEnabled).toBe(false);
      await expect(brief).toHaveCount(0);
      await expect(page.locator(".mx-ledger-pending")).toBeVisible();
    } finally {
      hydration.release();
      portfolio.resolve();
    }
    await expect(page.locator(".mx-ledger:not(.mx-ledger-pending)")).toBeVisible();
  });

  test("empty history preserves the twenty-holding ledger geometry on reload", async ({ page, isMobile }) => {
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const delayedLens = Promise.withResolvers<void>();
    let reloading = false;
    await mockOverview(page, { emptyHistory: true, beforeLens: async () => { if (reloading) await delayedLens.promise; } });
    await page.addInitScript(key => localStorage.removeItem(key), snapshotCacheStorageKey);
    await page.goto("/");
    const ledger = page.locator(".mx-overview-holdings");
    const last = ledger.getByRole("link", { name: /SYN19/ });
    const empty = page.getByRole("heading", { name: "No observations to chart yet" });
    const measure = () => ledger.evaluate(element => {
      const { top, height } = element.getBoundingClientRect();
      return { top: Math.round((top + scrollY) * devicePixelRatio) / devicePixelRatio, height };
    });
    await expect(empty).toBeVisible();
    await expect(last).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => layoutKeys(page)).not.toHaveLength(0);
    const first = await measure();

    reloading = true;
    await page.reload();
    try {
      await expect(ledger.locator(".mx-ledger-pending[data-measured]")).toHaveCSS("--mx-ledger-rows", "20");
      await expect(page.locator(".mx-overview-sectors .mx-empty")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await measure()).toEqual(first);
    } finally {
      delayedLens.resolve();
    }
    await expect(empty).toBeVisible();
    await expect(last).toBeVisible();
    expect(await measure()).toEqual(first);
  });

  test("a healthy Overview and the demo have no empty warning slot", async ({ page }) => {
    await mockOverview(page, { warning: false });
    await page.clock.setFixedTime(new Date(lens.brokerAsOf));
    for (const path of ["/", "/desktop"] as const) {
      const demo = process.env.DESKTOP_DEMO_QA_URL;
      if (path === "/desktop" && !demo) continue;
      await page.goto(path === "/desktop" ? new URL(path, demo).href : path);
      await expect(page.locator(".mx-overview-totals")).toBeVisible();
      await expect(page.locator(".mx-overview-portfolio :is(.mx-attention, .mx-overview-attention-slot, .mx-overview-attention-placeholder)")).toHaveCount(0);
    }
  });

  test("a failed range request keeps the prior session date by the phone reading", async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await mockOverview(page, { longRangeFails: () => true });
    await page.goto("/?range=1D");
    const label = page.locator(".mx-overview-lead-label");
    await expect(label).toContainText(/20 Nov/);
    const date = await label.innerText();
    await page.getByRole("button", { name: "3M", exact: true }).click();
    await expect(label).toHaveText(date + " · Showing 1D");
  });

  test("retry announces one recovery per affected reading without a generic holdings alert", async ({ page }) => {
    let failure = true;
    await mockOverview(page, { lensFails: () => failure });
    await page.goto("/");
    const overview = page.locator(".mx-overview-read");
    const account = overview.getByRole("status").filter({ hasText: "Account value unavailable" });
    const history = overview.getByRole("status").filter({ hasText: "P&L history unavailable" });
    await expect(account).toHaveCount(1);
    await expect(history).toHaveCount(1);
    await expect(overview.getByRole("status").filter({ hasText: /Holdings unavailable|Data is temporarily unavailable/ })).toHaveCount(0);
    failure = false;
    await overview.getByRole("button", { name: "Retry: Account value unavailable" }).click();
    await expect(overview.getByRole("status").filter({ hasText: "Account value is available again." })).toHaveCount(1);
    await expect(overview.getByRole("status").filter({ hasText: "P&L history is available again." })).toHaveCount(1);
    await expect(account).toHaveCount(0);
    await expect(history).toHaveCount(0);
  });

  test("paused sector and global market reads name the interruption and resume separately", async ({ page, context }) => {
    await mockOverview(page);
    await page.goto("/");
    const markets = page.locator(".mx-overview-sectors");
    const picker = markets.locator(".mx-overview-market");
    await expect(picker).toBeEnabled();
    await context.setOffline(true);
    try {
      await picker.click();
      await page.getByRole("menuitem", { name: /Europe/ }).click();
      await expect(markets.locator(".mx-waiting-as-of")).toContainText("Sector quotes will update");
      const offlineStatus = page.locator(".mx-overview-read").getByRole("status").filter({ hasText: /You’re offline/ });
      await expect(offlineStatus).toHaveCount(1);
      await expect(offlineStatus).toHaveText(/Data will update when you reconnect/);
      await expect(markets.locator(".mx-loading-message")).toHaveCount(0);
      await picker.click();
      await page.getByRole("menuitem", { name: /Global/ }).click();
      await expect(markets.locator(".mx-waiting-as-of")).toContainText("Global quotes will update");
      await expect(offlineStatus).toHaveCount(1);
      await expect(markets.locator(".mx-loading-message")).toHaveCount(0);
      await context.setOffline(false);
      await expect(markets.getByText("No global quotes yet")).toBeVisible();
      await expect(markets.locator(".mx-waiting-as-of")).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });
});
