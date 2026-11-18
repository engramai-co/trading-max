import { expect, test, type Page } from "@playwright/test";
import { capture, desk, lens, preview, saved, savedModel } from "./valuation-desk";

// Notices of new evidence on the synthetic desk in valuation-desk.ts. Every response is fabricated.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mx-research-index-open", "true");
    localStorage.setItem("mx-research-index-pinned", "true");
  });
});

const shots = process.env.VALUATION_ALERTS_SCREENSHOTS_DIR ?? "";
const notice = {
  ticker: "SYNT", modelId: savedModel.id, savedAt: savedModel.savedAt,
  items: [
    { key: "statements:ttm:2026-09-30", kind: "statements", periodId: "ttm:2026-09-30" },
    { key: "consensusEps:2027-09-30:USD:1", kind: "estimate", metric: "consensusEps", periodEnd: "2027-09-30",
      currency: "USD", saved: 2.5, current: 2.7, asOf: "2026-11-03T21:00:00Z" },
  ],
};
const on = { enabled: true, runId: "synthetic-run", notices: [notice] };
const keys = notice.items.map((item) => item.key);

for (const locale of ["zh", "en"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`a saved model with new evidence is marked until its evidence is opened · ${locale} · ${scheme}`, async ({ page }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    const en = locale === "en";
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
    const state = await desk(page, { notices: on });
    await page.goto("/research?ticker=SYNT&view=valuation");
    const toggle = page.locator("#valuation-assumptions").getByRole("button", { name: en ? "See new evidence" : "看新证据", exact: true });
    await expect(toggle).toHaveAccessibleDescription(en ? "New evidence: New statements, EPS consensus" : "有新证据：新报表、EPS 一致预期");
    await expect(toggle.locator(".mx-evidence-dot")).toBeVisible();
    await capture(page, `${info.project.name}-${locale}-${scheme}`, "#valuation-assumptions", shots);
    // The research list marks the security as well.
    await page.getByRole("button", { name: en ? /, open research list$/ : /，打开研究清单$/ }).click();
    const list = page.getByRole("dialog");
    await expect(list.getByRole("img", { name: en ? "New evidence" : "有新证据", exact: true })).toHaveCount(1);
    await capture(page, `${info.project.name}-${locale}-${scheme}-list`, ".mx-watchlist", shots);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    expect(state.seen).toEqual([]);
    // Opening the evidence settles the notice. Nothing is drafted or saved.
    await toggle.click();
    await expect(page.locator("#valuation-evidence")).toBeFocused();
    await expect.poll(() => state.seen).toEqual([{ modelId: savedModel.id, keys }]);
    await expect(toggle.locator(".mx-evidence-dot")).toHaveCount(0);
    await expect(toggle).not.toHaveAttribute("aria-describedby");
    expect(state.saves).toEqual([]);
    expect(state.drafts).toEqual([]);
  });
}

test("with notices off nothing is marked, and opening the evidence records nothing", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const state = await desk(page, { notices: { enabled: false, runId: null, notices: [] } });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const toggle = page.locator("#valuation-assumptions").getByRole("button", { name: "See new evidence", exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator("#valuation-evidence table")).toBeVisible();
  await expect(page.locator(".mx-evidence-dot")).toHaveCount(0);
  expect(state.seen).toEqual([]);
});

