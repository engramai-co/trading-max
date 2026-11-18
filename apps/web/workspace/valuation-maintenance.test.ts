import { describe, expect, it } from "vitest";
import { distinct, pair, periodText, signedValue } from "./valuation-maintenance";
import { sortedLocks } from "./valuation-queries";

const zh = (chinese: string) => chinese;
const en = (_: string, english: string) => english;

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
    expect(periodText("ttm:2026-03-31", en, "en")).toMatch(/^TTM to 31 Mar/);
    expect(periodText("annual:2025-12-31", zh, "zh")).toBe("财年 截至 2025年12月31日");
    expect(periodText(null, zh, "zh")).toBe("—");
  });

  it("orders and deduplicates locks", () => {
    expect(sortedLocks([
      { scenario: "bull", field: "share_cagr" }, { scenario: "base", field: "discount_rate" },
      { scenario: "bull", field: "share_cagr" },
    ])).toEqual([{ scenario: "base", field: "discount_rate" }, { scenario: "bull", field: "share_cagr" }]);
  });
});
