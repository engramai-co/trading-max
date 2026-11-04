import { describe, expect, it } from "vitest";
import type { Holding, NavPoint } from "@/lib/types";
import { observedNav } from "@/lib/portfolio/nav";
import { statementUnit, statementValue, quoteValue } from "./financial-values";
import { behaviorObservation, reviewLabel, systemReason } from "./review-copy";
import { compareHoldings, dayChangeColumn, holdingSort, holdingSortDirection } from "./holdings-data";

const zh = (text: string) => text;
describe("QA financial value regressions", () => {
  it("keeps amount, ratio and holding duration units distinct", () => {
    expect(behaviorObservation("buy_notional_during_money_drawdown_gbp", 1234.56, zh).value).toBe("£1,234.56");
    expect(behaviorObservation("best_trade_dependence", 0.123, zh).value).toBe("12.3%");
    expect(behaviorObservation("winner_vs_loser_holding_days", 2.5, zh).value).toBe("2.5 天");
    expect(behaviorObservation("new_diagnostic", 0.123, zh).value).toBe("0.12");
    expect(behaviorObservation("best_trade_dependence", null, zh).value).toBe("—");
  });
  it("does not scale tax rates or per-share values when scaling money and shares", () => {
    for (const millions of [true, false]) {
      expect(statementValue(0.156, "Tax Rate For Calcs", millions)).toBe("15.6%");
      expect(statementValue(3.25, "Diluted EPS", millions)).toBe("3.25");
    }
    expect(statementValue(123400000, "Total Revenue", true)).toBe("123.4");
    expect(statementValue(123400000, "Total Revenue", false)).toBe("123,400,000");
    expect(statementUnit("Diluted Average Shares")).toBe("shares");
    expect(statementUnit("Ordinary Shares Number")).toBe("shares");
    expect(statementValue(null, "Tax Rate For Calcs", true)).toBe("—");
    expect(quoteValue(100, "GBP", "未知币种")).toBe("£100.00");
    expect(quoteValue(100, "USD", "未知币种")).toBe("US$100.00");
    expect(quoteValue(100, "", "未知币种")).toBe("100 · 未知币种");
  });
  it("trims unrelated account history without deleting zeroes or internal gaps", () => {
    const rows = [
      { date: "2024-01-01", cfdNetPnlGbp: 10 },
      { date: "2026-01-01", investNetPnlGbp: 0, isaNetPnlGbp: 0 },
      { date: "2026-01-02", investNetPnlGbp: null, isaNetPnlGbp: 10 },
      { date: "2026-01-03", investNetPnlGbp: 20, cfdNetPnlGbp: 20 },
      { date: "2026-01-04", cfdNetPnlGbp: 30 },
    ] as NavPoint[];
    expect(observedNav(rows, "invest", "NetPnlGbp")).toEqual(rows.slice(1, 4));
    expect(observedNav(rows, "isa", "NetPnlGbp")).toEqual(rows.slice(1, 3));
    expect(observedNav(rows, "cfd", "NetPnlGbp")).toEqual(rows);
    expect(observedNav(rows, "total", "Drawdown")).toEqual([]);
  });
  it("orders labels and numerical fields consistently in both directions", () => {
    const a = { ticker: "AAA", pnlGbp: -5, currentValueGbp: 20, allocationPct: 0.2 } as Holding;
    const b = { ticker: "ZZZ", pnlGbp: 10, currentValueGbp: 100, allocationPct: 0.8 } as Holding;
    for (const sort of ["ticker", "pnl", "allocation", "value"]) {
      expect(compareHoldings(a, b, sort, "asc")).toBeLessThan(0);
      expect(compareHoldings(a, b, sort, "desc")).toBeGreaterThan(0);
    }
    expect(holdingSortDirection("ticker", null)).toBe("asc");
    expect(holdingSortDirection("value", null)).toBe("desc");
    expect(holdingSortDirection("ticker", "desc")).toBe("desc");
  });
  it("sorts by today's change with unattributed positions last in both directions", () => {
    const rows = [
      { ticker: "NEW", dayChangeGbp: null },
      { ticker: "UP", dayChangeGbp: 12.3 },
      { ticker: "DOWN", dayChangeGbp: -40 },
      { ticker: "FLAT", dayChangeGbp: 0 },
    ] as Holding[];
    const order = (direction: string) => [...rows].sort((a, b) => compareHoldings(a, b, "day", direction)).map((row) => row.ticker);
    expect(order("desc")).toEqual(["UP", "FLAT", "DOWN", "NEW"]);
    expect(order("asc")).toEqual(["DOWN", "FLAT", "UP", "NEW"]);
    expect(holdingSort("day")).toBe("day");
    expect(holdingSort("bogus")).toBe("value");
  });
  it("names each day change by its own account's trading day", () => {
    const friday = { ticker: "VRT", account: "A", dayChangeGbp: 0, dayChangeDate: "2026-11-06" } as Holding;
    const monday = { ticker: "EQGB", account: "B", dayChangeGbp: 12, dayChangeDate: "2026-11-09" } as Holding;
    const opened = { ticker: "NEW", account: "B", dayChangeGbp: null, dayChangeDate: null } as Holding;
    const column = dayChangeColumn([friday, monday, opened]);
    expect(column.latest).toBe("2026-11-09");
    expect([friday, monday, opened].map(column.earlier)).toEqual(["2026-11-06", null, null]);
    expect(dayChangeColumn([opened]).latest).toBeNull();
  });
  it("uses readable system messages without translating security names", () => {
    expect(reviewLabel("8_to_30_days", zh)).toBe("8–30 天");
    expect(reviewLabel("Apple Inc.", zh)).toBe("Apple Inc.");
    expect(systemReason("realised attribution requires reliably reconstructed closed campaigns", zh)).not.toContain("campaign");
    expect(systemReason("future_failure_code", zh)).toBe("这项分析存在数据限制。");
  });
});
