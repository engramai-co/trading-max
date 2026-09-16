import type { NavPoint } from "@/lib/types";
import {
  naturalCalendarTimeline,
  naturalDayBounds,
  omitPortfolioWeekendDisplayWindow,
  portfolioCalendarDateKey,
  summarizeTimelineCoverage,
} from "@/lib/chart-domain";
import { navNumber, type Range, type Scope } from "./data";

export type CalendarTimeline = {
  categories: string[];
  rowIndexes: Array<number | null>;
  anchors?: boolean[];
  displayIntervalMinutes?: number;
};
const displayIntervals = { "1D": 10, "1W": 30, "1M": 60, "3M": 120 } as const;
const DAY = 86_400_000;
const CALENDAR_ZONE = "Europe/London";

export function historyDay(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : portfolioCalendarDateKey(date)!;
}
function shiftedDay(day: string, offset: number) {
  return new Date(Date.parse(day) + offset * DAY).toISOString().slice(0, 10);
}
function weekday(day: string) {
  const number = new Date(day).getUTCDay();
  return number !== 0 && number !== 6;
}
function lastWeekday(day: string) {
  while (!weekday(day)) day = shiftedDay(day, -1);
  return day;
}
function monthsBefore(day: string, months: number) {
  const date = new Date(day);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months + 1, 0));
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(),
    Math.min(date.getUTCDate(), end.getUTCDate()))).toISOString().slice(0, 10);
}
export function historyWindow(range: Range, lastDay: string) {
  const endDay = lastWeekday(lastDay);
  let startDay = endDay;
  if (range === "1W") {
    for (let count = 1; count < 5; count++) startDay = lastWeekday(shiftedDay(startDay, -1));
  } else if (range === "YTD") startDay = endDay.slice(0, 4) + "-01-01";
  else if (range !== "1D" && range !== "ALL") {
    const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24 };
    startDay = monthsBefore(endDay, months[range]);
  }
  return { startDay: range === "ALL" ? undefined : startDay, endDay };
}

/** Source choice is automatic. Sampling changes display density, never source calculations. */
export function selectPortfolioHistory({
  daily = [], intraday = [], range, scope, asOf,
}: {
  daily?: NavPoint[];
  intraday?: NavPoint[];
  range: Range;
  scope: Scope;
  asOf?: string | null;
}) {
  const validDate = (p: NavPoint) => Number.isFinite(Date.parse(p.date));
  const sorted = (rows: NavPoint[]) => [...rows].filter(validDate)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const dailyRows = sorted(daily.filter((p) => !p.intraday));
  const cfdValue = dailyRows.findLast((p) => navNumber(p, "cfd") != null)?.cfd ?? null;
  // Household intraday from the API is A+B only. Add the explicit, historical CFD proxy.
  const projected = scope === "household" && cfdValue != null
    ? intraday.map((p) => ({ ...p, household: p.total == null ? null : p.total + cfdValue }))
    : intraday;
  const intradayRows = scope === "cfd" || (scope === "household" && cfdValue == null)
    ? [] : sorted(projected.filter((p) => p.intraday));
  const usable = (rows: NavPoint[]) => rows.filter((p) => navNumber(p, scope) != null);
  const references = [...usable(dailyRows), ...usable(intradayRows)].map((p) => p.date);
  if (asOf && Number.isFinite(Date.parse(asOf))) references.push(asOf);
  const latestDay = references.map(historyDay).sort().at(-1);
  const window = latestDay ? historyWindow(range, latestDay) : { startDay: undefined, endDay: undefined };
  const within = (rows: NavPoint[]) => usable(rows).filter((p) => {
    const day = historyDay(p.date);
    return (!window.startDay || day >= window.startDay) && (!window.endDay || day <= window.endDay);
  });
  const dailyPoints = within(dailyRows);
  const observations = within(intradayRows);
  const short = ["1D", "1W", "1M", "3M"].includes(range);
  const fallback = short && (scope === "cfd" || (scope === "household" && cfdValue == null));
  const source = short && !fallback ? "intraday" as const : "daily" as const;
  const points = source === "intraday" ? observations : dailyPoints;
  let timeline: CalendarTimeline = { categories: [], rowIndexes: [] };
  if (source === "intraday" && points.length && window.startDay && window.endDay) {
    const calendarDays = Math.round((Date.parse(window.endDay) - Date.parse(window.startDay)) / DAY) + 1;
    const lastReference = references.filter((date) => historyDay(date) === window.endDay)
      .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    const end = lastReference && lastReference.includes("T") ? lastReference
      : new Date(Date.parse(naturalDayBounds(window.endDay + "T12:00:00Z")!.end) - 1).toISOString();
    timeline = omitPortfolioWeekendDisplayWindow(naturalCalendarTimeline(
      points, 10,
      calendarDays, false, true, CALENDAR_ZONE, end,
    ));
    timeline.displayIntervalMinutes = displayIntervals[range as keyof typeof displayIntervals];
  } else if (source === "daily" && points.length) {
    const rowByDay = new Map(points.map((p, index) => [historyDay(p.date), index]));
    const start = window.startDay ?? historyDay(points[0].date);
    for (let day = start; day <= window.endDay!; day = shiftedDay(day, 1)) {
      if (!weekday(day)) continue;
      timeline.categories.push(day);
      timeline.rowIndexes.push(rowByDay.get(day) ?? null);
    }
  }
  const coverage = summarizeTimelineCoverage(timeline.categories, timeline.rowIndexes, 1);
  const visiblePoints = points.filter((point) => weekday(historyDay(point.date)));
  coverage.status = visiblePoints.length === 0 ? "empty" : visiblePoints.length === 1 ? "single" : timeline.rowIndexes.some((row) => row == null) ? "partial" : "complete";
  coverage.firstObservedAt = visiblePoints[0]?.date ?? null;
  coverage.lastObservedAt = visiblePoints.at(-1)?.date ?? null;
  // Preserve both readings at a source transition when reducing display density.
  // A different source is not an absent observation and must not create a gap.
  timeline.anchors = timeline.rowIndexes.map(() => false);
  timeline.rowIndexes.forEach((row, index) => {
    const previousRow = timeline.rowIndexes[index - 1];
    if (row != null && previousRow != null && points[row].valuationSource !== points[previousRow].valuationSource) {
      timeline.anchors![index - 1] = true;
      timeline.anchors![index] = true;
    }
  });
  return {
    points, source, fallback, timeline, coverage, ...window,
    carriedCfdValue: source === "intraday" && scope === "household" ? cfdValue : null,
  };
}
export type PortfolioHistory = ReturnType<typeof selectPortfolioHistory>;

export function valuationNote(point: NavPoint, t: (zh: string, en: string) => string) {
  if (!point.intraday) return t("日终估值", "End-of-day valuation");
  const minutes = Math.round((point.cadenceSeconds ?? 600) / 60);
  return (point.valuationSource === "reconstructed" ? t("账本重建", "Ledger reconstruction") : t("券商记录", "Broker observation"))
    + " · " + minutes + t(" 分钟估值", " min valuation")
    + (point.includesExtendedHours ? t(" · 含盘前盘后", " · extended hours") : "")
    + ((point.priceCadenceSeconds ?? 0) > 600 ? t(" · 小时行情", " · hourly market prices") : "");
}
