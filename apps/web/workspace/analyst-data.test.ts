import { describe, expect, it } from "vitest";
import {
  normalizeRatingRow,
  ratingSummary,
  recommendationChange,
  targetSnapshot,
  targetSplitScale,
  targetUnitScale,
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
  it("converts pence exactly once and withholds ambiguous or mismatched target units", () => {
    for (const unit of ["GBp", "GBX", "GBx"]) expect(targetUnitScale(unit, "GBP")).toBe(0.01);
    expect(targetUnitScale("GBP", "GBP")).toBe(1);
    expect(targetUnitScale(undefined, "GBP")).toBeNull();
    expect(targetUnitScale("GBp", "USD")).toBeNull();
    expect(targetUnitScale("EUR", "USD")).toBeNull();
    expect(targetUnitScale(undefined, "USD")).toBe(1);
  });
  it("rebases an older snapshot through splits and reverse splits once per effective date", () => {
    const bar = { high: null, low: null, open: null, sma20: null, sma50: null, sma200: null, volume: null };
    const scaleForDay = targetSplitScale({
      points: [{ ...bar, date: "2026-05-01", close: 4 }, { ...bar, date: "2026-05-02", close: 2, split: 2 }, { ...bar, date: "2026-06-01", close: 8, split: 0.25 }],
      events: [{ date: "2026-05-02", kind: "split", value: 2 }, { date: "2026-06-10", kind: "dividend", value: 0.1 }],
    });
    const targets = targetSnapshot({ median: 450 }, 8.5, scaleForDay("2026-05-01", "2026-06-01", 0.01));
    expect(targets.rows[2].value).toBe(9);
    expect(targets.rows[2].change).toBeCloseTo(9 / 8.5 - 1);
    expect(scaleForDay("2026-06-01", "2026-06-01", 1)).toBe(1);
    expect(scaleForDay("2026-05-01", "2026-06-10", 1)).toBeNull();
    expect(scaleForDay("2026-04-30", "2026-06-01", 1)).toBeNull();
    expect(scaleForDay("2026-05-01", "2026-05-02", 1)).toBe(0.5);
    expect(scaleForDay("", "2026-06-01", 1)).toBeNull();
    expect(scaleForDay("2026-05-01", "2026-06-01", null)).toBeNull();
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
