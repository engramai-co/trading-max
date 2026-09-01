export function paddedReturnDomain(values: number[]): [number, number] {
  if (!values.length) return [-0.001, 0.001];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  if (span < 0.0001) {
    const padding = Math.max(Math.abs(maximum) * 0.08, 0.001);
    return [
      Math.min(minimum - padding, 0),
      Math.max(maximum + padding, 0),
    ];
  }
  const padding = Math.max(span * 0.1, 0.0005);
  return [
    Math.min(minimum - padding, 0),
    Math.max(maximum + padding, 0),
  ];
}

const DEFAULT_PORTFOLIO_TIME_ZONE = "Europe/London";

/**
 * Display density for retained intraday account-value anchors.
 *
 * The one-day view deliberately keeps every ten-minute observation. Longer
 * windows only reduce display density; they do not change collection cadence.
 */
export const portfolioIntradayDisplayIntervalMinutes = {
  "1D": 10,
  "1W": 30,
  "1M": 60,
} as const;
const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

type ZonedDateTimeParts = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
};

function zonedDateTimeParts(
  value: string | number,
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
): ZonedDateTimeParts | null {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  let formatter = zonedDateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    });
    zonedDateTimeFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const result = {
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
    month: numberPart("month"),
    second: numberPart("second"),
    year: numberPart("year"),
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function zonedMidnightTimestamp(
  year: number,
  month: number,
  day: number,
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const targetLocalTimestamp = Date.UTC(year, month - 1, day);
  let candidate = targetLocalTimestamp;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = zonedDateTimeParts(candidate, timeZone);
    if (!observed) return Number.NaN;
    const observedLocalTimestamp = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = targetLocalTimestamp - observedLocalTimestamp;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

export function portfolioCalendarDateKey(
  value: string,
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const parts = zonedDateTimeParts(value, timeZone);
  return parts
    ? `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`
    : null;
}

/**
 * Keep the short-range chart on the useful market week without discarding
 * retained observations. The boundary is deliberately expressed in London
 * wall-clock time: Saturday before 02:00 and Sunday from 22:00 remain visible,
 * while the quiet interval between them is compressed out of the display.
 */
export function isPortfolioWeekendDisplayTimestamp(
  value: string | number,
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const parts = zonedDateTimeParts(value, timeZone);
  if (!parts) return true;
  const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const saturdayQuietStart = 2 * 60;
  const sundayDisplayResume = 22 * 60;

  if (dayOfWeek === 6) return minuteOfDay < saturdayQuietStart;
  if (dayOfWeek === 0) return minuteOfDay >= sundayDisplayResume;
  return true;
}

export function omitPortfolioWeekendDisplayWindow(
  timeline: { categories: string[]; rowIndexes: Array<number | null> },
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const categories: string[] = [];
  const rowIndexes: Array<number | null> = [];
  timeline.categories.forEach((category, index) => {
    if (!isPortfolioWeekendDisplayTimestamp(category, timeZone)) return;
    categories.push(category);
    rowIndexes.push(timeline.rowIndexes[index] ?? null);
  });
  return { categories, rowIndexes };
}

export function naturalDayBounds(
  value: string,
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const parts = zonedDateTimeParts(value, timeZone);
  if (!parts) return null;
  const startTimestamp = zonedMidnightTimestamp(parts.year, parts.month, parts.day, timeZone);
  const followingDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const endTimestamp = zonedMidnightTimestamp(
    followingDate.getUTCFullYear(),
    followingDate.getUTCMonth() + 1,
    followingDate.getUTCDate(),
    timeZone,
  );
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) return null;
  return {
    end: new Date(endTimestamp).toISOString(),
    start: new Date(startTimestamp).toISOString(),
  };
}

/**
 * Build a regular calendar-day timeline without inventing observations.
 * Missing buckets remain null, so old collection gaps stay visible while new
 * 24/7 anchors connect naturally across midnight.
 */
export function naturalCalendarTimeline<T extends { date: string }>(
  rows: T[],
  intervalMinutes: number,
  calendarDays: number,
  fillThroughDayEnd: boolean,
  includeLatestObservationBucket = false,
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const parsed = rows
    .map((row, index) => ({ index, timestamp: Date.parse(row.date) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest = parsed.at(-1);
  if (!latest) return { categories: [] as string[], rowIndexes: [] as Array<number | null> };

  const latestParts = zonedDateTimeParts(latest.timestamp, timeZone);
  const latestBounds = naturalDayBounds(rows[latest.index].date, timeZone);
  if (!latestParts || !latestBounds) {
    return { categories: [] as string[], rowIndexes: [] as Array<number | null> };
  }
  const firstDate = new Date(Date.UTC(
    latestParts.year,
    latestParts.month - 1,
    latestParts.day - Math.max(0, calendarDays - 1),
  ));
  const startTimestamp = zonedMidnightTimestamp(
    firstDate.getUTCFullYear(),
    firstDate.getUTCMonth() + 1,
    firstDate.getUTCDate(),
    timeZone,
  );
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const endTimestamp = fillThroughDayEnd
    ? Date.parse(latestBounds.end)
    : startTimestamp + Math.floor((latest.timestamp - startTimestamp) / intervalMs) * intervalMs;
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
    return { categories: [] as string[], rowIndexes: [] as Array<number | null> };
  }

  const rowByBucket = new Map<number, number>();
  for (const entry of parsed) {
    if (entry.timestamp < startTimestamp) continue;
    const bucket = Math.floor((entry.timestamp - startTimestamp) / intervalMs);
    const bucketTimestamp = startTimestamp + bucket * intervalMs;
    if (
      bucketTimestamp > endTimestamp
      || (!includeLatestObservationBucket && entry.timestamp > endTimestamp)
    ) continue;
    rowByBucket.set(bucket, entry.index);
  }

  const categories: string[] = [];
  const rowIndexes: Array<number | null> = [];
  for (
    let timestamp = startTimestamp, bucket = 0;
    timestamp <= endTimestamp;
    timestamp += intervalMs, bucket += 1
  ) {
    categories.push(new Date(timestamp).toISOString());
    rowIndexes.push(rowByBucket.get(bucket) ?? null);
  }
  return { categories, rowIndexes };
}

export type TimelineCoverageRange = {
  end: string;
  endIndex: number;
  start: string;
  startIndex: number;
};

export type TimelineCoverageSummary = {
  categoryCount: number;
  firstObservedAt: string | null;
  firstObservedIndex: number | null;
  gaps: TimelineCoverageRange[];
  lastObservedAt: string | null;
  lastObservedIndex: number | null;
  observedCount: number;
  observedRanges: TimelineCoverageRange[];
  status: "complete" | "partial" | "single" | "empty";
};

/**
 * Describe observed and missing timeline spans without treating future buckets
 * as outages. A single absent bucket is ignored as a material gap by default:
 * delayed jobs should not turn an otherwise legible chart into an alarm.
 */
export function summarizeTimelineCoverage(
  categories: string[],
  rowIndexes: Array<number | null>,
  minimumGapBuckets = 2,
): TimelineCoverageSummary {
  const observedIndexes = rowIndexes
    .map((rowIndex, index) => rowIndex == null ? null : index)
    .filter((index): index is number => index !== null);
  const firstObservedIndex = observedIndexes.at(0) ?? null;
  const lastObservedIndex = observedIndexes.at(-1) ?? null;
  const empty: TimelineCoverageSummary = {
    categoryCount: categories.length,
    firstObservedAt: null,
    firstObservedIndex: null,
    gaps: [],
    lastObservedAt: null,
    lastObservedIndex: null,
    observedCount: 0,
    observedRanges: [],
    status: "empty",
  };
  if (firstObservedIndex == null || lastObservedIndex == null) return empty;

  const collectRanges = (observed: boolean) => {
    const ranges: TimelineCoverageRange[] = [];
    let startIndex: number | null = null;
    for (let index = 0; index <= lastObservedIndex; index += 1) {
      const matches = (rowIndexes[index] != null) === observed;
      if (matches && startIndex == null) startIndex = index;
      const ends = startIndex != null && (!matches || index === lastObservedIndex);
      if (!ends || startIndex == null) continue;
      const endIndex = matches && index === lastObservedIndex ? index : index - 1;
      if (observed || endIndex - startIndex + 1 >= Math.max(1, minimumGapBuckets)) {
        ranges.push({
          end: categories[endIndex],
          endIndex,
          start: categories[startIndex],
          startIndex,
        });
      }
      startIndex = null;
    }
    return ranges;
  };

  const gaps = collectRanges(false);
  const observedRanges = collectRanges(true);
  return {
    categoryCount: categories.length,
    firstObservedAt: categories[firstObservedIndex] ?? null,
    firstObservedIndex,
    gaps,
    lastObservedAt: categories[lastObservedIndex] ?? null,
    lastObservedIndex,
    observedCount: observedIndexes.length,
    observedRanges,
    status: observedIndexes.length === 1 ? "single" : gaps.length ? "partial" : "complete",
  };
}

export function paddedDrawdownDomain(values: number[]): [number, number] {
  const minimum = values.length ? Math.min(...values) : 0;
  return [Math.min(minimum * 1.08, -0.001), 0];
}

/**
 * Express cumulative net profit or loss relative to cumulative external net
 * contributions. This is a money-on-contributed-capital measure, not TWR or
 * IRR. A non-positive contribution base has no meaningful percentage.
 */
export function netPnlRate(
  netPnl: number | null | undefined,
  netContributions: number | null | undefined,
) {
  if (
    netPnl == null ||
    !Number.isFinite(netPnl) ||
    netContributions == null ||
    !Number.isFinite(netContributions) ||
    netContributions <= 0
  ) {
    return null;
  }
  return netPnl / netContributions;
}

export type MoneyOutcomeChartPoint = {
  contributions: number;
  date: string;
  drawdown: number;
  nav: number;
  pnl: number;
};

/**
 * Crop a cumulative money series without changing its financial meaning.
 * Date ranges control the visible timeline; they must not reset cumulative
 * P&L because doing so can hide pre-window gains or losses from one account.
 */
export function cropCumulativeMoneyOutcome<T extends MoneyOutcomeChartPoint>(
  rows: T[],
  start: string | null,
) {
  return start ? rows.filter((row) => row.date >= start) : rows;
}

/**
 * Pick one stable percentage denominator for the whole visible window. An
 * opening account value is the clearest period baseline. Imported CFD proxies
 * can legitimately open at zero, so they fall back to the largest absolute
 * cash-flow base instead of dividing by a near-zero point-in-time value.
 */
export function stableMoneyRateBase(
  rows: MoneyOutcomeChartPoint[],
  preferOpeningNav: boolean,
) {
  const openingNav = Math.abs(rows.at(0)?.nav ?? 0);
  if (preferOpeningNav && openingNav >= 0.01) return openingNav;

  const contributionBase = rows.reduce(
    (maximum, row) => Math.max(maximum, Math.abs(row.contributions)),
    0,
  );
  return contributionBase >= 0.01 ? contributionBase : null;
}

export function relativeMoneyRate(
  value: number | null | undefined,
  base: number | null | undefined,
) {
  if (
    value == null ||
    !Number.isFinite(value) ||
    base == null ||
    !Number.isFinite(base) ||
    base <= 0
  ) {
    return null;
  }
  return value / base;
}

/**
 * Keep price charts focused on their relevant price regime while ensuring
 * reference levels such as spot, option walls, max pain, and gamma flip remain
 * visible. ECharts otherwise tends to pull a positive value axis down to zero,
 * which wastes most of the canvas for high-priced securities.
 */
export function paddedPriceDomain(
  values: Array<number | null | undefined>,
): [number, number] | null {
  const available = values.filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0,
  );
  if (!available.length) return null;

  const minimum = Math.min(...available);
  const maximum = Math.max(...available);
  const span = maximum - minimum;
  const padding = span > 0
    ? Math.max(span * 0.05, maximum * 0.01, 1)
    : Math.max(maximum * 0.1, 1);

  return [
    Math.max(0, Math.floor(minimum - padding)),
    Math.ceil(maximum + padding),
  ];
}

export function latestNaturalDayIntradayPoints<
  T extends { date: string; intraday?: boolean },
>(
  points: T[],
  valueOf: (point: T) => unknown,
): T[] {
  const available = points.filter(
    (point) =>
      typeof valueOf(point) === "number" &&
      point.intraday === true,
  ).sort((left, right) => left.date.localeCompare(right.date));
  const latestDay = available.at(-1)
    ? portfolioCalendarDateKey(available.at(-1)!.date)
    : null;
  return latestDay
    ? available.filter((point) => portfolioCalendarDateKey(point.date) === latestDay)
    : [];
}

/**
 * Down-sample timestamped observations onto stable time buckets while keeping
 * the exact first and last observations. Calculations may continue to use the
 * full-resolution source; this helper only controls display density.
 */
export function sampleTimeBuckets<T extends { date: string }>(
  points: T[],
  intervalMinutes: number,
) {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const available = points
    .filter((point) => Number.isFinite(Date.parse(point.date)))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (available.length < 2) return available;

  const sampled: T[] = [];
  let activeBucket: number | null = null;
  for (const point of available) {
    const bucket = Math.floor(Date.parse(point.date) / intervalMs);
    if (bucket === activeBucket) {
      sampled[sampled.length - 1] = point;
    } else {
      sampled.push(point);
      activeBucket = bucket;
    }
  }

  const first = available[0];
  const last = available.at(-1)!;
  if (sampled[0]?.date !== first.date) sampled.unshift(first);
  if (sampled.at(-1)?.date !== last.date) sampled.push(last);
  return sampled;
}

/**
 * Build an ECharts time series that breaks across unobserved recording gaps.
 * A null midpoint keeps elapsed time visible without inventing a path between
 * the two known endpoints.
 */
export function gapAwareTimeSeries<T extends { date: string }>(
  rows: T[],
  valueOf: (row: T) => number | null,
  maximumObservedGapMinutes: number,
): Array<[number, number | null]> {
  const result: Array<[number, number | null]> = [];
  const gapMs = Math.max(1, maximumObservedGapMinutes) * 60_000;
  let previousTimestamp: number | null = null;

  for (const row of rows) {
    const timestamp = Date.parse(row.date);
    if (!Number.isFinite(timestamp)) continue;
    if (previousTimestamp != null && timestamp - previousTimestamp > gapMs) {
      result.push([previousTimestamp + Math.floor((timestamp - previousTimestamp) / 2), null]);
    }
    result.push([timestamp, valueOf(row)]);
    previousTimestamp = timestamp;
  }
  return result;
}

/**
 * Build one isolated dashed bridge per internal collection gap.
 *
 * Keeping every bridge in its own series prevents ECharts from joining two
 * separate gaps across a real observed section. Leading and trailing gaps are
 * deliberately left open because there is no observation on both sides.
 */
export function gapBridgeSegments<T>(
  rowIndexes: Array<number | null>,
  rows: T[],
  valueOf: (row: T, index: number) => number | null,
) {
  const bridges: Array<{
    fromIndex: number;
    fromValue: number;
    toIndex: number;
    toValue: number;
  }> = [];
  let index = 0;

  while (index < rowIndexes.length) {
    if (rowIndexes[index] !== null) {
      index += 1;
      continue;
    }

    const gapStart = index;
    while (index < rowIndexes.length && rowIndexes[index] === null) index += 1;
    const leftTimelineIndex = gapStart - 1;
    const rightTimelineIndex = index;
    if (leftTimelineIndex < 0 || rightTimelineIndex >= rowIndexes.length) continue;

    const leftRowIndex = rowIndexes[leftTimelineIndex];
    const rightRowIndex = rowIndexes[rightTimelineIndex];
    if (leftRowIndex === null || rightRowIndex === null) continue;
    const leftValue = valueOf(rows[leftRowIndex], leftRowIndex);
    const rightValue = valueOf(rows[rightRowIndex], rightRowIndex);
    if (
      leftValue == null
      || rightValue == null
      || !Number.isFinite(leftValue)
      || !Number.isFinite(rightValue)
    ) continue;

    bridges.push({
      fromIndex: leftTimelineIndex,
      fromValue: leftValue,
      toIndex: rightTimelineIndex,
      toValue: rightValue,
    });
  }

  return bridges;
}

export function timestampLabel(
  value: string,
  locale: "zh" | "en",
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    month: "short",
    day: "numeric",
    hour: value.includes("T") ? "2-digit" : undefined,
    minute: value.includes("T") ? "2-digit" : undefined,
    timeZone: value.includes("T") ? timeZone : "UTC",
  }).format(
    new Date(value.includes("T") ? value : `${value}T00:00:00Z`),
  );
}

