import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { capture, desk } from "./valuation-desk";

// The synthetic desk in valuation-desk.ts: a saved valuation version of one
// security reopened after a new report.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mx-research-index-open", "true");
    localStorage.setItem("mx-research-index-pinned", "true");
  });
});

for (const locale of ["zh", "en"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`compare a saved version with new evidence without MaxAI · ${locale} · ${scheme}`, async ({ page }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    const en = locale === "en";
    await page.addInitScript((scheme) => localStorage.setItem("mantine-color-scheme-value", scheme), scheme);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
    const state = await desk(page);
    await page.goto("/research?ticker=SYNT&view=valuation");
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
    const editor = page.locator("#valuation-assumptions");
    const toggle = editor.getByRole("button", { name: en ? "See new evidence" : "看新证据", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(editor.getByRole("button", { name: en ? "✦ Draft" : "✦ 起草", exact: true })).toHaveCount(0);
    expect(state.reviews).toEqual([]);
    await toggle.click();
    const review = page.locator("#valuation-evidence");
    await expect(review).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const walk = review.locator("table");
    await expect(walk.locator("thead th")).toHaveText(en ? ["Bear", "Base", "Bull"] : ["保守", "中性", "乐观"]);
    const row = (label: string) => walk.locator("tbody tr").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });
    await expect(row(en ? "Saved 3 Aug" : "8月3日 保存").locator("td")).toHaveText(["US$117.65", "US$142.65", "US$167.65"]);
    await expect(row(en ? "New financial base" : "新财务基数").locator("td")).toHaveText(["+US$8.60", "+US$8.60", "+US$8.60"]);
    await expect(row(en ? "Of which restated" : "其中重述").locator("td")).toHaveText(["−US$2.40", "−US$2.40", "−US$2.40"]);
    await expect(row(en ? "Price and FX" : "价格与汇率").locator("td")).toHaveText(["−US$1.25", "−US$1.25", "−US$1.25"]);
    await expect(row(en ? "Changed assumptions" : "改动的假设").locator("td")).toHaveText(["US$0.00", "US$0.00", "US$0.00"]);
    await expect(row(en ? "New proposal" : "新提案").locator("td")).toHaveText(["US$125.00", "US$150.00", "US$175.00"]);
    await expect(walk.locator("td[data-selected]")).toHaveCount(6);
    const notes = review.locator(".mx-evidence-notes li");
    await expect(notes).toHaveCount(4);
    await expect(notes.nth(0)).toContainText(en ? "Restated" : "重述");
    await expect(notes.nth(0)).toContainText(en ? "4.00k → 3.85k USD" : "4,000 → 3,850 USD");
    await expect(notes.nth(1)).toContainText(en ? "Conflict" : "冲突");
    await expect(notes.nth(1)).toContainText(en ? "four quarters 4.30k · fiscal year 4.41k USD" : "四季合计 4,300 · 年报 4,410 USD");
    await expect(notes.nth(2)).toContainText(en ? "Revenue-growth consensus" : "营收增长一致预期");
    await expect(notes.nth(2)).toContainText("15.0% → 19.0%");
    await expect(notes.nth(3)).toContainText("2.50 → 2.70 USD");
    expect(state.reviews[0]).toMatchObject({ modelId: "saved-version", horizon: 5,
      lockedInputs: [{ scenario: "base", field: "discount_rate" }] });
    await review.locator("summary").click();
    await expect(review.locator(".mx-facts")).toContainText(en ? "Locked assumptions" : "锁定的假设");
    await capture(page, `${info.project.name}-${locale}-${scheme}`);
    await review.getByRole("button", { name: en ? "Restated" : "重述" }).first().click();
    await expect(page.getByRole("dialog")).toContainText(en ? "Of which restated" : "其中重述");
    await page.keyboard.press("Escape");
    expect(state.saves).toEqual([]);
    expect(state.drafts).toEqual([]);
    await review.getByRole("button", { name: en ? "Close new evidence" : "收起新证据" }).click();
    await expect(review).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });
}

