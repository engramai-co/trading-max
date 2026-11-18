import { expect, test, type Page } from "@playwright/test";
import { capture, desk, preview, saved, savedModel } from "./valuation-desk";

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
  const profile = { profileId: "local", displayName: "Synthetic", initials: "S", avatarColor: "#1768e5", locale: "en",
    baseCurrency: "GBP", timezone: "Europe/London", accountLabels: {}, revision: 1, updatedAt: "2026-11-04T12:00:00Z",
    assistantEnabled: false };
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