test("evidence that arrives after the comparison opened stays marked until a comparison shows it", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const later = { key: "statements:ttm:2026-12-31", kind: "statements", periodId: "ttm:2026-12-31" };
  // The evidence each comparison names; the first is made before the later report arrives.
  let compared = keys;
  const state = await desk(page, { amend: (review) => ({ ...review, evidenceKeys: compared }) });
  let current = { enabled: true, runId: "synthetic-run", notices: [] as object[] };
  await page.route("**/api/backend/valuation/evidence-notices", (route) => route.fulfill({ json: current }));
  await page.route("**/api/backend/valuation/evidence-notices/*/seen", (route) => {
    state.seen.push(route.request().postDataJSON());
    current = { ...current, notices: [] };
    return route.fulfill({ json: current });
  });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const toggle = editor.getByRole("button", { name: "See new evidence", exact: true });
  await toggle.click();
  await expect(page.locator("#valuation-evidence table")).toBeVisible();
  const comparisons = state.reviews.length;
  current = { enabled: true, runId: "next-run", notices: [{ ...notice, items: [later] }] };
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/valuation/evidence-notices"));
  await page.clock.fastForward(61_000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await refreshed;
  // The open comparison predates the evidence, so the notice stays: give a settling
  // request time to be sent, then check that none was.
  await expect(toggle.locator(".mx-evidence-dot")).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(toggle.locator(".mx-evidence-dot")).toBeVisible();
  expect(state.reviews.length).toBe(comparisons);
  expect(state.seen).toEqual([]);
  // A new comparison that shows it settles exactly that evidence.
  compared = [...keys, later.key];
  await editor.getByLabel("Revenue growth · years 1–5", { exact: true }).fill("12");
  await page.clock.fastForward(2_000);
  await expect.poll(() => state.seen).toEqual([{ modelId: savedModel.id, keys: [later.key] }]);
  await expect(toggle.locator(".mx-evidence-dot")).toHaveCount(0);
});

test("reopened without an edit, a comparison that predates its notice is made again", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const later = { key: "statements:ttm:2026-12-31", kind: "statements", periodId: "ttm:2026-12-31" };
  let compared = keys;
  const state = await desk(page, { amend: (review) => ({ ...review, evidenceKeys: compared }) });
  let current = { enabled: true, runId: "synthetic-run", notices: [] as object[] };
  await page.route("**/api/backend/valuation/evidence-notices", (route) => route.fulfill({ json: current }));
  await page.route("**/api/backend/valuation/evidence-notices/*/seen", (route) => {
    state.seen.push(route.request().postDataJSON());
    current = { ...current, notices: [] };
    return route.fulfill({ json: current });
  });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const toggle = page.locator("#valuation-assumptions").getByRole("button", { name: "See new evidence", exact: true });
  await toggle.click();
  await expect(page.locator("#valuation-evidence table")).toBeVisible();
  await toggle.click();
  await expect(page.locator("#valuation-evidence")).toHaveCount(0);
  const comparisons = state.reviews.length;
  // The notice is ahead of the publication this page shows; the service already shows its evidence.
  current = { enabled: true, runId: "next-run", notices: [{ ...notice, items: [later] }] };
  compared = [...keys, later.key];
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/valuation/evidence-notices"));
  await page.clock.fastForward(61_000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await refreshed;
  await expect(toggle.locator(".mx-evidence-dot")).toBeVisible();
  expect(state.reviews.length).toBe(comparisons);
  // Reopened with every assumption as it was, the evidence is compared again and exactly the new report settles.
  await toggle.click();
  await expect.poll(() => state.reviews.length).toBe(comparisons + 1);
  await expect.poll(() => state.seen).toEqual([{ modelId: savedModel.id, keys: [later.key] }]);
  await expect(toggle.locator(".mx-evidence-dot")).toHaveCount(0);
});

