import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import { historyDisplayInterval, selectPortfolioHistory } from "@/lib/portfolio/history";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import { portfolioMoney } from "@/lib/portfolio/money";

function point(date: string, intraday = false, value: number | null = 100): NavPoint {
  return {
    date, intraday, flowStatus: intraday ? "unverified" : "daily_official",
    invest: value, isa: value, total: value, household: value, cfd: intraday ? null : value,
    investTwr: null, isaTwr: null, totalTwr: null,
    investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null,
  };
}
const daily = [point("2026-08-01"), point("2026-09-01"), point("2026-09-04")];
const intraday = [point("2026-09-04T13:30:00Z", true), point("2026-09-04T13:40:00Z", true, 120)];
const input = { daily, intraday, scope: "total" as const, asOf: "2026-09-04T20:00:00Z" };

describe("unified portfolio history", () => {
  it("does not reuse an old CFD proxy after a newer conversion becomes unavailable", () => {
    const result = selectPortfolioHistory({
      ...input, range: "3M", scope: "household",
      daily: [daily[0], { ...daily[2], cfd: null, household: null }],
    });
    expect(result.source).toBe("daily");
    expect(result.carriedCfdValue).toBeNull();
    expect(result.points.some((p) => p.intraday)).toBe(false);
    expect(result.points.some((p) => p.date === daily[2].date)).toBe(false);
  });
  it.each(["1D", "1W", "1M", "3M"] as const)("uses intraday valuations for %s", (range) => {
    const result = selectPortfolioHistory({ ...input, range });
    expect(result.source).toBe("intraday");
    expect(result.points).toEqual(intraday);
    expect(result.points.every((p) => p.totalTwr === null)).toBe(true);
  });
  it.each(["YTD", "1Y", "ALL"] as const)("uses daily resolution with a common latest value for %s", (range) => {
    const result = selectPortfolioHistory({ ...input, range });
    expect(result.source).toBe("daily");
    expect(new Set(result.timeline.categories).size).toBe(result.timeline.categories.length);
    expect(result.points.at(-1)).toEqual(intraday.at(-1));
    expect(result.timeline.rowIndexes.at(-1)).toBe(result.points.length - 1);
  });
  it("keeps 6M intraday detail and genuine earlier daily history without inventing observations", () => {
    const history = selectPortfolioHistory({ ...input, range: "6M" });
    expect(history.source).toBe("intraday");
    expect(history.timeline.displayIntervalMinutes).toBe(240);
    expect(history.startDay).toBe("2026-03-04");
    expect(history.points).toEqual([...daily.slice(0, 2), ...intraday]);
    expect(history.points.at(-1)).toEqual(selectPortfolioHistory({ ...input, range: "3M" }).points.at(-1));
  });
  it("keeps intraday drawdown extrema in year-view calculations while drawing daily observations", () => {
    const records = [100, 70, 110].map((v, i) => ({
      ...point(`2026-09-04T1${i}:00Z`, true, v), totalNetContributionsGbp: 100,
    }));
    const history = selectPortfolioHistory({ ...input, daily: [], range: "1Y", intraday: records });
    expect(portfolioMoney(history.points, "total")).toMatchObject({ pnl: 10, maxDrawdown: -30 });
    expect(history.timeline.rowIndexes.filter((row) => row != null)).toEqual([2]);
  });
  it("uses daily history honestly if the whole six-month period predates retained intraday data", () => {
    const history = selectPortfolioHistory({ ...input, range: "6M", intraday: [] });
    expect(history.points).toEqual(daily);
    expect(history.points.every((p) => !p.intraday)).toBe(true);
  });
  it.each([
    ["2026-01-01", 10], ["2026-01-05", 30], ["2026-01-20", 60],
    ["2026-03-31", 120], ["2026-06-30", 240], ["2026-09-18", 1440],
  ] as const)("adapts YTD to its elapsed span on %s", (end, minutes) => {
    expect(historyDisplayInterval("YTD", end)).toBe(minutes);
  });
  it("does not refill missed broker dates from the daily or reconstructed series in longer ranges", () => {
    const history = selectPortfolioHistory({ ...input, range: "6M", intraday: [
      { ...point("2026-08-10T12:00Z", true, 101), valuationSource: "broker" },
      { ...point("2026-09-01T12:00Z", true, 999), valuationSource: "reconstructed" },
      ...intraday,
    ] });
    expect(history.points.some((p) => p.date.startsWith("2026-09-01"))).toBe(false);
    expect(history.points.at(-1)).toEqual(intraday.at(-1));
  });
  it.each(["3M", "6M", "YTD", "1Y"] as const)("keeps %s at the same verified cash-flow cutoff", (range) => {
    const records = [
      { ...point("2026-09-04T13:20Z", true, 100), totalNetContributionsGbp: 80 },
      { ...point("2026-09-04T13:30Z", true, 110), totalNetContributionsGbp: 80 },
      { ...point("2026-09-04T13:40Z", true, 999), totalNetContributionsGbp: null },
    ];
    const result = selectPortfolioHistory({ ...input, range, intraday: records, requireCashFlows: true });
    expect(result.pendingCashFlows).toBe(true);
    expect(result.points.at(-1)).toEqual(records[1]);
  });
  it("does not substitute daily points when intraday history is unavailable", () => {
    const result = selectPortfolioHistory({ ...input, range: "3M", intraday: [] });
    expect(result).toMatchObject({ source: "intraday", fallback: false, points: [] });
  });
  it("uses five weekdays and does not let stale history move the window", () => {
    const result = selectPortfolioHistory({ ...input, range: "1W", intraday: [point("2026-07-01T12:00Z", true)] });
    expect(result).toMatchObject({ startDay: "2026-08-31", endDay: "2026-09-04", points: [] });
  });
  it("uses calendar months, keeping missing weekdays visible and folding weekends", () => {
    const result = selectPortfolioHistory({ ...input, range: "3M" });
    expect(result.startDay).toBe("2026-06-04");
    expect(result.timeline.categories[0].startsWith("2026-06-03T23:")).toBe(true);
    expect(result.timeline.categories.every((stamp) => ![0, 6].includes(new Date(new Date(stamp).toLocaleString("en-US", { timeZone: "Europe/London" })).getDay()))).toBe(true);
    expect(result.coverage.status).toBe("partial");
  });
  it("shows Friday when opened on a weekend but does not reuse Friday on Monday", () => {
    expect(selectPortfolioHistory({ ...input, range: "1D", asOf: "2026-09-06T12:00Z" }).points).toEqual(intraday);
    expect(selectPortfolioHistory({ ...input, range: "1D", asOf: "2026-09-07T12:00Z" }).points).toEqual([]);
  });
  it("keeps one valid zero value visible and never invents another observation", () => {
    const result = selectPortfolioHistory({ ...input, range: "1D", intraday: [point("2026-09-04T12:00Z", true, 0)] });
    expect(result.points).toHaveLength(1);
    expect(result.points[0].total).toBe(0);
  });
  it.each(["1D", "1W", "1M", "3M"] as const)("uses reconstruction only before broker collection begins in %s", (range) => {
    const records = Array.from({ length: 144 }, (_, index) => ({
      ...point(new Date(Date.parse("2026-09-03T23:00Z") + index * 600_000).toISOString(), true, 100 + index),
      valuationSource: index === 91 || index >= 94 ? "broker" as const : "reconstructed" as const,
    }));
    const result = selectPortfolioHistory({ ...input, range, intraday: records, asOf: records.at(-1)!.date });
    expect(result.points).toEqual(records.filter((_, i) => i !== 92 && i !== 93));
    expect(result.points[90].valuationSource).toBe("reconstructed");
    expect(result.points.slice(91).every((p) => p.valuationSource === "broker")).toBe(true);
    const series = historySeries(result.points.map((p) => p.date), result.points.map((p) => p.total), true, result.timeline);
    expect(series.some((p) => p.value[1] === records[90].total)).toBe(true);
    expect(series.some((p) => p.value[1] === records[91].total)).toBe(true);
    expect(series.some((p) => p.value[1] === records[92].total || p.value[1] === records[93].total)).toBe(false);
    expect(result.coverage.status).toBe("partial");
  });
  it("does not turn intermittent model residuals into profit or drawdown", () => {
    const records = [100, 100, 130, 101, 131, 99, 102].map((value, i) => ({
      ...point(new Date(Date.UTC(2026, 8, 4, 9, i * 10)).toISOString(), true, value),
      valuationSource: i === 2 || i === 4 ? "reconstructed" as const : "broker" as const,
      totalNetContributionsGbp: 100,
    }));
    const untouched = structuredClone(records);
    const result = selectPortfolioHistory({ ...input, range: "1D", intraday: records, asOf: records.at(-1)!.date });
    expect(result.points.map((p) => p.total)).toEqual([100, 100, 101, 99, 102]);
    expect(portfolioMoney(result.points, "total")).toMatchObject({ opening: 100, ending: 102, pnl: 2, maxDrawdown: -2 });
    expect(records).toEqual(untouched);
  });
  it("preserves real broker spikes, paired model evidence and cumulative cash flows across a missed sample", () => {
    const records = [100, 130, 150, 112].map((value, i) => ({
      ...point(new Date(Date.UTC(2026, 8, 4, 9, i * 10)).toISOString(), true, value),
      valuationSource: i === 1 ? "reconstructed" as const : "broker" as const,
      totalNetContributionsGbp: i < 1 ? 100 : 110,
      investModelValueGbp: i === 2 ? 105 : undefined,
    }));
    const result = selectPortfolioHistory({ ...input, range: "1D", intraday: records, asOf: records.at(-1)!.date });
    expect(result.points).toEqual([records[0], records[2], records[3]]);
    expect(portfolioMoney(result.points, "total")).toMatchObject({ contributions: 10, pnl: 2, maxDrawdown: -38 });
  });
  it("keeps all-model history when collection has not started, but never resumes it after collection", () => {
    const records = intraday.map((p) => ({ ...p, valuationSource: "reconstructed" as const }));
    expect(selectPortfolioHistory({ ...input, range: "1D", intraday: records }).points).toEqual(records);
    const broker = { ...point("2026-09-01T12:00Z", true), valuationSource: "broker" as const };
    expect(selectPortfolioHistory({ ...input, range: "1D", intraday: [broker, ...records] }).points).toEqual([]);
  });
  it("reports a missing ten-minute slot and stale trailing coverage", () => {
    const records = Array.from({ length: 144 }, (_, index) => point(new Date(Date.parse("2026-09-03T23:00Z") + index * 600_000).toISOString(), true));
    const result = selectPortfolioHistory({ ...input, range: "1D", intraday: records.filter((_, i) => i !== 91), asOf: records.at(-1)!.date });
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.gaps).toMatchObject([{ startIndex: 91, endIndex: 91 }]);
    const stale = selectPortfolioHistory({ ...input, range: "1D", intraday: records.slice(0, -3), asOf: records.at(-1)!.date });
    expect(stale.coverage.status).toBe("partial");
  });
  it("retains raw weekend records for calculations while folding them from the chart", () => {
    const weekend = point("2026-08-30T12:00Z", true, 90);
    const result = selectPortfolioHistory({ ...input, range: "1M", intraday: [weekend, ...intraday] });
    expect(result.points[0]).toEqual(weekend);
    expect(result.timeline.rowIndexes.includes(0)).toBe(false);
  });
  it("does not describe the A+B source as a live CFD valuation", () => {
    expect(selectPortfolioHistory({ ...input, range: "3M", scope: "cfd" })).toMatchObject({ source: "daily", fallback: true });
    const household = selectPortfolioHistory({ ...input, range: "3M", scope: "household" });
    expect(household.carriedCfdValue).toBe(100);
    expect(household.points[0].household).toBe(200);
  });
  it("rejects invalid dates and missing values without mutating the source", () => {
    const reversed = [intraday[1], point("invalid", true), intraday[0]];
    expect(selectPortfolioHistory({ ...input, intraday: reversed, range: "1W" }).points).toEqual(intraday);
    expect(reversed[0]).toBe(intraday[1]);
    expect(selectPortfolioHistory({ range: "3M", scope: "total" }).points).toEqual([]);
  });
});

