import { describe, expect, it } from "vitest";
import type { components } from "@/lib/api-schema";
import {
  allDecisions,
  combinedRoundTrips,
  decisionHref,
  journalEntries,
  reviewScope,
  shareShifts,
  tradeEffect,
  type ScopedDecision,
} from "./review-board";
import { decisionExtremes, type AccountDecisions, type TradeDecision } from "./review-decisions";

type Evidence = components["schemas"]["InvestmentReviewEvidence"];
type Fill = components["schemas"]["FillEffect"];

const rules = {
  cashMinSessions: 10, cashShare: 0.1, evidenceDays: 90, recentFillLimit: 8,
  sessionMoveShare: 0.05, weightDriftDays: 30, weightDriftShare: 0.03,
};

function decision(date: string, ticker: string, extra: Partial<TradeDecision> = {}): TradeDecision {
  return {
    date, ticker, name: "Synthetic " + ticker, side: "buy", kind: "B", amountGbp: 100,
    observedDays: 30, horizonComplete: true, returnToDate: 0.02, effectToDateGbp: 2, effectHorizonGbp: 1,
    ...extra,
  };
}
const scoped = (account: "A" | "B", row: TradeDecision): ScopedDecision => ({ ...row, account });

function fill(filledAt: string, ticker: string, before: Fill["before"], after: Fill["after"], side: "buy" | "sell" = "buy"): Fill {
  return { filledAt, ticker, side, quantity: 1, before, after };
}
const shares = (largestHolding: number, cash: number, usdExposure: number) => ({ largestHolding, cash, usdExposure });

describe("the review's scope", () => {
  it("reads every account by default and one account when the address names it", () => {
    expect(reviewScope(null)).toBe("all");
    expect(reviewScope("all")).toBe("all");
    expect(reviewScope("B")).toBe("B");
    expect(reviewScope("C")).toBe("C");
    expect(reviewScope("Z")).toBe("all");
    expect(reviewScope(undefined, "A")).toBe("A");
  });

  it("opens a decision in its account's scope", () => {
    expect(decisionHref("B", { date: "2026-11-03", side: "buy", ticker: "EURUSD=X" }))
      .toBe("/review?account=B&decision=2026-11-03.buy.EURUSD%3DX");
  });

  it("plots both accounts' decisions by date and leaves out an account without a review", () => {
    const reviews = {
      A: { status: "available", decisions: [decision("2026-10-02", "AAA")] },
      B: { status: "available", decisions: [decision("2026-10-01", "BBB")] },
    } as unknown as Parameters<typeof allDecisions>[0];
    expect(allDecisions(reviews).map((row) => row.account + row.ticker)).toEqual(["BBBB", "AAAA"]);
    expect(allDecisions({ ...reviews, B: { status: "unavailable" } } as typeof reviews).map((row) => row.ticker)).toEqual(["AAA"]);
  });

  it("adds round trips across accounts", () => {
    const review = (count: number, favourable: number, resultGbp: number) =>
      ({ status: "available", roundTripSummary: { count, favourable, resultGbp } }) as unknown as AccountDecisions;
    expect(combinedRoundTrips([review(3, 1, -12), review(2, 2, 5), undefined])).toEqual({ count: 5, favourable: 3, result: -7 });
  });
});

describe("what helped and cost the most", () => {
  it("ranks buys and sells together by their effect against not trading", () => {
    const rows = [
      decision("2026-01-01", "UP", { effectHorizonGbp: 300 }),
      decision("2026-01-02", "AVOID", { side: "sell", kind: "S", effectHorizonGbp: 120 }),
      decision("2026-01-03", "MISS", { side: "sell", kind: "S", effectHorizonGbp: -200 }),
      decision("2026-01-04", "DOWN", { effectHorizonGbp: -50 }),
      decision("2026-01-05", "FLAT", { effectHorizonGbp: 0.3 }),
      decision("2026-01-06", "OPEN", { horizonComplete: false, effectHorizonGbp: null }),
    ];
    const { helped, cost } = decisionExtremes(rows, "horizon");
    expect(helped.map((row) => row.ticker)).toEqual(["UP", "AVOID"]);
    expect(cost.map((row) => row.ticker)).toEqual(["MISS", "DOWN"]);
    expect(decisionExtremes(rows, "horizon", 1).helped.map((row) => row.ticker)).toEqual(["UP"]);
  });
});

