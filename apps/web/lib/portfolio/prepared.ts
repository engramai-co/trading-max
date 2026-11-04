import type { NavPoint } from "@/lib/types";
import { navNumber, type Range, type Scope } from "@/lib/portfolio/nav";
import { historySeries } from "@/lib/portfolio/series";
import { selectPortfolioHistory, type CalendarTimeline, type PortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";

export type HistorySelection = { runId: string; range: Range; scope: Scope };
export type HistoryInput = { runId: string; brokerAsOf: string; dataRevision: string; nav?: NavPoint[]; intradayNav?: NavPoint[] };
export type Money = ReturnType<typeof portfolioMoney>;
const arrays = ["pnls", "pnlPercents", "drawdown", "drawdownPercents", "periodFlows", "valueChanges", "valueChangePercents"] as const;
/** One live sync: the observation taken at an instant falls within this after it. */
export const SYNC_MS = 5 * 60_000;

/** Grid geometry is encoded separately from observations: never interpolated account data. */
export type CompactTimeline = {
  segments: Array<[start: string, count: number, stepMs: number]>;
  rows: Array<[position: number, row: number, anchor: boolean]>;
  displayIntervalMinutes?: number;
};
export function encodeTimeline(timeline: CalendarTimeline, rows: Map<number, number>): CompactTimeline {
  const segments: CompactTimeline["segments"] = [];
  for (let index = 0; index < timeline.categories.length;) {
    const start = timeline.categories[index];
    const step = Date.parse(timeline.categories[index + 1]) - Date.parse(start);
    let count = 1;
    if (Number.isFinite(step)) {
      while (index + count < timeline.categories.length
        && Date.parse(timeline.categories[index + count]) === Date.parse(start) + step * count
        && timeline.categories[index + count].includes("T") === start.includes("T")) count++;
    }
    segments.push([start, count, Number.isFinite(step) ? step : 0]);
    index += count;
  }
  return {
    segments,
    rows: timeline.rowIndexes.flatMap((row, position) => row != null && rows.has(row)
      ? [[position, rows.get(row)!, !!timeline.anchors?.[position]] as [number, number, boolean]] : []),
    displayIntervalMinutes: timeline.displayIntervalMinutes,
  };
}
export function decodeTimeline(compact: CompactTimeline): CalendarTimeline {
  const categories = compact.segments.flatMap(([start, count, step]) => Array.from({ length: count }, (_, index) => {
    if (index === 0) return start;
    const iso = new Date(Date.parse(start) + index * step).toISOString();
    return start.includes("T") ? iso : iso.slice(0, 10);
  }));
  const rowIndexes = categories.map((): number | null => null);
  const anchors = categories.map(() => false);
  for (const [position, row, anchor] of compact.rows) { rowIndexes[position] = row; anchors[position] = anchor; }
  return { categories, rowIndexes, anchors, displayIntervalMinutes: compact.displayIntervalMinutes };
}

export type PreparedHistory = {
  runId: string;
  dataRevision: string;
  sourceCount: number;
  history: Omit<PortfolioHistory, "timeline"> & { timeline: CompactTimeline };
  money: Money;
  /**
   * The cash-flow-adjusted P&L at each opening the request named, on the period
   * figure's own basis and read from every observation, or null when none was
   * taken there. Present only when openings were requested.
   */
  openings?: Record<string, number | null>;
};
export function sliceMoney(money: Money, indexes: number[]): Money {
  const selected = { ...money };
  for (const key of arrays) selected[key] = indexes.map((index) => money[key][index]);
  return selected;
}

/** Money is calculated from every eligible observation BEFORE chart reduction. */
export function prepareHistory(input: HistoryInput, selection: Pick<HistorySelection, "range" | "scope">) {
  const history = selectPortfolioHistory({ daily: input.nav, intraday: input.intradayNav,
    asOf: input.brokerAsOf, ...selection, requireCashFlows: true });
  const money = portfolioMoney(history.points, selection.scope);
  const dates = history.points.map((point) => point.date);
  const selected = new Set<number>();
  if (dates.length) { selected.add(0); selected.add(dates.length - 1); }
  // A union of the existing display selections preserves all plotted lines,
  // including gaps present in only one field. Cash-flow/source anchors survive.
  const values = [
    history.points.map((p) => navNumber(p, selection.scope)),
    history.points.map((p) => navNumber(p, selection.scope, "NetContributionsGbp")),
    ...arrays.map((key) => money[key]),
  ];
  for (const series of values) {
    for (const point of historySeries(dates, series, history.source === "intraday", history.timeline)) {
      if (point.value[1] == null) continue;
      const row = history.timeline.rowIndexes[point.value[0]!];
      if (row != null) selected.add(row);
    }
  }
  const indexes = [...selected].sort((a, b) => a - b);
  const mapping = new Map(indexes.map((index, row) => [index, row]));
  const chart: PreparedHistory = {
    runId: input.runId, dataRevision: input.dataRevision, sourceCount: dates.length,
    history: { ...history, points: indexes.map((index) => history.points[index]), timeline: encodeTimeline(history.timeline, mapping) },
    money: sliceMoney(money, indexes),
  };
  return { chart, history, money };
}

/**
 * The cash-flow-adjusted P&L at the observation taken at each instant: the first
 * timestamped observation at or within one sync after it, from every eligible
 * observation rather than the thinned chart, and on the same basis as the period
 * figure. Null when no observation was taken there.
 */
export function pnlsAt(prepared: Pick<ReturnType<typeof prepareHistory>, "history" | "money">, instants: readonly string[]) {
  const times = prepared.history.points.map((point) => point.date.includes("T") ? Date.parse(point.date) : Number.NaN);
  return Object.fromEntries(instants.map((at) => {
    const instant = Date.parse(at);
    const index = times.findIndex((time) => time >= instant && time <= instant + SYNC_MS);
    return [at, index < 0 ? null : prepared.money.pnls[index] ?? null];
  })) as Record<string, number | null>;
}

export type HistoryPage = {
  runId: string; total: number; page: number; pageSize: number;
  points: NavPoint[]; money: Money; carriedCfdValue: number | null;
};
export function historyPage(prepared: ReturnType<typeof prepareHistory>, page: number, pageSize = 20): HistoryPage {
  const total = prepared.history.points.length;
  const indexes = Array.from({ length: Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize)) }, (_, i) => (page - 1) * pageSize + i);
  return { runId: prepared.chart.runId, total, page, pageSize,
    carriedCfdValue: prepared.history.carriedCfdValue,
    points: indexes.map((i) => prepared.history.points[i]), money: sliceMoney(prepared.money, indexes) };
}
