import { describe, expect, it } from "vitest";
import { analystVerdict, nextEarningsDate } from "./analyst-data";
import { filingTitle } from "./research-filings";

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

describe("next earnings date", () => {
  const today = "2026-11-04";
  const stale = { fundamentals: { earningsCalendar: { earningsDates: ["2026-10-22"] } } };
  it("never shows a past calendar date as the next report", () => {
    expect(nextEarningsDate(stale, today)).toBeNull();
    expect(
      nextEarningsDate(
        { ...stale, analyst: { earningsEvents: [{ date: "2027-02-04", status: "provider-estimate" }] } },
        today,
      ),
    ).toBe("2027-02-04");
  });
  it("trusts the service's single date, including its absence", () => {
    expect(nextEarningsDate({ ...stale, nextEarningsDate: "2027-02-04" }, today)).toBe("2027-02-04");
    expect(nextEarningsDate({ nextEarningsDate: null, analyst: { earningsEvents: [{ date: "2027-02-04" }] } }, today))
      .toBeNull();
  });
});

describe("filing titles", () => {
  const zh = (chinese: string) => chinese;
  const en = (_zh: string, english: string) => english;
  it("names forms in Chinese and keeps the provider's description in English", () => {
    expect(filingTitle("10-Q", "Periodic Financial Reports", zh)).toBe("10-Q · 季报");
    expect(filingTitle("8-K/A", "Corporate Changes & Voting Matters", zh)).toBe("8-K/A · 重大事项公告（修订）");
    expect(filingTitle("S-3", "Offering Registrations", zh)).toBe("S-3 · 发行注册");
    expect(filingTitle("SD", "Specialized Disclosure Report …", zh)).toBe("SD · 冲突矿产披露");
    expect(filingTitle("10-Q", "Periodic Financial Reports", en)).toBe("10-Q · Periodic Financial Reports");
    expect(filingTitle("XYZ", "Something new", zh)).toBe("XYZ · Something new");
  });
});