test("reopened after a consensus-only publication, the evidence is compared with the new consensus", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  let run = "synthetic-run";
  // The publication moves only the EPS consensus, three steps from the saved 2.50.
  const later = { key: "consensusEps:2027-09-30:USD:3", kind: "estimate", metric: "consensusEps", periodEnd: "2027-09-30",
    currency: "USD", saved: 2.5, current: 2.95, asOf: "2026-11-04T22:00:00Z" };
  const state = await desk(page, { amend: (review) => run === "synthetic-run" ? review : {
    ...review, evidenceKeys: [later.key], estimates: [{ metric: later.metric, periodEnd: later.periodEnd,
      currency: later.currency, saved: later.saved, current: later.current, savedAsOf: "2026-08-02T21:00:00Z",
      currentAsOf: later.asOf }],
  } });
  await page.route("**/api/backend/health", (route) => route.fulfill({ json: {
    service: "trading_max-api", status: "ok", latestRunId: run } }));
  await page.route("**/api/backend/valuation/evidence-notices", (route) => route.fulfill({ json: {
    enabled: true, runId: run, notices: run === "synthetic-run" ? [] : [{ ...notice, items: [later] }] } }));
  await page.route("**/api/backend/valuation/evidence-notices/*/seen", (route) => {
    state.seen.push(route.request().postDataJSON());
    return route.fulfill({ json: { enabled: true, runId: run, notices: [] } });
  });
  const shellResponse = page.waitForResponse((response) => response.url().endsWith("/research/shell"));
  await page.goto("/research?ticker=SYNT&view=valuation");
  const shell = await (await shellResponse).json();
  const toggle = page.locator("#valuation-assumptions").getByRole("button", { name: "See new evidence", exact: true });
  const evidence = page.locator("#valuation-evidence");
  await toggle.click();
  await expect(evidence.getByText("2.50 → 2.70 USD")).toBeVisible();
  await toggle.click();
  const comparisons = state.reviews.length;
  // The research data keeps its statements and quote; only the publication and its consensus are new.
  run = "consensus-update";
  await page.route("**/api/backend/research/shell", (route) => route.fulfill({ json: { ...shell,
    status: { ...shell.status, runId: run },
    instruments: shell.instruments.map((item: object) => ({ ...item, lastRunId: run })) } }));
  await page.route(/\/api\/backend\/research\/SYNT\/lens\/(\w+)/, (route) =>
    route.fulfill({ json: { ...lens(/lens\/(\w+)/.exec(route.request().url())![1]), runId: run } }));
  // The next comparison waits, to show what the panel holds while it is made.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/SYNT/valuation-maintenance", async (route) => {
    await held;
    return route.fallback();
  });
  const checked = page.waitForResponse((response) => response.url().endsWith("/health"));
  await page.clock.fastForward(61_000);
  await checked;
  await expect(toggle.locator(".mx-evidence-dot")).toBeVisible();
  // Reopened without an edit, the evidence is compared again, and the earlier comparison is not shown meanwhile.
  await toggle.click();
  await expect(evidence.getByRole("status", { name: "Comparing with the saved version…" })).toBeVisible();
  await expect(evidence.getByText("2.50 → 2.70 USD")).toHaveCount(0);
  expect(state.seen).toEqual([]);
  release();
  await expect(evidence.getByText("2.50 → 2.95 USD")).toBeVisible();
  expect(state.reviews.length).toBe(comparisons + 1);
  await expect.poll(() => state.seen).toEqual([{ modelId: savedModel.id, keys: [later.key] }]);
  await expect(toggle.locator(".mx-evidence-dot")).toHaveCount(0);
});

test("a new publication brings its notices to an open page", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await desk(page);
  let run = "synthetic-run";
  let current = { enabled: true, runId: run, notices: [] as object[] };
  await page.route("**/api/backend/health", (route) => route.fulfill({ json: {
    service: "trading_max-api", status: "ok", latestRunId: run } }));
  await page.route("**/api/backend/valuation/evidence-notices", (route) => route.fulfill({ json: current }));
  await page.goto("/research?ticker=SYNT&view=valuation");
  const toggle = page.locator("#valuation-assumptions").getByRole("button", { name: "See new evidence", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle.locator(".mx-evidence-dot")).toHaveCount(0);
  run = "next-run";
  current = { enabled: true, runId: run, notices: [notice] };
  const checked = page.waitForResponse((response) => response.url().endsWith("/health"));
  await page.clock.fastForward(61_000);
  await checked;
  await expect(toggle.locator(".mx-evidence-dot")).toBeVisible();
});


