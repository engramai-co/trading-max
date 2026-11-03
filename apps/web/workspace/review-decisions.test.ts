import { describe, expect, it } from "vitest";
import { eventLabel, notableDecisions, roundTripVerdict, sideVerdict, signedMoney, type TradeDecision } from "./review-decisions";

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

  it("measures round trips against the range only where the range is known", () => {
    expect(roundTripVerdict({ count: 3, favourable: 2, resultGbp: 55, ranged: 2, rangedResultGbp: 40, rangeGbp: 160 }))
      .toEqual({ count: 3, favourable: 2, result: 55, range: 160, captured: 0.25 });
    expect(roundTripVerdict({ count: 1, favourable: 0, resultGbp: -5, ranged: 0, rangedResultGbp: 0, rangeGbp: 0 }))
      .toEqual({ count: 1, favourable: 0, result: -5, range: null, captured: null });
    expect(roundTripVerdict(undefined).count).toBe(0);
  });

  it("names company events in a few words", () => {
    const en = (_zh: string, english: string) => english;
    const zh = (chinese: string) => chinese;
    expect(eventLabel({ date: "2026-11-02", kind: "earnings", surprisePct: 8.19 }, zh)).toBe("财报超预期 +8.2%");
    expect(eventLabel({ date: "2026-11-02", kind: "earnings", surprisePct: -3 }, en)).toBe("Results missed -3.0%");
    expect(eventLabel({ date: "2026-11-03", kind: "downgrade", firm: "B. Riley", toGrade: "Neutral" }, zh)).toBe("B. Riley 下调至 Neutral");
    expect(eventLabel({ date: "2026-11-03", kind: "initiate", firm: "Citi", toGrade: "Buy" }, en)).toBe("Citi initiates Buy");
    expect(eventLabel({ date: "2026-10-09", kind: "filing", form: "10-K" }, en)).toBe("10-K");
    expect(eventLabel({ date: "2026-10-09", kind: "news", title: "x".repeat(80) }, en)).toHaveLength(60);
  });
});

