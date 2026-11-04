import { numeric } from "@/lib/numeric";
import { object, objects, str, type Json } from "@/workspace/data";

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

export function targetSnapshot(targets: Json, current: unknown) {
  const positive = (value: unknown) => {
    const n = numeric(value);
    return n != null && n > 0 ? n : null;
  };
  const spot = positive(current);
  const rows = targetKeys.map((key) => {
    const value = positive(targets[key]);
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

/** The lens's conclusion: consensus, target, estimate direction, and the next report. */
export function analystVerdict(analyst: Json, price: unknown, today: string) {
  const summary = ratingSummary(objects(analyst.recommendations));
  const median = targetSnapshot(object(analyst.priceTargets), price).rows.find((row) => row.key === "median");
  const trends = objects(analyst.epsTrend);
  const trend = trends.find((row) => str(row.period) === "0q") ?? trends[0];
  const now = numeric(trend?.current);
  const before = numeric(trend?.["90daysAgo"]);
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
    estimateChange90: now != null && before != null && before > 0 ? now / before - 1 : null,
    revisionsUp30: numeric(revisions?.upLast30days),
    revisionsDown30: numeric(revisions?.downLast30days),
    lastSurprise: numeric(reported.at(-1)?.surprisePercent),
    nextReport: next ? str(next.date) : null,
  };
}

/**
 * The one next report date every lens shows. The service decides when it
 * sends `nextEarningsDate` (null included); older services fall back to the
 * same rule here: provider events first, then the calendar, never a past date.
 */
export function nextEarningsDate(
  data: { nextEarningsDate?: string | null; analyst?: unknown; fundamentals?: unknown },
  today: string,
) {
  if (data.nextEarningsDate !== undefined) return data.nextEarningsDate;
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

