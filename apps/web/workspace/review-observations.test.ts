import { expect, it } from "vitest";
import type { components } from "@/lib/api-schema";
import { fillRows, orderReviewObservations, shortMoveBasis } from "./review-observations";

const rules = {
  cashMinSessions: 10, cashShare: 0.1, evidenceDays: 90, recentFillLimit: 8,
  sessionMoveShare: 0.05, sessionMoveVolatility: { multiple: 2.5, lookbackSessions: 60, minReturns: 20, maxRowsPerHolding: 3 }, weightDriftDays: 30, weightDriftShare: 0.03,
};

it("keeps each available rule visible even after a burst of daily moves", () => {
  const payload: components["schemas"]["InvestmentReviewEvidence"] = {
    rules,
    accounts: {
      A: {
        coverage: "complete",
        holdingMoves: Array.from({ length: 6 }, (_, i) => ({
          ticker: "SYN", date: "2026-11-0" + (i + 1), change: 0.10, quoteCurrency: "GBP",
        })),
      },
      B: {
        coverage: "partial",
        cashSpans: [{ start: "2026-09-01", end: "2026-09-30", sessions: 22, averageShare: 0.13, peakShare: 0.16 }],
        weightDrifts: [{ start: "2026-10-01", end: "2026-10-30", ticker: "SYND", before: 0.2, after: 0.24 }],
      },
    },
  };
  const rows = orderReviewObservations(payload);
  expect(rows.slice(0, 4).map(({ kind, account }) => [kind, account])).toEqual([
    ["move", "A"], ["drift", "B"], ["cash", "B"], ["move", "A"],
  ]);
  expect(rows).toHaveLength(8);
});

it("orders the individual fills by instant across account timestamps", () => {
  const weights = { cash: 0.15, largestHolding: 0.2, usdExposure: 0.55 };
  const fill = { side: "buy" as const, ticker: "SYN", quantity: 0.5, before: weights, after: weights };
  const rows = fillRows({
    rules,
    accounts: {
      A: { coverage: "complete", fillEffects: [{ ...fill, filledAt: "2026-11-09T15:30:00Z" }] },
      B: { coverage: "partial", fillEffects: [{ ...fill, filledAt: "2026-11-09T14:45:00-01:00" }] },
    },
  });
  expect(rows.map((row) => row.account)).toEqual(["B", "A"]);
});


it("marks only short-history moves with their actual floor in each language", () => {
  const row = {
    date: "2026-11-06", ticker: "SYN", quoteCurrency: "USD", change: -0.072,
    basis: "short_history" as const, priorReturns: 19, threshold: 0.055,
  };
  expect(shortMoveBasis(row, "zh")).toBe("历史不足，采用 5.5% 阈值");
  expect(shortMoveBasis(row, "en")).toBe("Limited history · 5.5% floor");
  expect(shortMoveBasis({ ...row, basis: "volatility", priorReturns: 60 }, "en")).toBeNull();
});
