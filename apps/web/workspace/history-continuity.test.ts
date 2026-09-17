import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import type { ChartColours } from "@/ui/charts/palette";
import { historyGapSeries, historySeries } from "./history-series";
import { selectPortfolioHistory } from "./portfolio-history";
import { portfolioMoney } from "./portfolio-money";
import { timelineOption } from "./timeline-option";

const dates = Array.from({ length: 9 }, (_, i) => new Date(Date.UTC(2026, 8, 17, 9, i * 10)).toISOString());
const rows = dates.map((date, i) => ({ date, intraday: true, valuationSource: "broker", total: 100 + i, totalNetContributionsGbp: 90 }) as NavPoint);

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
});