test("a locked assumption is saved with the version and kept out of a MaxAI draft", async ({ page }, info) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const state = await desk(page, { assistant: true });
  await page.goto("/research?ticker=SYNT&view=valuation");
  const editor = page.locator("#valuation-assumptions");
  const growth = editor.getByLabel("Revenue growth · years 1–5", { exact: true });
  await expect(growth).toHaveValue("10%");
  const lock = editor.getByRole("button", { name: "Lock", exact: true });
  await expect(lock).toHaveAccessibleDescription("Revenue growth · years 1–5");
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await expect(growth).toHaveAttribute("readonly", "");
  await editor.getByRole("button", { name: /^Cost of equity/ }).click();
  await expect(lock).toHaveAccessibleDescription("Cost of equity");
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await capture(page, info.project.name + "-locks", "#valuation-assumptions");
  const locks = [{ scenario: "base", field: "discount_rate" }, { scenario: "base", field: "revenue_cagr" }];
  await editor.getByRole("button", { name: "See new evidence", exact: true }).click();
  await expect.poll(() => state.reviews.at(-1)?.lockedInputs).toEqual(locks);
  await editor.getByRole("button", { name: "✦ Draft", exact: true }).click();
  await expect.poll(() => state.drafts.length).toBe(1);
  expect(state.drafts[0]).toMatchObject({ lockedInputs: locks });
  await editor.getByRole("group", { name: "Edit scenario" }).getByRole("button", { name: "Bull", exact: true }).click();
  await editor.getByRole("button", { name: "Accept Revenue growth · years 1–5", exact: true }).click();
  await expect.poll(() => state.reviews.at(-1)?.scenarios.bull.revenueCagr).toBe(0.19);
  const assumptions = page.locator("#valuation-evidence tbody tr")
    .filter({ has: page.getByRole("rowheader", { name: "Changed assumptions", exact: true }) });
  await expect(assumptions.locator("td")).toHaveText(["US$0.00", "US$0.00", "+US$20.00"]);
  await editor.getByRole("button", { name: "Save model version", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save version", exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toMatchObject({ lockedInputs: locks,
    draftReview: { id: "synthetic-draft", decisions: { bull: { revenue_cagr: "accepted" } } } });
});

for (const locale of ["zh", "en"] as const) {
  test(`a partly checked restatement and an unchecked fiscal year say why · ${locale}`, async ({ page }, info) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");
    const en = locale === "en";
    if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((value) => localStorage.setItem("trading_max-locale", value), locale);
    await desk(page, { amend: (review) => ({
      ...review,
      // The current statements no longer report the period's cash, so the combined effect is withheld.
      scenarios: Object.fromEntries(Object.entries(review.scenarios).map(([key, walk]) =>
        [key, { ...walk, restated: null, restatementEffect: null }])),
      restatementGap: "metrics-incomplete", uncheckedFigures: ["cash"],
      conflicts: [{ kind: "conflicting-source-rows", periodId: "annual:2026-09-30", metric: "revenue",
        unit: "currency", currency: "USD", blocksComparison: true }],
    }) });
    await page.goto("/research?ticker=SYNT&view=valuation");
    await page.locator("#valuation-assumptions").getByRole("button", { name: en ? "See new evidence" : "看新证据", exact: true }).click();
    const review = page.locator("#valuation-evidence");
    await expect(review.getByRole("rowheader", { name: en ? "New financial base" : "新财务基数", exact: true })).toBeVisible();
    await expect(review.getByRole("rowheader", { name: en ? "Of which restated" : "其中重述", exact: true })).toHaveCount(0);
    const notes = review.locator(".mx-evidence-notes li");
    const help = page.getByRole("dialog");
    // The restated figure stays in view, followed by a short status; the reason is in its help.
    await expect(notes.nth(0)).toContainText(en ? "4.00k → 3.85k USD" : "4,000 → 3,850 USD");
    await expect(notes.nth(1).locator(".mx-tag")).toHaveText(en ? "Restatement effect unavailable" : "重述影响无法计算");
    const reason = en
      ? "The current statements lack this period's cash & short-term investments, so the combined effect of the restatement cannot be computed."
      : "最新报表缺少这一期的现金及短期投资，重述的合计影响无法计算。";
    await expect(review.getByText(reason)).toHaveCount(0);
    await capture(page, `${info.project.name}-partial-${locale}`);
    // The help opens from the status by keyboard and hands focus back to it.
    const status = review.getByRole("button", { name: en ? /^Restatement effect unavailable/ : /^重述影响无法计算/ });
    await status.focus();
    await page.keyboard.press("Enter");
    await expect(help).toContainText(reason);
    const dir = process.env.VALUATION_MAINTENANCE_SCREENSHOTS_DIR;
    if (dir) await page.screenshot({ scale: "css", path: join(dir, `${info.project.name}-partial-help-${locale}.png`) });
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(status).toBeFocused();
    await review.getByRole("button", { name: en ? /^Restated\s/ : /^重述\s/ }).click();
    await expect(help).toContainText(en ? "it is included in the new financial base" : "计入新财务基数");
    await expect(help).not.toContainText(en ? "Of which restated" : "其中重述");
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(notes.nth(2)).toContainText(en ? /FY to 30 Sept? · Revenue two different rows/ : "财年 截至 9月30日 · 营收 两行数字不同");
    await review.getByRole("button", { name: en ? /^Conflict\s/ : /^冲突\s/ }).click();
    await expect(help).toContainText(en ? "so the four quarters cannot be checked against it" : "无法用它核对四个季度的合计");
  });
}
