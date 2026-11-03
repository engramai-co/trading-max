import { describe, expect, it } from "vitest";
import { notableDecisions, sideVerdict, signedMoney, type TradeDecision } from "./review-decisions";

const row = (side: "buy" | "sell", ticker: string, horizon: number | null, toDate: number): TradeDecision => ({
  date: "2026-06-01",
  ticker,
  name: ticker,
  side,
  kind: side === "buy" ? "B" : "S",
  amountGbp: 1000,
  effectHorizonGbp: horizon,
  effectToDateGbp: toDate,
  returnHorizon: horizon == null ? null : horizon / 1000,
  returnToDate: toDate / 1000,
});

const rows = [
  row("sell", "MSFT", -300, -500),
  row("sell", "SOFI", 120, 40),
  row("sell", "LITE", null, 80),
  row("buy", "NVDA", 200, 450),
  row("buy", "AMZN", -50, -10),
];

describe("decision verdicts", () => {
  it("counts only decisions whose horizon has passed", () => {
    expect(sideVerdict(rows, "sell", "horizon")).toEqual({ count: 3, evaluated: 2, favourable: 1, effect: -180 });
    expect(sideVerdict(rows, "sell", "date")).toEqual({ count: 3, evaluated: 3, favourable: 2, effect: -380 });
  });

  it("orders the costliest and best decisions of a side", () => {
    const sold = notableDecisions(rows, "sell", "date");
    expect(sold.worst.map((r) => r.ticker)).toEqual(["MSFT"]);
    expect(sold.best.map((r) => r.ticker)).toEqual(["LITE", "SOFI"]);
  });

  it("signs gains only", () => {
    expect(signedMoney(42)).toBe("+£42");
    expect(signedMoney(-42)).toBe("-£42");
    expect(signedMoney(0.2)).toBe("£0");
    expect(signedMoney(null)).toBe("—");
  });
});

