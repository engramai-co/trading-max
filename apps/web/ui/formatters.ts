import {
  DEFAULT_DISPLAY_TIME_ZONE,
  isValidTimeZone,
  type Locale,
} from "@/components/locale-provider";

export function localeTag(locale: Locale) {
  return locale === "zh" ? "zh-CN" : "en-GB";
}

const zonedPartFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatDate(
  value: Date | number | string,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  // Dense chart timelines reuse a small set of formats across thousands of
  // timestamps. Avoid constructing an Intl formatter for every label.
  const key = JSON.stringify([locale, options]);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(localeTag(locale), options);
    if (dateFormatters.size >= 64) dateFormatters.clear();
    dateFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

export function formatDateTime(
  value: Date | number | string,
  locale: Locale,
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
  now: Date | number = Date.now(),
) {
  // The display time zone is the reader's own setting, so it is not repeated
  // on every timestamp. Today reads as "今天 22:00"; the year appears only
  // when it differs from the current one.
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_DISPLAY_TIME_ZONE;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  const key = (input: Date | number, options: Intl.DateTimeFormatOptions) =>
    formatDate(input, "en", { ...options, timeZone: zone });
  const time = formatDate(date, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });
  const dayOptions: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  if (key(date, dayOptions) === key(now, dayOptions)) return (locale === "zh" ? "今天 " : "Today ") + time;
  const sameYear = key(date, { year: "numeric" }) === key(now, { year: "numeric" });
  return formatDate(date, locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    timeZone: zone,
  }) + " " + time;
}

/** Formats a YYYY-MM-DD calendar date in the reader's locale, omitting the year when it matches the current year. */
export function formatCalendarDate(
  value: string | null | undefined,
  locale: Locale,
  now: Date | number = Date.now(),
) {
  const iso = value?.trim().slice(0, 10) ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return value?.trim() || "—";
  const date = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(date.valueOf())) return value?.trim() || "—";
  const currentYear = formatDate(now, "en", { year: "numeric", timeZone: "UTC" });
  const sameYear = iso.slice(0, 4) === currentYear;
  return formatDate(date, locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Formats a start–end calendar span such as "8月3日 – 10月30日" or "2025年8月29日 – 2026年11月1日". */
export function formatDateSpan(
  start: string | null | undefined,
  end: string | null | undefined,
  locale: Locale,
  now: Date | number = Date.now(),
) {
  const s = start?.trim().slice(0, 10) ?? "";
  const e = end?.trim().slice(0, 10) ?? "";
  if (!s && !e) return "—";
  if (!e || s === e) return formatCalendarDate(s || e, locale, now);
  if (!s) return formatCalendarDate(e, locale, now);
  const crossYear = s.slice(0, 4) !== e.slice(0, 4);
  const formatEndpoint = (iso: string, forceYear: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const date = new Date(iso + "T00:00:00Z");
    if (Number.isNaN(date.valueOf())) return iso;
    const currentYear = formatDate(now, "en", { year: "numeric", timeZone: "UTC" });
    const withYear = forceYear || iso.slice(0, 4) !== currentYear;
    return formatDate(date, locale, {
      ...(withYear ? { year: "numeric" } : {}),
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  return formatEndpoint(s, crossYear) + " – " + formatEndpoint(e, false);
}

export function formatDateTimeInTimeZone(
  value: Date | number | string,
  locale: Locale,
  timeZone: string,
) {
  try {
    return formatDate(value, locale, {
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      timeZone,
      timeZoneName: "short",
      year: "numeric",
    });
  } catch {
    return formatDateTime(value, locale, DEFAULT_DISPLAY_TIME_ZONE);
  }
}

function zonedDateParts(value: Date, timeZone: string) {
  let formatter = zonedPartFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      calendar: "gregory",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone,
      year: "numeric",
    });
    zonedPartFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    month: read("month"),
    year: read("year"),
  };
}

function instantForWallTime(
  date: Pick<ReturnType<typeof zonedDateParts>, "day" | "month" | "year">,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = zonedDateParts(new Date(timestamp), timeZone);
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
    );
    const adjustment = target - renderedAsUtc;
    timestamp += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(timestamp);
}

export function formatScheduleTimes(
  localTimes: string[],
  locale: Locale,
  sourceTimeZone: string,
  displayTimeZone: string,
  reference: Date | number | string = new Date(),
) {
  const safeSource = isValidTimeZone(sourceTimeZone)
    ? sourceTimeZone
    : DEFAULT_DISPLAY_TIME_ZONE;
  const safeDisplay = isValidTimeZone(displayTimeZone)
    ? displayTimeZone
    : DEFAULT_DISPLAY_TIME_ZONE;
  const referenceDate = reference instanceof Date ? reference : new Date(reference);
  const sourceDate = zonedDateParts(
    Number.isNaN(referenceDate.valueOf()) ? new Date() : referenceDate,
    safeSource,
  );
  const formatter = new Intl.DateTimeFormat(localeTag(locale), {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: safeDisplay,
  });
  return localTimes.map((localTime) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(localTime);
    if (!match) return localTime;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return localTime;
    return formatter.format(
      instantForWallTime(sourceDate, hour, minute, safeSource),
    );
  });
}

export function formatCurrency(
  value: number | null | undefined,
  locale: Locale,
  currency = "GBP",
  maximumFractionDigits = 2,
) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), {
    currency,
    maximumFractionDigits,
    style: "currency",
  }).format(value);
}

export function formatCompactCurrency(
  value: number | null | undefined,
  locale: Locale,
  currency = "GBP",
) {
  if (value == null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const unit = absolute >= 1_000_000_000
    ? { divisor: 1_000_000_000, suffix: "b" }
    : absolute >= 1_000_000
      ? { divisor: 1_000_000, suffix: "m" }
      : absolute >= 1_000
        ? { divisor: 1_000, suffix: "k" }
        : null;
  if (!unit) return formatCurrency(value, locale, currency, 0);
  const scaled = value / unit.divisor;
  const maximumFractionDigits = Math.abs(scaled) < 10 ? 1 : 0;
  const compactValue = new Intl.NumberFormat(localeTag(locale), {
    currency,
    maximumFractionDigits,
    minimumFractionDigits: 0,
    style: "currency",
  }).format(scaled);
  return `${compactValue}${unit.suffix}`;
}

export function formatNumber(
  value: number | null | undefined,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}

export function formatPercent(
  value: number | null | undefined,
  locale: Locale,
  maximumFractionDigits = 1,
) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits,
    style: "percent",
  }).format(value);
}

export function formatDeltaPercent(
  value: number | null | undefined,
  locale: Locale,
  maximumFractionDigits = 1,
) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits,
    signDisplay: "exceptZero",
    style: "percent",
  }).format(value);
}