describe("visible observation gaps", () => {
  it.each([["1D", 10], ["1W", 30], ["1M", 60], ["3M", 120], ["6M", 240]] as const)("uses fixed %s display buckets without changing ten-minute records", (range, minutes) => {
    const records = Array.from({ length: 144 }, (_, index) => point(new Date(Date.parse("2026-09-03T23:00Z") + index * 600_000).toISOString(), true, index === 31 ? 500 : index === 32 ? 5 : 100));
    const history = selectPortfolioHistory({ ...input, daily: [], range, asOf: records.at(-1)!.date, intraday: records });
    const series = historySeries(history.points.map((p) => p.date), history.points.map((p) => p.total), true, history.timeline);
    expect(history.points).toEqual(records);
    const visible = series.filter((p) => p.value[1] != null);
    const stride = minutes / 10;
    // The London day starts at 23:00 UTC in September; the first 2h/4h
    // bucket therefore ends at 23:50, consistently across range/DST changes.
    const firstEnd = minutes >= 120 ? 5 : stride - 1;
    const expected = [...new Set([0, ...Array.from({ length: Math.ceil((144 - firstEnd) / stride) }, (_, i) => Math.min(143, firstEnd + i * stride)), 143])];
    expect(visible.map((p) => history.timeline.rowIndexes[Number(p.value[0])])).toEqual(expected);
    expect(Math.max(...history.points.map((p) => p.total!))).toBe(500);
    expect(Math.min(...history.points.map((p) => p.total!))).toBe(5);
    expect(series.find((p) => p.value[1] != null)?.value[1]).toBe(100);
    expect(series.at(-1)?.value[1]).toBe(100);
  });
  it("keeps the same 4h boundaries when range starts lie on opposite sides of DST", () => {
    const records = Array.from({ length: 24 }, (_, i) => point(new Date(Date.UTC(2026, 8, 4, i)).toISOString(), true));
    const result = (range: "3M" | "6M") => {
      const history = selectPortfolioHistory({ ...input, daily: [], range, intraday: records, asOf: records.at(-1)!.date });
      history.timeline.displayIntervalMinutes = 240;
      return historySeries(records.map((p) => p.date), records.map((p) => p.total), true, history.timeline)
        .filter((p) => p.value[1] != null).map((p) => history.timeline.rowIndexes[p.value[0]!]);
    };
    expect(result("3M")).toEqual(result("6M"));
  });
  it("draws adjacent earlier daily readings without pretending they are intraday gaps", () => {
    const records = [point("2026-09-01"), point("2026-09-02"), point("2026-09-03T12:00Z", true)];
    const history = selectPortfolioHistory({ ...input, daily: records.slice(0, 2), intraday: records.slice(2), range: "6M" });
    const series = historySeries(history.points.map((p) => p.date), history.points.map((p) => p.total), true, history.timeline);
    const known = series.filter((p) => p.value[1] != null);
    const first = series.indexOf(known[0]), second = series.indexOf(known[1]);
    expect(second - first).toBe(1);
    expect(history.points).toEqual(records);
  });
  it("keeps raw missing slots and source anchors without drawing sub-bucket gaps", () => {
    const dates = Array.from({ length: 1000 }, (_, index) => new Date(Date.parse("2026-09-01T00:00Z") + index * 600_000).toISOString());
    const timeline = { categories: dates, rowIndexes: dates.map((_, index) => index === 42 ? null : index), displayIntervalMinutes: 120, anchors: dates.map((_, index) => index === 77) };
    const series = historySeries(dates, dates.map(() => 100), true, timeline);
    expect(series.some((p) => p.value[0] === 42 && p.value[1] === null)).toBe(false);
    expect(historyGapSeries(series)).toEqual([]);
    expect(timeline.rowIndexes[42]).toBeNull();
    expect(series.filter((p) => p.value[0] === 77).map((p) => p.value[1])).toEqual([100]);
    expect(series.length).toBeLessThan(100);
  });
  it("breaks long intraday gaps instead of stitching daily observations into a continuous path", () => {
    const dates = ["2026-09-01T12:00:00Z", "2026-09-01T12:10:00Z", "2026-09-04T12:00:00Z"];
    const series = historySeries(dates, [100, 110, 120], true);
    expect(series.map((p) => p.value)).toEqual([
      [Date.parse(dates[0]), 100], [Date.parse(dates[1]), 110],
      [Date.parse(dates[2]) - 1, null], [Date.parse(dates[2]), 120],
    ]);
  });
  it("connects isolated observations with dashes without oversized point markers", () => {
    const dates = Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`);
    expect(historySeries(dates, dates.map(() => 100), true)
      .filter((p) => p.value[1] != null).every((p) => p.symbolSize === 0)).toBe(true);
  });
  it("retains explicit missing values and does not break a normal daily weekend", () => {
    const dates = ["2026-09-04", "2026-09-07", "2026-09-08"];
    const series = historySeries(dates, [100, null, 110], false);
    expect(series).toHaveLength(3);
    expect(series[1].value[1]).toBeNull();
  });
  it("shows every missing sample as a dashed connection without inserting values", () => {
    const dates = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 8, 4, 9, i * 10)).toISOString());
    const timeline = { categories: dates, rowIndexes: [0, 1, null, 3, null, null, 6, 7] };
    const series = historySeries(dates, [100, 101, null, 103, null, null, 106, 107], true, timeline);
    expect(series.map((p) => p.value)).toEqual([[0, 100], [1, 101], [2, null], [3, 103], [4, null], [5, null], [6, 106], [7, 107]]);
    expect(historyGapSeries(series)).toEqual([[1, 101], [3, 103], [3, null], [3, 103], [6, 106], [6, null]]);
    expect(timeline.rowIndexes[2]).toBeNull();
  });
  it("keeps unknown financial values and long outages out of the solid observed line", () => {
    const dates = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 8, 4, 9, i * 10)).toISOString());
    const timeline = { categories: dates, rowIndexes: dates.map((_, i) => i) };
    expect(historySeries(dates, [100, 101, null, 103, 104, 105, 106, 107], true, timeline)[2].value).toEqual([2, null]);
    const outage = { ...timeline, rowIndexes: [0, 1, null, null, null, null, 6, 7] };
    expect(historySeries(dates, [100, 101, null, null, null, null, 106, 107], true, outage).map((p) => p.value))
      .toEqual([[0, 100], [1, 101], [2, null], [5, null], [6, 106], [7, 107]]);
  });
  it("uses elapsed time when weekends are folded and preserves leading and trailing gaps", () => {
    const dates = ["2026-09-04T22:40Z", "2026-09-04T22:50Z", "2026-09-06T23:00Z", "2026-09-06T23:10Z", "2026-09-06T23:20Z"];
    const timeline = { categories: dates, rowIndexes: [null, 1, null, 3, null] };
    expect(historySeries(dates, [null, 100, null, 101, null], true, timeline).map((p) => p.value))
      .toEqual([[0, null], [1, 100], [2, null], [3, 101], [4, null]]);
  });
});
