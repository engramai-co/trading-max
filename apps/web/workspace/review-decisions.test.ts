import { describe, expect, it } from "vitest";
import {
  contextFit,
  decisionAction,
  decisionContext,
  decisionKeys,
  decisionParam,
  decisionTooltip,
  effectTone,
  eventLabel,
  favourableCount,
  horizonScope,
  latestDecisions,
  linkedDecision,
  notableDecisions,
  observing,
  openingHorizon,
  parseDecisionParam,
  pendingOutcome,
  roundTripVerdict,
  sameDecision,
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

describe("the review index", () => {
  const decision = (date: string, ticker: string, observedDays: number): TradeDecision => ({
    date,
    ticker,
    name: ticker,
    side: "buy",
    kind: "B",
    amountGbp: 100,
    observedDays,
    returnToDate: 0,
  });

  it("counts every observing decision and still lists the latest with an outcome", () => {
    // The lens kept eight of twelve observing decisions beside an older scored one.
    const kept = Array.from({ length: 8 }, (_, index) => decision("2026-11-03", "T" + index, 0));
    const index = latestDecisions({
      A: { status: "available", observingCount: 12, decisions: [decision("2026-10-01", "OLD", 24), ...kept] },
    });
    expect(index).toMatchObject({ watchingCount: 12, watchingMore: true });
    expect(index.watching).toHaveLength(8);
    expect(index.recent.map((row) => [row.account, row.ticker])).toEqual([["A", "OLD"]]);
  });

  it("counts the rows themselves in payloads from before the count", () => {
    const index = latestDecisions({
      B: {
        status: "available",
        decisions: [decision("2026-10-01", "AMD", 5), decision("2026-11-03", "NVDA", 0), decision("2026-11-03", "NVDA", 0)],
      },
    });
    expect(index).toMatchObject({ watchingCount: 2, watching: ["NVDA"], watchingMore: false });
    expect(index.recent.map((row) => [row.account, row.ticker])).toEqual([["B", "AMD"]]);
  });
});

describe("the context line under a decision", () => {
  it("shows every item that fits, keeping no room for +N after the last", () => {
    expect(contextFit([100, 100], 210, 10, 30).shown).toBe(2);
  });

  it("keeps room for +N while items stay hidden, and starts it one gap after the last shown", () => {
    expect(contextFit([100, 100, 100], 260, 10, 30)).toEqual({ shown: 2, at: 220 });
    expect(contextFit([100, 100, 100], 245, 10, 30)).toEqual({ shown: 1, at: 110 });
  });

  it("always shows the first item, shrunk to leave +N its room at the end of the line", () => {
    expect(contextFit([400, 100], 300, 10, 30)).toEqual({ shown: 1, at: 270 });
  });

  it("has nothing to show for an empty line", () => {
    expect(contextFit([], 300, 10, 30).shown).toBe(0);
  });
});

describe("the decision a link opens", () => {
  it("names a decision by day, side and ticker, keeping every dot of the ticker", () => {
    const sale = { date: "2026-10-14", side: "sell" as const, ticker: "SEMI.AS" };
    expect(decisionParam(sale)).toBe("2026-10-14.sell.SEMI.AS");
    expect(parseDecisionParam("2026-10-14.sell.SEMI.AS")).toEqual(sale);
    for (const ticker of ["MU", "BRK.B", "RDS.A.L", "BRK-B", "^GSPC", "EURUSD=X", "AAPL_US_EQ"]) {
      const buy = { date: "2025-01-31", side: "buy" as const, ticker };
      expect(parseDecisionParam(decisionParam(buy))).toEqual(buy);
    }
  });

  it("comes back unchanged through a link's query string", () => {
    const buy = { date: "2026-11-03", side: "buy" as const, ticker: "EURUSD=X" };
    const href = "/account-analysis?" + new URLSearchParams({ account: "B", reviewView: "decisions", decision: decisionParam(buy) });
    expect(href).toContain("decision=2026-11-03.buy.EURUSD%3DX");
    expect(parseDecisionParam(new URL(href, "https://example.test").searchParams.get("decision"))).toEqual(buy);
  });

  it("reads nothing from a value that is not a real day, a side and a ticker", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "garbage",
      "2026-10-14",
      "2026-10-14.buy",
      "2026-10-14.buy.",
      "2026-10-14..SEMI.AS",
      "2026-10-14.hold.SEMI.AS",
      "2026-10-14.BUY.MU",
      "2026-10-14.B.MU",
      "14-10-2026.buy.MU",
      "2026-1-14.buy.MU",
      "2026-13-01.buy.MU",
      "2026-02-30.buy.MU",
      "2026-10-14.buy. MU",
      "2026-10-14.buy.MU\nNVDA",
      "2026-10-14.buy." + "X".repeat(65),
      "SEMI.AS.sell.2026-10-14",
    ]) {
      expect(parseDecisionParam(value)).toBeNull();
    }
    // Space around the whole value, as from a pasted link, is not part of it.
    expect(parseDecisionParam(" 2024-02-29.sell.MU ")).toEqual({ date: "2024-02-29", side: "sell", ticker: "MU" });
  });

  it("opens a decision only when exactly one fits the link", () => {
    const ref = { date: "2026-06-01", side: "sell" as const, ticker: "ABC" };
    const holdings = { ...row("sell", "ABC", 10, 20), name: "ABC Holdings" };
    const mining = { ...row("sell", "ABC", -5, 3), name: "ABC Mining" };
    expect(linkedDecision([holdings, row("buy", "ABC", 1, 1)], ref)).toBe(holdings);
    // Two securities share the ticker: the link could mean either, so it opens neither.
    expect(linkedDecision([holdings, mining], ref)).toBeUndefined();
    expect(linkedDecision([], ref)).toBeUndefined();
    expect(linkedDecision(undefined, ref)).toBeUndefined();
    expect(linkedDecision([holdings], null)).toBeUndefined();
  });

  it("matches only the same day, side and ticker", () => {
    const decision = row("sell", "SEMI.AS", 10, 20);
    expect(sameDecision(decision, { date: "2026-06-01", side: "sell", ticker: "SEMI.AS" })).toBe(true);
    expect(sameDecision(decision, { date: "2026-06-01", side: "buy", ticker: "SEMI.AS" })).toBe(false);
    expect(sameDecision(decision, { date: "2026-06-02", side: "sell", ticker: "SEMI.AS" })).toBe(false);
    expect(sameDecision(decision, { date: "2026-06-01", side: "sell", ticker: "SEMI" })).toBe(false);
  });
});

