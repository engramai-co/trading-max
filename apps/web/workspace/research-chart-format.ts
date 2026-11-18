import type { Locale } from "@/components/locale-provider";
import { compact, number } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { formatCalendarDate, formatDate } from "@/ui/formatters";

const DAY = 86_400_000;

/** Compact display only: source records and copy/export retain their precision. */
export function chartNumber(value: unknown, locale: Locale = "en") {
  const n = numeric(value);
  return n == null ? "—" : Math.abs(n) >= 10_000 ? compact(n, locale) : number(n, 2);
}

export function chartName(name: string, width = 24) {
  if (name.length <= width) return name;
  const space = name.lastIndexOf(" ", width);
  const split = space > width / 2 ? space : width;
  const remainder = name.slice(split).trim();
  return (
    name.slice(0, split) +
    "\n" +
    (remainder.length <= width
      ? remainder
      : remainder.slice(0, width - 1) + "…")
  );
}

/**
 * The time axis of a daily research series, labelled like the other research
 * charts: day and month across three months or less ("12 Nov", with the year
 * outside the current one); months across three years or less, where January
 * names its year, as do the months before the first January; years beyond
 * that. The minimum interval keeps ECharts' ticks at the unit the labels name.
 */
export function researchTimeAxis(first: number, last: number, locale: Locale, now: Date | number = Date.now()) {
  const span = last - first;
  const year = (value: number) => String(new Date(value).getUTCFullYear());
  if (span > 3 * 365 * DAY) return { minInterval: 365 * DAY, formatter: year };
  if (span > 92 * DAY) {
    // ECharts may hide the label at the axis start, so the first year is named
    // on every month before the next one begins.
    const nextYear = Date.UTC(new Date(first).getUTCFullYear() + 1, 0, 1);
    return {
      minInterval: 28 * DAY,
      formatter: (value: number) => value < nextYear
        ? formatDate(value, locale, { year: "numeric", month: "short", timeZone: "UTC" })
        : new Date(value).getUTCMonth() === 0 ? year(value)
          : formatDate(value, locale, { month: "short", timeZone: "UTC" }),
    };
  }
  return {
    minInterval: DAY,
    formatter: (value: number) => formatCalendarDate(new Date(value).toISOString().slice(0, 10), locale, now),
  };
}
