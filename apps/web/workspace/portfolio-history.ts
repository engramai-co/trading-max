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
const displayIntervals = { "1D": 10, "1W": 30, "1M": 60, "3M": 120, "6M": 240 } as const;
const DAY = 86_400_000;
const CALENDAR_ZONE = "Europe/London";

export const PORTFOLIO_RANGES = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"] as const;
export function portfolioRange(value: string | null): Range {
  return PORTFOLIO_RANGES.find((range) => range === value) ?? "3M";
}
export function portfolioPerformanceHref(scope: Scope, range: Range) {
  const params = new URLSearchParams({ view: "money", range });
  if (scope !== "total") params.set("scope", scope);
  return `/analytics?${params}`;
}

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

/** YTD follows its elapsed span, not a permanently daily source. */
export function historyDisplayInterval(range: Range, endDay?: string) {
  if (range !== "YTD") return displayIntervals[range as keyof typeof displayIntervals] ?? 1440;
  if (!endDay) return 1440;
  const start = endDay.slice(0, 4) + "-01-01";
  const days = (Date.parse(endDay) - Date.parse(start)) / DAY + 1;
  if (days <= 1) return 10;
  if (days <= 7) return 30;
  if (start >= monthsBefore(endDay, 1)) return 60;
  if (start >= monthsBefore(endDay, 3)) return 120;
  if (start >= monthsBefore(endDay, 6)) return 240;
  return 1440;
}

