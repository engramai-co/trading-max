import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import type { ChartColours } from "@/ui/charts/palette";
import { historyGapSeries, historySeries } from "./history-series";
import { historyDisplayInterval, selectPortfolioHistory } from "./portfolio-history";
import { portfolioMoney } from "./portfolio-money";
import { timelineOption } from "./timeline-option";

const dates = Array.from({ length: 9 }, (_, i) => new Date(Date.UTC(2026, 8, 17, 9, i * 10)).toISOString());
const rows = dates.map((date, i) => ({ date, intraday: true, valuationSource: "broker", total: 100 + i, totalNetContributionsGbp: 90 }) as NavPoint);

describe("gaps at the selected display cadence", () => {
  const cases = [
    ["1D", "2026-09-18"], ["1W", "2026-09-18"], ["1M", "2026-09-18"],
    ["3M", "2026-09-18"], ["6M", "2026-09-18"],
    ["YTD", "2026-01-01"], ["YTD", "2026-01-06"], ["YTD", "2026-01-20"],
    ["YTD", "2026-03-15"], ["YTD", "2026-05-15"], ["YTD", "2026-09-18"],
    ["1Y", "2026-09-18"], ["ALL", "2026-09-18"],
  ] as const;
  it.each(cases)("uses %s (%s) sampling to distinguish a missed collection from a missing display bucket", (range, endDay) => {
    const minutes = historyDisplayInterval(range, endDay), stride = minutes / 10;
    const dates = Array.from({ length: stride * 4 }, (_, i) => new Date(Date.UTC(2026, 8, 7, 0, i * 10)).toISOString());
    const values = dates.map((_, i) => 100 + i);
    const missed = stride + Math.min(1, stride - 1);
    const timeline = { categories: dates, rowIndexes: dates.map((_, i) => i === missed ? null : i), displayIntervalMinutes: minutes };
    const original = structuredClone(timeline);
    const series = historySeries(dates, values, true, timeline);
    expect(historyGapSeries(series)).toHaveLength(stride === 1 ? 3 : 0);
    expect(timeline).toEqual(original);
    for (const point of series.filter((p) => p.value[1] != null)) {
      const index = point.value[0]!;
      expect(index).not.toBe(missed);
      expect(point.value[1]).toBe(values[timeline.rowIndexes[index]!]);
    }

    // Even when financial evidence is absent (rather than an entire row), a
    // completely empty bucket must have dashes anchored at real observations.
    const missingValues = values.map((value, i) => i >= stride && i < stride * 2 ? null : value);
    const allRows = { ...timeline, rowIndexes: dates.map((_, i) => i) };
    const outage = historySeries(dates, missingValues, true, allRows);
    expect(historyGapSeries(outage)).toEqual([
      [stride - 1, values[stride - 1]], [stride * 2, values[stride * 2]], [stride * 2, null],
    ]);
    expect(missingValues.slice(stride, stride * 2)).toEqual(Array(stride).fill(null));
  });
  it.each(["YTD", "1Y", "ALL"] as const)("keeps %s daily gaps while ignoring missing collections within an observed day", (range) => {
    const input = ["2026-09-07T09:00Z", "2026-09-07T09:20Z", "2026-09-08T09:00Z", "2026-09-10T09:00Z", "2026-09-10T09:20Z"]
      .map((date, i) => ({ ...rows[0], date, total: 100 + i }));
    const h = selectPortfolioHistory({ intraday: input, range, scope: "total", requireCashFlows: true });
    const series = historySeries(h.points.map((p) => p.date), h.points.map((p) => p.total), false, h.timeline);
    const gaps = historyGapSeries(series);
    expect(h.timeline.displayIntervalMinutes).toBe(1440);
    expect(gaps).toHaveLength(3);
    expect(gaps[0][1]).toBe(102);
    expect(gaps[1][1]).toBe(104);
    expect(h.points).toEqual(input);
    expect(portfolioMoney(h.points, "total").pnl).toBe(4);
  });
  it("does not create weekend gaps when adjacent trading-time buckets have readings", () => {
    const dates = ["2026-09-04T20:00Z", "2026-09-04T22:50Z", "2026-09-06T23:00Z", "2026-09-07T00:00Z"];
    const timeline = { categories: dates, rowIndexes: [0, 1, 2, 3], displayIntervalMinutes: 240 };
    const series = historySeries(dates, [100, 101, 102, 103], true, timeline);
    expect(historyGapSeries(series)).toEqual([]);
    expect(series.every((p) => p.value[1] != null)).toBe(true);
  });
});

