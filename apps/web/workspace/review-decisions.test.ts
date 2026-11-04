import { describe, expect, it } from "vitest";
import {
  decisionContext,
  effectTone,
  eventLabel,
  notableDecisions,
  observing,
  roundTripVerdict,
  sideVerdict,
  signedMoney,
  verdictWord,
  windowObserved,
  type TradeDecision,
} from "./review-decisions";

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

  it("colours only effects that round away from £0", () => {
    expect(effectTone(42)).toBe("up");
    expect(effectTone(-42)).toBe("down");
    expect(effectTone(0)).toBe("flat");
    expect(effectTone(-0.3)).toBe("flat");
    expect(effectTone(null)).toBe("flat");
  });

  it("measures round trips against the range only where the range is known", () => {
    expect(roundTripVerdict({ count: 3, favourable: 2, resultGbp: 55, ranged: 2, rangedResultGbp: 40, rangeGbp: 160 }))
      .toEqual({ count: 3, favourable: 2, result: 55, range: 160, captured: 0.25 });
    expect(roundTripVerdict({ count: 1, favourable: 0, resultGbp: -5, ranged: 0, rangedResultGbp: 0, rangeGbp: 0 }))
      .toEqual({ count: 1, favourable: 0, result: -5, range: null, captured: null });
    expect(roundTripVerdict(undefined).count).toBe(0);
  });

  it("names company events in a few words, ratings and filings in Chinese", () => {
    const en = (_zh: string, english: string) => english;
    const zh = (chinese: string) => chinese;
    expect(eventLabel({ date: "2026-11-02", kind: "earnings", surprisePct: 8.19 }, zh)).toBe("财报超预期 +8.2%");
    expect(eventLabel({ date: "2026-11-02", kind: "earnings", surprisePct: -3 }, en)).toBe("Results missed -3.0%");
    expect(eventLabel({ date: "2026-11-03", kind: "downgrade", firm: "B. Riley", toGrade: "Neutral" }, zh)).toBe("B. Riley 下调至中性");
    expect(eventLabel({ date: "2026-11-03", kind: "upgrade", firm: "Mizuho", toGrade: "Outperform" }, en)).toBe("Mizuho upgrade to Outperform");
    expect(eventLabel({ date: "2026-11-03", kind: "initiate", firm: "Wedbush", toGrade: "Outperform" }, zh)).toBe("Wedbush 首次覆盖：跑赢大盘");
    expect(eventLabel({ date: "2026-11-03", kind: "initiate", firm: "Citi", toGrade: "Buy" }, en)).toBe("Citi initiates Buy");
    expect(eventLabel({ date: "2026-10-09", kind: "filing", form: "8-K" }, zh)).toBe("重大事项公告");
    expect(eventLabel({ date: "2026-10-09", kind: "filing", form: "10-K" }, en)).toBe("10-K");
    expect(eventLabel({ date: "2026-10-09", kind: "news", title: "x".repeat(80) }, en)).toHaveLength(60);
  });

  it("treats a decision without a later close as observing, not as a £0 outcome", () => {
    const today = { ...row("buy", "AAPL", null, 0), observedDays: 0, horizonComplete: false, marketReturnToDate: 0 };
    const nvda = { ...row("buy", "NVDA", 200, 450), observedDays: 30, horizonComplete: true };
    expect(observing(today)).toBe(true);
    expect(observing(nvda)).toBe(false);
    // To date it is not scored at all, so it neither helps nor counts against a side.
    expect(sideVerdict([today, nvda], "buy", "date")).toEqual({ count: 2, evaluated: 1, favourable: 1, effect: 450 });
    expect(decisionContext(today, "date", (zh) => zh, "zh")).toEqual([]);
  });

  it("scores an unchanged price after later closes as a genuine zero outcome", () => {
    const flat = { ...row("buy", "FLAT", 0, 0), observedDays: 25, horizonComplete: true };
    expect(observing(flat)).toBe(false);
    expect(sideVerdict([flat], "buy", "horizon")).toEqual({ count: 1, evaluated: 1, favourable: 0, effect: 0 });
    expect(sideVerdict([flat], "buy", "date")).toEqual({ count: 1, evaluated: 1, favourable: 0, effect: 0 });
  });

  it("reads older artifacts without the close count as observed unless they have no return", () => {
    expect(observing(row("buy", "OLD", null, 0))).toBe(false);
    expect(observing({ ...row("buy", "OLD", null, 0), returnToDate: null, effectToDateGbp: null })).toBe(true);
    // The horizon falls back to whether its effect exists.
    expect(windowObserved(row("sell", "OLD", null, 80), "horizon")).toBe(false);
    expect(windowObserved(row("sell", "OLD", 120, 80), "horizon")).toBe(true);
  });

  it("keeps the benchmark of every window that has closes, even when the price came back", () => {
    const roundAgain = {
      ...row("sell", "ANET", -127, 0),
      observedDays: 25,
      horizonComplete: true,
      marketReturnHorizon: 0.03,
      marketReturnToDate: 0.01,
    };
    expect(decisionContext(roundAgain, "horizon", (zh) => zh, "zh")).toEqual(["标普 500 同期 +3.0%"]);
    expect(decisionContext(roundAgain, "date", (zh) => zh, "zh")).toEqual(["标普 500 同期 +1.0%"]);
    // A window that has not closed shows no benchmark, while a closed one does.
    const young = { ...roundAgain, observedDays: 5, horizonComplete: false, marketReturnHorizon: null };
    expect(decisionContext(young, "horizon", (zh) => zh, "zh")).toEqual([]);
    expect(decisionContext(young, "date", (zh) => zh, "zh")).toEqual(["标普 500 同期 +1.0%"]);
  });

  it("says what an effect means instead of relying on its sign", () => {
    const zh = (chinese: string) => chinese;
    expect(verdictWord("buy", 649, zh)).toBe("赚");
    expect(verdictWord("buy", -376, zh)).toBe("亏");
    // Positive always means the decision helped: a sale before a fall avoided a loss.
    expect(verdictWord("sell", 98, zh)).toBe("少亏");
    expect(verdictWord("sell", -302, zh)).toBe("少赚");
    expect(verdictWord("sell", 0.4, zh)).toBe("");
  });

  it("puts the market move first, then each event with its date", () => {
    // Dates in the current year show without the year.
    const june = new Date().getFullYear() + "-06-02";
    const decision = {
      ...row("sell", "ANET", -127, -150),
      marketReturnHorizon: 0.002,
      events: [{ date: june, kind: "filing" as const, form: "8-K" }],
    };
    expect(decisionContext(decision, "horizon", (zh) => zh, "zh")).toEqual(["标普 500 同期 +0.2%", "6月2日 重大事项公告"]);
  });
});