/** Source choice is automatic. Sampling changes display density, never source calculations. */
export function selectPortfolioHistory({
  daily = [], intraday = [], range, scope, asOf, requireCashFlows = false,
}: {
  daily?: NavPoint[];
  intraday?: NavPoint[];
  range: Range;
  scope: Scope;
  asOf?: string | null;
  requireCashFlows?: boolean;
}) {
  const validDate = (p: NavPoint) => Number.isFinite(Date.parse(p.date));
  const sorted = (rows: NavPoint[]) => [...rows].filter(validDate)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const dailyRows = sorted(daily.filter((p) => !p.intraday));
  // The API carries the latest CFD state into each daily row. A later null
  // rejects an earlier amount (for example, missing conversion evidence).
  const cfdAnchor = dailyRows.at(-1);
  const cfdValue = cfdAnchor?.cfd ?? null;
  const householdFlows = navNumber(cfdAnchor, "household", "NetContributionsGbp");
  const investmentFlows = navNumber(cfdAnchor, "total", "NetContributionsGbp");
  const cfdFlowOffset = householdFlows != null && investmentFlows != null ? householdFlows - investmentFlows : null;
  // Household intraday from the API is A+B only. Add the explicit, historical CFD proxy.
  const projected = scope === "household" && cfdValue != null
    ? intraday.map((p) => {
      const value = p.total == null ? null : p.total + cfdValue;
      const flows = p.totalNetContributionsGbp != null && cfdFlowOffset != null ? p.totalNetContributionsGbp + cfdFlowOffset : null;
      return { ...p, household: value, householdNetContributionsGbp: flows, householdNetPnlGbp: value != null && flows != null ? value - flows : null };
    })
    : intraday;
  const intradayRows = scope === "cfd" || (scope === "household" && cfdValue == null)
    ? [] : sorted(projected.filter((p) => p.intraday));
  const usable = (rows: NavPoint[]) => rows.filter((p) => navNumber(p, scope) != null);
  const availableIntraday = usable(intradayRows);
  // A reconstruction can use different marks from the broker (particularly
  // overnight). Inserting those estimates into missed collection slots creates
  // fictitious returns and drawdowns. Keep one source once collection starts;
  // the immutable input and paired model values remain available as evidence.
  // Determine this boundary before applying the requested date window.
  const firstObserved = availableIntraday.find((p) => p.valuationSource !== "reconstructed");
  const observedFrom = firstObserved ? Date.parse(firstObserved.date) : Infinity;
  const primaryIntraday = availableIntraday.filter((p) =>
    p.valuationSource !== "reconstructed" || Date.parse(p.date) < observedFrom);
  const references = [...usable(dailyRows), ...usable(intradayRows)].map((p) => p.date);
  if (asOf && Number.isFinite(Date.parse(asOf))) references.push(asOf);
  const latestDay = references.map(historyDay).sort().at(-1);
  const window = latestDay ? historyWindow(range, latestDay) : { startDay: undefined, endDay: undefined };
  const within = (rows: NavPoint[]) => usable(rows).filter((p) => {
    const day = historyDay(p.date);
    return (!window.startDay || day >= window.startDay) && (!window.endDay || day <= window.endDay);
  });
  const interval = historyDisplayInterval(range, window.endDay);
  const intradayRange = interval < 1440;
  const allowDailyPrefix = !intradayRange || range === "6M" || range === "YTD";
  const fallback = intradayRange && (scope === "cfd" || (scope === "household" && cfdValue == null));
  const source = intradayRange && !fallback && !(allowDailyPrefix && !primaryIntraday.length)
    ? "intraday" as const : "daily" as const;
  // Use the same eligible history at every range. Older daily records remain
  // daily; they must not fill missed broker slots or become synthetic intraday.
  const firstIntradayDay = primaryIntraday[0] ? historyDay(primaryIntraday[0].date) : null;
  const dailyPrefix = dailyRows.filter((p) => !firstIntradayDay || historyDay(p.date) < firstIntradayDay);
  let points = within(fallback ? dailyRows : sorted([
    ...(allowDailyPrefix ? dailyPrefix : []), ...primaryIntraday,
  ]));
  const latestObservationAt = points.at(-1)?.date ?? null;
  let pendingCashFlows = false;
  // Do not put a newer value beside older P&L. During a real ledger change,
  // keep the last common accounting cutoff until reconciliation catches up.
  if (requireCashFlows && navNumber(points.at(-1), scope, "NetContributionsGbp") == null) {
    const covered = points.findLastIndex((p) => navNumber(p, scope, "NetContributionsGbp") != null);
    if (covered >= 0) {
      points = points.slice(0, covered + 1);
      pendingCashFlows = true;
    }
  }
  let timeline: CalendarTimeline = { categories: [], rowIndexes: [] };
  if (source === "intraday" && points.length && window.startDay && window.endDay) {
    const lastReference = references.filter((date) => historyDay(date) === window.endDay)
      .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    const end = pendingCashFlows ? points.at(-1)!.date : lastReference && lastReference.includes("T") ? lastReference
      : new Date(Date.parse(naturalDayBounds(window.endDay + "T12:00:00Z")!.end) - 1).toISOString();
    const calendarDays = Math.round((Date.parse(historyDay(end)) - Date.parse(window.startDay)) / DAY) + 1;
    const chartDates = points.map((point) => ({ date: point.intraday ? point.date
      : new Date(Date.parse(naturalDayBounds(point.date + "T12:00:00Z", CALENDAR_ZONE)!.end) - 600_000).toISOString() }));
    timeline = omitPortfolioWeekendDisplayWindow(naturalCalendarTimeline(
      chartDates, 10,
      calendarDays, false, true, CALENDAR_ZONE, end,
    ));
    timeline.displayIntervalMinutes = interval;
  } else if (source === "daily" && points.length) {
    // Reduce drawing only. Financial calculations retain all eligible records,
    // including intraday extrema and the common latest cash-flow cutoff.
    const rowByDay = new Map(points.map((p, index) => [historyDay(p.date), index]));
    timeline.displayIntervalMinutes = 1440;
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
    if (row != null && previousRow != null && (
      points[row].valuationSource !== points[previousRow].valuationSource
      || navNumber(points[row], scope, "NetContributionsGbp") !== navNumber(points[previousRow], scope, "NetContributionsGbp")
    )) {
      timeline.anchors![index - 1] = true;
      timeline.anchors![index] = true;
    }
  });
  return {
    points, source, fallback, timeline, coverage, pendingCashFlows, latestObservationAt, ...window,
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
