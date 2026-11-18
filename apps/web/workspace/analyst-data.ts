import type { ResearchPriceSeries } from "@/lib/types";
import { numeric } from "@/lib/numeric";
import { object, objects, str, type Json } from "@/workspace/data";
import { exchangeDate } from "./research-clock";

export const ratingKeys = [
  "strongBuy",
  "buy",
  "hold",
  "sell",
  "strongSell",
] as const;
export const targetKeys = ["low", "mean", "median", "high"] as const;

export function normalizeRatingRow(row: Json): Json {
  if (Object.hasOwn(row, "strongSell") || !Object.hasOwn(row, "underperform"))
    return row;
  const { underperform, sell, ...rest } = row;
  return { ...rest, sell: underperform, strongSell: sell };
}

export function ratingSummary(rows: Json[]) {
  rows = rows.map(normalizeRatingRow);
  const row =
    rows.find((r) => r.period === "0m") ??
    [...rows]
      .filter((r) => /^-\d+m$/.test(str(r.period)))
      .sort((a, b) => parseInt(str(b.period)) - parseInt(str(a.period)))[0] ??
    rows[0];
  const counts = ratingKeys.map((key) => {
    const count = numeric(row?.[key]);
    return count != null && count >= 0 && Number.isInteger(count)
      ? count
      : null;
  });
  const complete = counts.every((count) => count != null);
  const knownTotal = counts.reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  // An incomplete distribution cannot support a consensus score.
  const score =
    complete && knownTotal > 0
      ? counts.reduce<number>(
          (sum, count, index) => sum + count! * (index + 1),
          0,
        ) / knownTotal
      : null;
  return { counts, complete, knownTotal, score, period: str(row?.period) };
}

/** Analyst targets arrive in the listing's native quote unit. */
export function targetUnitScale(unit: string | null | undefined, currency: string | null | undefined) {
  if (!currency) return null;
  if (unit === "GBp" || unit === "GBX" || unit === "GBx") return currency === "GBP" ? 0.01 : null;
  // Older snapshots may lack the native unit. A GBP quote alone is ambiguous.
  if (!unit) return currency === "GBP" ? null : 1;
  return unit.toUpperCase() === currency ? 1 : null;
}

/** A target announced on the split date is already quoted per new share. */
export function targetSplitScale(
  series: Pick<ResearchPriceSeries, "events" | "points"> | undefined,
  latestObservation: string,
) {
  const splits = new Map<string, number | null>();
  for (const point of series?.points ?? []) {
    if (point.split) splits.set(point.date.slice(0, 10), point.split);
  }
  for (const event of series?.events ?? []) {
    if (event.kind === "split") splits.set(str(event.date).slice(0, 10), numeric(event.value));
  }
  return (day: string, scale: number | null) => {
    // Without the split history, only amounts from the latest observation share a verified basis.
    if (scale == null || (!series?.points.length && (!day || day !== latestObservation))) return null;
    for (const [splitDay, ratio] of splits) {
      if (splitDay <= day) continue;
      if (!day || ratio == null || ratio <= 0) return null;
      scale /= ratio;
    }
    return scale;
  };
}

export function targetAmount(raw: unknown, scale: number | null) {
  const n = numeric(raw);
  return n != null && n > 0 && scale != null && Number.isFinite(n * scale) ? n * scale : null;
}

export function targetSnapshot(targets: Json, current: unknown, scale: number | null = 1) {
  const spot = targetAmount(current, 1);
  const rows = targetKeys.map((key) => {
    const value = targetAmount(targets[key], scale);
    return {
      key,
      value,
      change: value != null && spot != null ? value / spot - 1 : null,
    };
  });
  const low = rows[0].value,
    high = rows[3].value;
  return {
    spot,
    rows,
    range:
      low != null && high != null && low <= high
        ? ([low, high] as const)
        : null,
  };
}

export function recommendationChange(row: Json) {
  const epoch = numeric(row.epochGradeDate);
  const date =
    str(row.index ?? row.GradeDate ?? row.gradeDate) ||
    (epoch != null && Number.isFinite(new Date(epoch * 1000).getTime())
      ? new Date(epoch * 1000).toISOString()
      : "");
  return {
    date: date.slice(0, 10),
    firm: str(row.Firm ?? row.firm),
    from: str(row.FromGrade ?? row.fromGrade),
    to: str(row.ToGrade ?? row.toGrade),
    action: str(row.Action ?? row.action),
    target: numeric(row.currentPriceTarget),
  };
}

export function estimateChange90(row: Json | undefined) {
  const now = numeric(row?.current), before = numeric(row?.["90daysAgo"]);
  return now != null && before != null && before > 0 ? now / before - 1 : null;
}

/** The lens's conclusion: consensus, target, estimate direction, and the next report. */
export function analystVerdict(analyst: Json, price: unknown, today: string) {
  const summary = ratingSummary(objects(analyst.recommendations));
  const median = targetSnapshot(object(analyst.priceTargets), price).rows.find((row) => row.key === "median");
  const trends = objects(analyst.epsTrend);
  const trend = trends.find((row) => str(row.period) === "0q") ?? trends[0];
  const revisions = objects(analyst.epsRevisions).find((row) => str(row.period) === str(trend?.period));
  const reported = objects(analyst.earningsHistory)
    .filter((row) => numeric(row.surprisePercent) != null)
    .sort((a, b) => str(a.quarter ?? a.index).localeCompare(str(b.quarter ?? b.index)));
  const next = objects(analyst.earningsEvents)
    .filter((row) => str(row.date) >= today && str(row.status) !== "reported")
    .sort((a, b) => str(a.date).localeCompare(str(b.date)))[0];
  const providerCount = numeric(analyst.providerRecommendationCount);
  return {
    consensus: str(analyst.providerRecommendationKey).toLowerCase().replaceAll("_", "") || null,
    analysts: summary.knownTotal || providerCount || null,
    targetMedian: median?.value ?? null,
    targetChange: median?.change ?? null,
    estimateChange90: estimateChange90(trend),
    revisionsUp30: numeric(revisions?.upLast30days),
    revisionsDown30: numeric(revisions?.downLast30days),
    lastSurprise: numeric(reported.at(-1)?.surprisePercent),
    nextReport: next ? str(next.date) : null,
  };
}

/**
 * The one next report date every lens shows, never one whose day has ended in
 * the quote exchange's time zone. The service decides when it sends
 * `nextEarningsDate` (null included); older services fall back to the same
 * rule here: provider events first, then the calendar.
 */
export function nextEarningsDate(
  data: {
    nextEarningsDate?: string | null;
    analyst?: unknown;
    fundamentals?: unknown;
    context?: { quote?: { timezone?: string | null } } | null;
  },
  now: Date,
) {
  const today = exchangeDate(now, data.context?.quote?.timezone);
  // A lens left open past the exchange's midnight still names its report.
  if (data.nextEarningsDate !== undefined)
    return data.nextEarningsDate && data.nextEarningsDate >= today ? data.nextEarningsDate : null;
  const upcoming = (dates: string[]) => dates.filter((date) => date >= today).sort()[0];
  const events = objects(object(data.analyst).earningsEvents)
    .filter((row) => str(row.status) !== "reported")
    .map((row) => str(row.date).slice(0, 10));
  const calendar = object(object(data.fundamentals).earningsCalendar).earningsDates;
  return (
    upcoming(events) ??
    upcoming((Array.isArray(calendar) ? calendar : []).map((date) => str(date).slice(0, 10))) ??
    null
  );
}