test("the journal opens a saved version's new evidence in the valuation", async ({ page }, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const state = await desk(page, { notices: on, journal: {
    ticker: "SYNT", schemaVersion: 1, baselineModelId: null, notes: [],
    models: [{ id: savedModel.id, savedAt: savedModel.savedAt, preview: preview(saved), reason: "" }],
  } });
  await page.goto("/research?ticker=SYNT&view=ledger&notebook=models");
  const link = page.getByRole("link", { name: "See new evidence", exact: true });
  await expect(link).toHaveAttribute("href", "/research?ticker=SYNT&view=valuation&valuationView=scenario&evidence=open");
  await expect(link).toHaveAccessibleDescription("New evidence: New statements, EPS consensus");
  await capture(page, info.project.name + "-journal", ".mx-financial-table", shots);
  await link.click();
  await expect(page.locator("#valuation-evidence")).toBeFocused();
  // The link opens the review once: the address no longer asks for it.
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "valuation" && !url.searchParams.has("evidence"));
  await expect.poll(() => state.seen).toEqual([{ modelId: savedModel.id, keys }]);
  expect(state.saves).toEqual([]);
});

async function settings(page: Page) {
  const profile = { profileId: "local", displayName: "Synthetic", initials: "S", locale: "en", baseCurrency: "GBP",
    timezone: "Europe/London", accountLabels: {}, revision: 1, updatedAt: "2026-11-04T12:00:00Z", assistantEnabled: false };
  let automation = {
    liveEnabled: false, liveTimezone: "Europe/London", liveIntervalSeconds: 600, liveWindowStart: "00:00", liveWindowEnd: "00:00",
    liveWeekdays: [1, 2, 3, 4, 5], performanceEnabled: true, performanceTimezone: "Europe/London", performanceIntervalSeconds: 3600,
    researchEnabled: true, researchTimezone: "Europe/London", researchLocalTimes: ["06:30", "22:30"], dailyReconciliationLocalTime: "22:30",
    nightlyEnabled: true, nightlyTimezone: "Europe/London", nightlyLocalTime: "06:30", nightlyLocalTimes: ["06:30", "22:30"],
    intradayEnabled: false, intradayTimezone: "Europe/London", intradayIntervalSeconds: 600, intradayWindowStart: "00:00",
    intradayWindowEnd: "00:00", intradayWeekdays: [1, 2, 3, 4, 5], evidenceNoticesEnabled: false, revision: 3,
    updatedAt: "2026-11-04T12:00:00Z",
  };
  const puts: Record<string, unknown>[] = [];
  await page.route("**/api/backend/**", (route) => route.fulfill({ status: 404, json: { detail: "synthetic" } }));
  await page.route("**/api/backend/health", (route) => route.fulfill({ json: {
    service: "trading_max-api", status: "ok", latestRunId: "synthetic-run" } }));
  await page.route("**/api/backend/profile", (route) => route.fulfill({ json: profile }));
  await page.route("**/api/backend/settings/integrations", (route) => route.fulfill({ json: {
    profile, integrations: [], llmProviders: [] } }));
  await page.route("**/api/backend/settings/automation", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts.push(body);
      automation = { ...automation, ...body, revision: automation.revision + 1 };
    }
    return route.fulfill({ json: automation });
  });
  return puts;
}

for (const locale of ["zh", "en"] as const) {
  test(`notices stay off until switched on in Settings · ${locale}`, async ({ page }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    const en = locale === "en";
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
    const puts = await settings(page);
    await page.goto("/settings?tab=automation");
    const panel = page.locator(".mx-panel").filter({ has: page.getByRole("heading", { name: en ? "Notices" : "提醒", level: 2, exact: true }) });
    const toggle = panel.getByRole("switch", { name: en ? "New evidence for saved valuation models" : "已存估值模型的新证据", exact: true });
    await expect(toggle).not.toBeChecked();
    await capture(page, `${info.project.name}-settings-${locale}`, ".mx-settings-page", shots);
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => puts).toEqual([{ evidenceNoticesEnabled: true, expectedRevision: 3 }]);
    await expect(toggle).toBeChecked();
    await expect(panel.getByRole("status")).toHaveText(en ? "Notice setting saved" : "提醒设置已保存");
    // The help says what counts as new evidence and that nothing is drafted or saved.
    await panel.getByRole("button", { name: en ? "Notices explained" : "提醒说明" }).click();
    await expect(page.getByRole("dialog")).toContainText(en ? "nothing is drafted or saved" : "不起草，也不保存模型");
  });
}