describe("the recent record", () => {
  it("lists a share only when a day's fills moved it at least a percentage point, largest first", () => {
    expect(shareShifts([])).toEqual([]);
    const shifts = shareShifts([
      fill("2026-11-13T08:01:00Z", "B", shares(0.24, 0.05, 0.33), shares(0.24, 0.03, 0.335)),
      fill("2026-11-13T08:00:00Z", "A", shares(0.235, 0.08, 0.33), shares(0.235, 0.05, 0.33)),
    ]);
    expect(shifts).toEqual([{ key: "cash", before: 0.08, after: 0.03 }]);
    expect(shareShifts([fill("2026-11-13T08:00:00Z", "A", shares(0.2, 0.006, 0.3), shares(0.2, 0.002, 0.3))])).toEqual([]);
  });

  it("gathers a day's decisions in one account, with the side effects of their own fills", () => {
    const evidence: Evidence = {
      rules,
      accounts: {
        B: {
          coverage: "complete",
          fillEffects: [
            fill("2026-11-13T08:00:00Z", "EQGB", shares(0.235, 0.06, 0.33), shares(0.235, 0.04, 0.33)),
            fill("2026-11-13T08:01:00Z", "XUSE", shares(0.235, 0.04, 0.33), shares(0.24, 0.02, 0.33)),
            // An Invest ticker's fill never lands on an ISA day.
            fill("2026-11-13T09:00:00Z", "MU", shares(0.3, 0.2, 0.9), shares(0.4, 0.1, 0.95)),
          ],
        },
      },
    };
    const entries = journalEntries([
      scoped("B", decision("2026-11-13", "EQGB", { amountGbp: 200 })),
      scoped("B", decision("2026-11-13", "XUSE", { amountGbp: 175 })),
      scoped("A", decision("2026-11-13", "MU", { amountGbp: 90 })),
    ], evidence, ["A", "B"]);
    expect(entries.map((entry) => entry.kind + ":" + entry.account)).toEqual(["trade:A", "trade:B"]);
    const isa = entries[1];
    expect(isa.kind === "trade" && isa.rows.map((row) => row.ticker)).toEqual(["EQGB", "XUSE"]);
    expect(isa.kind === "trade" && isa.shifts).toEqual([{ key: "cash", before: 0.06, after: 0.02 }]);
    const invest = entries[0];
    expect(invest.kind === "trade" && invest.shifts).toEqual([]);
  });

  it("puts what was left alone beside what was done, newest first", () => {
    const evidence: Evidence = {
      rules,
      accounts: {
        A: {
          coverage: "partial",
          holdingMoves: [
            { ticker: "SEMI", date: "2026-11-11", change: 0.077, quoteCurrency: "GBP" },
            { ticker: "MU", date: "2026-11-11", change: 0.119, quoteCurrency: "USD" },
          ],
          weightDrifts: [{ ticker: "VRT", start: "2026-10-07", end: "2026-11-03", before: 0.167, after: 0.356 }],
          cashSpans: [{ start: "2026-10-20", end: "2026-11-03", sessions: 11, peakShare: 0.2, averageShare: 0.14 }],
        },
      },
    };
    const entries = journalEntries([scoped("A", decision("2026-11-03", "BE")), scoped("A", decision("2026-11-12", "NVDA"))], evidence, ["A"]);
    expect(entries.map((entry) => entry.kind + ":" + entry.date)).toEqual([
      "trade:2026-11-12", "moves:2026-11-11", "trade:2026-11-03", "drift:2026-11-03", "cash:2026-11-03",
    ]);
    const moves = entries[1];
    expect(moves.kind === "moves" && moves.rows.map((row) => row.ticker)).toEqual(["MU", "SEMI"]);
    // Another account's decisions stay out of this account's record.
    expect(journalEntries([scoped("B", decision("2026-11-12", "XUSE"))], evidence, ["A"]).map((entry) => entry.kind))
      .toEqual(["moves", "drift", "cash"]);
  });

  it("totals a day's results to date and waits while none has a close after it", () => {
    expect(tradeEffect([decision("2026-11-13", "A", { effectToDateGbp: -3 }), decision("2026-11-13", "B", { effectToDateGbp: 5 })])).toBe(2);
    expect(tradeEffect([decision("2026-11-17", "A", { observedDays: 0, returnToDate: null, effectToDateGbp: null })])).toBeNull();
  });
});

