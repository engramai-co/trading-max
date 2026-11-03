import { describe, expect, it } from "vitest";
import { analystVerdict } from "./analyst-data";

const analyst = {
  providerRecommendationKey: "strong_buy",
  recommendations: [{ period: "0m", strongBuy: 10, buy: 49, hold: 2, sell: 1, strongSell: 0 }],
  priceTargets: { low: 180, mean: 329, median: 315, high: 515 },
  epsTrend: [{ period: "0q", current: 2.47, "90daysAgo": 2.34 }, { period: "+1q", current: 2.75, "90daysAgo": 2.65 }],
  epsRevisions: [{ period: "0q", upLast30days: 0, downLast30days: 1 }],
  earningsHistory: [
    { quarter: "2026-07-31T00:00:00", surprisePercent: 0.0616 },
    { quarter: "2026-04-30T00:00:00", surprisePercent: 0.0554 },
  ],
  earningsEvents: [
    { date: "2026-08-26", status: "reported" },
    { date: "2027-02-25", status: "provider-estimate" },
    { date: "2026-11-17", status: "provider-estimate" },
  ],
};

describe("analyst verdict", () => {
  it("summarises consensus, target, estimate direction and the next report", () => {
    const verdict = analystVerdict(analyst, 202.06, "2026-11-03");
    expect(verdict.consensus).toBe("strongbuy");
    expect(verdict.analysts).toBe(62);
    expect(verdict.targetChange).toBeCloseTo(315 / 202.06 - 1);
    expect(verdict.estimateChange90).toBeCloseTo(2.47 / 2.34 - 1);
    expect([verdict.revisionsUp30, verdict.revisionsDown30]).toEqual([0, 1]);
    expect(verdict.lastSurprise).toBeCloseTo(0.0616);
    expect(verdict.nextReport).toBe("2026-11-17");
  });

  it("leaves unknown facts empty instead of guessing", () => {
    const verdict = analystVerdict({}, null, "2026-11-03");
    expect(verdict).toMatchObject({ consensus: null, analysts: null, targetChange: null, estimateChange90: null, nextReport: null });
  });
});

