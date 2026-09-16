import { describe, expect, it } from "vitest";
import {
  normalizeRatingRow,
  ratingSummary,
  recommendationChange,
  targetSnapshot,
} from "./analyst-data";

describe("analyst evidence", () => {
  it("maps Yahoo sell and strongSell into the five rating bands exactly once", () => {
    const row = { period: "0m", strongBuy: 1, buy: 2, hold: 3, sell: 4, strongSell: 5 };
    const normalized = normalizeRatingRow(row);
    expect(normalizeRatingRow(normalized)).toEqual(normalized);
    expect(ratingSummary([row])).toMatchObject({
      counts: [1, 2, 3, 4, 5], complete: true, knownTotal: 15, score: 55 / 15,
    });
    expect(ratingSummary([{ ...row, strongSell: null }]).score).toBeNull();
  });
  it("uses current coverage and weights the actual rating counts", () => {
    const summary = ratingSummary([
      {
        period: "-1m",
        strongBuy: 0,
        buy: 0,
        hold: 0,
        underperform: 0,
        sell: 10,
      },
      { period: "0m", strongBuy: 4, buy: 8, hold: 3, underperform: 1, sell: 0 },
    ]);
    expect(summary.knownTotal).toBe(16);
    expect(summary.score).toBe(33 / 16);
    expect(summary.period).toBe("0m");
  });
  it("does not turn missing ratings into zero or invent consensus", () => {
    expect(ratingSummary([{ period: "0m", buy: 8 }])).toMatchObject({
      complete: false,
      knownTotal: 8,
      score: null,
      counts: [null, 8, null, null, null],
    });
    expect(
      ratingSummary([
        { strongBuy: 0, buy: 0, hold: 0, underperform: 0, sell: 0 },
      ]).score,
    ).toBeNull();
    expect(ratingSummary([{ strongBuy: -1, buy: 2.5 }]).counts).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
  it("selects the most recent historical period without calling it current", () => {
    expect(
      ratingSummary([
        { period: "-3m", buy: 4 },
        { period: "-1m", buy: 8 },
      ]),
    ).toMatchObject({ period: "-1m", knownTotal: 8 });
  });
  it("keeps mean and median distinct and calculates changes against a valid spot", () => {
    const targets = targetSnapshot(
      { low: 80, mean: 110, median: 120, high: 150 },
      100,
    );
    expect(targets.range).toEqual([80, 150]);
    expect(targets.rows[1].value).toBe(110);
    expect(targets.rows[2].change).toBeCloseTo(0.2);
    expect(targetSnapshot({ median: 120 }, 0).rows[2].change).toBeNull();
  });
  it("preserves absent endpoints and rejects inverted ranges", () => {
    expect(targetSnapshot({ mean: 110, high: 150 }, 100).range).toBeNull();
    expect(targetSnapshot({ low: 150, high: 80 }, 100).range).toBeNull();
    expect(
      targetSnapshot({ median: -1, high: "" }, null).rows.every(
        (r) => r.value == null,
      ),
    ).toBe(true);
  });
  it("reads both provider field conventions and Unix rating dates", () => {
    expect(
      recommendationChange({
        epochGradeDate: 1786665600,
        firm: "Demo Research",
        fromGrade: "Buy",
        toGrade: "Hold",
        action: "down",
      }),
    ).toMatchObject({
      date: "2026-08-14",
      firm: "Demo Research",
      from: "Buy",
      to: "Hold",
      action: "down",
    });
    expect(
      recommendationChange({
        GradeDate: "2026-08-14",
        Firm: "Demo Research",
        FromGrade: "Hold",
        ToGrade: "Buy",
        Action: "up",
      }).to,
    ).toBe("Buy");
  });
});
