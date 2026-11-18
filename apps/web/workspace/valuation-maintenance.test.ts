import { describe, expect, it } from "vitest";
import { periodText } from "./evidence-notices";
import { distinct, pair, restatementGapStatus, restatementGapText, signedValue } from "./valuation-maintenance";
import { sortedLocks } from "./valuation-queries";

describe("new evidence figures", () => {
  it("signs changes with the typographic minus and shows zero unsigned", () => {
    expect(signedValue(9.4, "USD")).toBe("+US$9.40");
    expect(signedValue(-0.904, "USD")).toBe("\u2212US$0.90");
    expect(signedValue(0.004, "USD")).toBe("US$0.00");
    expect(signedValue(-0.004, "GBP")).toBe("£0.00");
    expect(signedValue(null, "USD")).toBe("—");
  });

  it("never rounds a restated figure into its original", () => {
    expect(pair(391.035e9, 390.912e9, "currency", "USD", "en")).toBe("391.04bn → 390.91bn USD");
    expect(pair(4000, 3850, "currency", "USD", "en")).toBe("4.00k → 3.85k USD");
    expect(pair(391.035e9, 390.912e9, "currency", "USD", "zh")).toBe("3,910.4亿 → 3,909.1亿 USD");
    expect(pair(4000, 3850, "currency", "EUR", "zh")).toBe("4,000 → 3,850 EUR");
    expect(pair(0.125, 0.11627, "ratio", null, "en")).toBe("12.50% → 11.63%");
    expect(pair(0.15, 0.1503, "ratio", null, "en")).toBe("15.000% → 15.030%");
    expect(distinct(-500, 120, "currency", "en")).toEqual(["\u2212500", "120"]);
    expect(pair(1.52e9, 1.49e9, "shares", null, "en")).toBe("1.520bn → 1.490bn");
  });

  it("names a statement period by its kind and end", () => {
    expect(periodText("ttm:2026-03-31", "en")).toMatch(/^TTM to 31 Mar/);
    expect(periodText("annual:2025-12-31", "zh")).toBe("财年 截至 2025年12月31日");
    expect(periodText(null, "zh")).toBe("—");
  });

  it("orders and deduplicates locks", () => {
    expect(sortedLocks([
      { scenario: "bull", field: "share_cagr" }, { scenario: "base", field: "discount_rate" },
      { scenario: "bull", field: "share_cagr" },
    ])).toEqual([{ scenario: "base", field: "discount_rate" }, { scenario: "bull", field: "share_cagr" }]);
  });

  it("says why a saved period could not be checked for restatements", () => {
    const zh = (a: string) => a, en = (_: string, b: string) => b;
    const point = (reportingCurrency: string) => ({ periodId: "ttm:2025-12-31", periodChoice: null, spot: 20,
      spotSource: "quote" as const, spotAsOf: null, fxRate: 1, reportingCurrency });
    const review = { restatementCheck: "restated" as const, restatementGap: "metrics-incomplete" as const,
      uncheckedFigures: ["cash" as const, "freeCashflow" as const], family: "cash-flow" as const,
      saved: point("USD"), current: point("USD") };
    expect(restatementGapText(review, en, "en")).toBe("The current statements lack this period's cash & " +
      "short-term investments and free cash flow, so the combined effect of the restatement cannot be computed.");
    expect(restatementGapText({ ...review, restatementCheck: "unchanged", uncheckedFigures: ["cash"] }, zh, "zh"))
      .toBe("最新报表缺少这一期的现金及短期投资，无法核对是否重述。");
    expect(restatementGapText({ ...review, restatementCheck: "unavailable", restatementGap: "currency-changed",
      current: point("EUR") }, en, "en")).toBe("The statements now report in EUR rather than USD, so restatements cannot be checked.");
    expect(restatementGapText({ ...review, restatementCheck: "unavailable", restatementGap: "period-missing" }, zh, "zh"))
      .toBe("保存时的期间已不在当前报表中，无法核对重述。");
    expect(restatementGapText({ ...review, restatementCheck: "unchanged", restatementGap: null }, en, "en")).toBeNull();
  });

  it("shows a short status for an incomplete restatement check and keeps the reason for its help", () => {
    const zh = (a: string) => a, en = (_: string, b: string) => b;
    expect(restatementGapStatus({ restatementCheck: "restated", restatementGap: "metrics-incomplete" }, zh))
      .toBe("重述影响无法计算");
    expect(restatementGapStatus({ restatementCheck: "restated", restatementGap: "metrics-incomplete" }, en))
      .toBe("Restatement effect unavailable");
    expect(restatementGapStatus({ restatementCheck: "unchanged", restatementGap: "metrics-incomplete" }, en))
      .toBe("Restatements partly checked");
    expect(restatementGapStatus({ restatementCheck: "unavailable", restatementGap: "currency-changed" }, zh))
      .toBe("无法核对重述");
    expect(restatementGapStatus({ restatementCheck: "unchanged", restatementGap: null }, en)).toBeNull();
  });
});