export function detailedTimestampLabel(
  value: string,
  locale: "zh" | "en",
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: value.includes("T") ? "2-digit" : undefined,
    minute: value.includes("T") ? "2-digit" : undefined,
    timeZone: value.includes("T") ? timeZone : "UTC",
  }).format(
    new Date(value.includes("T") ? value : `${value}T00:00:00Z`),
  );
}

function timeOnlyLabel(value: string, locale: "zh" | "en", timeZone: string) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

/**
 * Keep intraday axes readable when a single natural day has many anchors.
 * The first point of a calendar day carries the date; later points carry time
 * only, so labels never repeat the same date across the axis.
 */
export function axisTimestampLabels(
  values: string[],
  locale: "zh" | "en",
  timeZone = DEFAULT_PORTFOLIO_TIME_ZONE,
) {
  const labels = new Map<string, string>();
  let previousDay: string | null = null;

  for (const value of values) {
    const day = portfolioCalendarDateKey(value) ?? value.slice(0, 10);
    const sameIntradayDay = value.includes("T") && day === previousDay;
    labels.set(
      value,
      sameIntradayDay
        ? timeOnlyLabel(value, locale, timeZone)
        : timestampLabel(value, locale, timeZone),
    );
    previousDay = day;
  }

  return labels;
}