describe("observable gaps and one accounting cutoff", () => {
  it("connects bounded gaps with endpoint-only dashes, preserving leading and trailing missing values", () => {
    const timeline = { categories: dates, rowIndexes: [null, 1, null, null, 4, 5, null, 7, null] };
    const series = historySeries(dates, rows.map((p) => p.total), true, timeline);
    expect(historyGapSeries(series)).toEqual([[1, 101], [4, 104], [4, null], [5, 105], [7, 107], [7, null]]);
    expect(series.every((p) => p.symbolSize === 0)).toBe(true);
    expect(series.filter((p) => p.value[1] != null).map((p) => p.value[0])).toEqual([1, 4, 5, 7]);
  });
  it("shows a single real observation as a small point, with no invented connectors", () => {
    const series = historySeries(dates, dates.map((_, i) => i === 4 ? 100 : null), true);
    expect(historyGapSeries(series)).toEqual([]);
    expect(series[4].symbolSize).toBe(4);
  });
  it.each(["1D", "1W", "1M", "3M"] as const)("aligns %s value, contributions, P&L and headline at their latest common observation", (range) => {
    const input = rows.map((p, i) => ({ ...p, totalNetContributionsGbp: i > 6 ? null : 90 }));
    const history = selectPortfolioHistory({ intraday: input, range, scope: "total", requireCashFlows: true });
    expect(history.pendingCashFlows).toBe(true);
    expect(history.latestObservationAt).toBe(dates[8]);
    expect(history.points.at(-1)?.date).toBe(dates[6]);
    expect(Date.parse(history.timeline.categories.at(-1)!)).toBe(Date.parse(dates[6]));
    expect(portfolioMoney(history.points, "total")).toMatchObject({ ending: 106, contributions: 0, pnl: 6, maxDrawdown: 0 });
    expect(selectPortfolioHistory({ intraday: input, range, scope: "total" }).points).toHaveLength(9);
    const caughtUp = selectPortfolioHistory({ intraday: rows, range, scope: "total", requireCashFlows: true });
    expect(caughtUp.pendingCashFlows).toBe(false);
    expect(caughtUp.points).toHaveLength(9);
  });
  it("does not replace genuinely missing cash-flow evidence with zero", () => {
    const history = selectPortfolioHistory({ intraday: rows.map((p) => ({ ...p, totalNetContributionsGbp: null })), range: "1D", scope: "total", requireCashFlows: true });
    expect(history.points).toHaveLength(9);
    expect(portfolioMoney(history.points, "total").pnl).toBeNull();
  });
  it("keeps contribution changes visible during display sampling", () => {
    const history = selectPortfolioHistory({ intraday: rows.map((p, i) => ({ ...p, totalNetContributionsGbp: i < 3 ? 90 : 95 })), range: "3M", scope: "total" });
    const series = historySeries(dates, history.points.map((p) => p.totalNetContributionsGbp ?? null), true, history.timeline);
    const indexes = series.filter((p) => p.value[1] != null).map((p) => history.timeline.rowIndexes[p.value[0]!]);
    expect(indexes).toEqual(expect.arrayContaining([2, 3]));
  });
  it("keeps gap connectors out of hover readings and suppresses disconnected circles", () => {
    const colours = { brand: "blue", accent: "orange", negative: "red" } as ChartColours;
    const option = timelineOption(dates, [{ label: "Value", lines: [{ name: "NAV", values: rows.map((p) => p.total) }] }], colours, String, { categories: dates, rowIndexes: [0, 1, null, null, 4, 5, 6, 7, 8] });
    const series = option.series as Array<{ id?: string; silent?: boolean; symbol?: string; showSymbol?: boolean; areaStyle?: unknown; tooltip?: unknown; lineStyle?: { type?: string } }>;
    expect(series[0]).toMatchObject({ symbol: "none", showSymbol: false });
    const gap = series.find((line) => line.silent);
    expect(gap).toMatchObject({ symbol: "none", tooltip: { show: false }, lineStyle: { type: "dashed" } });
    expect(gap?.areaStyle).toBeUndefined();
    const tooltip = option.tooltip as { formatter: (input: unknown) => string };
    expect(tooltip.formatter([{ seriesId: gap?.id, value: [4, 104] }])).toBe("");
  });
  it("bridges the area without changing observations, adding zero values, or extending past either endpoint", () => {
    const values = [null, 0, null, null, -4, 5, null, 7, null];
    const original = [...values];
    const option = timelineOption(dates, [{ label: "P&L", zeroBaseline: true, lines: [{ name: "Net P&L", values, area: true }] }], {} as ChartColours, String,
      { categories: dates, rowIndexes: dates.map((_, i) => i) });
    const series = option.series as Array<{ id?: string; connectNulls?: boolean; data: Array<{ value: [number, number | null] }>; areaStyle?: unknown; lineStyle?: unknown }>;
    const observed = series[0];
    const fill = series.find((line) => line.id?.startsWith("history-area:"))!;
    expect(observed.connectNulls).toBe(false);
    expect(observed.areaStyle).toBeUndefined();
    expect(fill).toMatchObject({ connectNulls: true, silent: true, tooltip: { show: false }, areaStyle: { origin: 0 } });
    expect(fill.data).toEqual(observed.data);
    expect(fill.data[0].value).toEqual([0, null]);
    expect(fill.data.at(-1)?.value).toEqual([8, null]);
    expect(fill.data.filter((point) => point.value[1] != null).map((point) => point.value)).toEqual([[1, 0], [4, -4], [5, 5], [7, 7]]);
    expect(values).toEqual(original);
    const tooltip = option.tooltip as { formatter: (input: unknown) => string };
    expect(tooltip.formatter([{ seriesId: fill.id, value: [4, -4] }])).toBe("");
    expect(tooltip.formatter([{ seriesId: fill.id, value: [4, -4] }, { seriesId: "measured", value: [4, -4] }])).toContain("-£4.00");
  });
});