describe("a decision without an outcome yet", () => {
  const zh = (chinese: string) => chinese;
  const en = (_zh: string, english: string) => english;

  it("says it is observing until a close follows it, never £0", () => {
    const today = { ...row("buy", "AAPL", null, 0), observedDays: 0, horizonComplete: false };
    expect(pendingOutcome(today, "date", 20, zh, "zh")).toBe("观察中");
    expect(pendingOutcome(today, "horizon", 20, en, "en")).toBe("Observing");
  });

  it("counts the trading days that have passed until its window completes", () => {
    const young = { ...row("sell", "MU", null, 12), observedDays: 5, horizonComplete: false };
    expect(pendingOutcome(young, "horizon", 20, zh, "zh")).toBe("5 / 20 个交易日");
    expect(pendingOutcome(young, "horizon", 20, en, "en")).toBe("5 of 20 trading days");
    // To date it already has an outcome.
    expect(pendingOutcome(young, "date", 20, zh, "zh")).toBeNull();
  });

  it("has nothing to add once the window has an outcome, even one of £0", () => {
    const flat = { ...row("buy", "FLAT", 0, 0), observedDays: 25, horizonComplete: true };
    expect(pendingOutcome(flat, "horizon", 20, zh, "zh")).toBeNull();
    expect(pendingOutcome(flat, "date", 20, zh, "zh")).toBeNull();
  });

  it("says the data is pending once the closes are there but the result is not", () => {
    // A late exchange rate: 21 closes, yet the 20-day result is not out.
    const late = { ...row("buy", "LATE", null, 30), observedDays: 21, horizonComplete: false };
    expect(pendingOutcome(late, "horizon", 20, zh, "zh")).toBe("等待数据");
    expect(pendingOutcome(late, "horizon", 20, en, "en")).toBe("Awaiting data");
    const unpublished = { ...row("sell", "GAP", null, 8), observedDays: 25, horizonComplete: true };
    expect(pendingOutcome(unpublished, "horizon", 20, zh, "zh")).toBe("等待数据");
    // To date, a missing result is pending whatever the count.
    const today = { ...row("buy", "TODAY", null, 0), effectToDateGbp: null, observedDays: 3, horizonComplete: false };
    expect(pendingOutcome(today, "date", 20, zh, "zh")).toBe("等待数据");
    expect(pendingOutcome(today, "horizon", 20, zh, "zh")).toBe("3 / 20 个交易日");
  });

  it("reads the same on the decision's row and on its timeline point", () => {
    const young = { ...row("sell", "MU", null, 12), observedDays: 5, horizonComplete: false };
    const late = { ...row("buy", "LATE", null, 30), observedDays: 21, horizonComplete: false };
    for (const [decision, expected] of [[young, "5 / 20 个交易日"], [late, "等待数据"]] as const) {
      const outcome = decisionTooltip(decision, "horizon", 20, zh, "zh").split("\n")[2];
      expect(outcome).toBe(expected);
      expect(outcome).toBe(pendingOutcome(decision, "horizon", 20, zh, "zh"));
    }
    expect(decisionTooltip(late, "horizon", 20, en, "en")).not.toContain("21 of 20");
    expect(decisionTooltip(late, "date", 20, en, "en").split("\n")[2]).toBe("Then +3.0% · +£30");
  });
});

describe("what a decision did, in a list of both sides", () => {
  const zh = (chinese: string) => chinese;
  const en = (_zh: string, english: string) => english;

  it("names the side, and for a T day the side of the shares beyond its round trip", () => {
    expect(decisionAction({ kind: "B", side: "buy" }, zh)).toBe("买入 ");
    expect(decisionAction({ kind: "S", side: "sell" }, en)).toBe("Sold ");
    expect(decisionAction({ kind: "T", side: "buy" }, zh)).toBe("做 T 后净买入 ");
    expect(decisionAction({ kind: "T", side: "sell" }, en)).toBe("Net sold after a T ");
  });
});

describe("the horizon a review opens on", () => {
  it("opens a decision inside its first trading days to date, and anything else at its horizon", () => {
    const young = { ...row("sell", "MU", null, 12), observedDays: 5, horizonComplete: false };
    const settled = { ...row("buy", "NVDA", 40, 60), observedDays: 30, horizonComplete: true };
    expect(openingHorizon(young)).toBe("date");
    expect(openingHorizon(settled)).toBe("horizon");
    expect(openingHorizon(undefined)).toBe("horizon");
  });
});

describe("where a horizon choice is kept", () => {
  it("keeps one entry per account and decision, and one for each account's review without one", () => {
    const sale = { date: "2026-10-14", side: "sell" as const, ticker: "SEMI.AS" };
    expect(horizonScope("A", sale)).toBe(horizonScope("A", { ...sale }));
    expect(horizonScope("A", sale)).not.toBe(horizonScope("B", sale));
    expect(horizonScope("A")).not.toBe(horizonScope("A", sale));
    expect(horizonScope("A")).not.toBe(horizonScope("B"));
  });
});

describe("how many decisions came out favourable", () => {
  it("counts in the words the effect takes, as the help defines them", () => {
    expect(favourableCount("buy", 170, 325, "zh")).toBe("赚 170 / 325 次");
    expect(favourableCount("buy", 170, 325, "en")).toBe("Gained after 170 of 325 buys");
    expect(favourableCount("sell", 120, 251, "zh")).toBe("少亏 120 / 251 次");
    expect(favourableCount("sell", 120, 251, "en")).toBe("Avoided losses after 120 of 251 sells");
  });

  it("counts the effect, dividends included, so a flat close that paid out is a gain and not a rise", () => {
    const paid = { ...row("buy", "DIV", 4, 4), returnHorizon: 0, returnToDate: 0, dividendHorizonGbp: 4, dividendToDateGbp: 4 };
    expect(sideVerdict([paid], "buy", "horizon")).toMatchObject({ evaluated: 1, favourable: 1 });
  });
});

describe("keys for a list of decisions", () => {
  it("keys a lone decision by its day, side and ticker, so a name correction keeps its row", () => {
    const mu = { ...row("buy", "MU", 1, 2), name: "Micron" };
    const corrected = { ...mu, name: "Micron Technology" };
    expect(decisionKeys([mu])).toEqual(decisionKeys([corrected]));
    // Nor do other rows, added or reordered by a refetch, change it.
    expect(decisionKeys([row("sell", "NVDA", 3, 4), corrected])[1]).toBe(decisionKeys([mu])[0]);
  });

  it("tells twins apart by security, and exact repeats by their order", () => {
    const delta = { ...row("sell", "SYND.AS", 10, 20), name: "Synthetic Delta" };
    const twin = { ...delta, name: "Synthetic Delta Holdings" };
    const keys = decisionKeys([delta, twin, delta, row("buy", "MU", 1, 2)]);
    expect(new Set(keys).size).toBe(4);
    expect(decisionKeys([delta, twin])).toEqual(keys.slice(0, 2));
  });

  it("keeps the same decision in two accounts apart", () => {
    const invest = { ...row("buy", "MU", 1, 2), account: "A" };
    const isa = { ...invest, account: "B" };
    expect(new Set(decisionKeys([invest, isa])).size).toBe(2);
  });
});


