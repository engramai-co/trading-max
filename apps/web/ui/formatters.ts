import {
  DEFAULT_DISPLAY_TIME_ZONE,
  isValidTimeZone,
  type Locale,
} from "@/components/locale-provider";

export function localeTag(locale: Locale) {
  return locale === "zh" ? "zh-CN" : "en-GB";
}

const zonedPartFormatters = new Map<string, Intl.DateTimeFormat>();

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
  return new Intl.DateTimeFormat(localeTag(locale), options).format(date);
}

export function formatDateTime(
  value: Date | number | string,
  locale: Locale,
  timeZone = DEFAULT_DISPLAY_TIME_ZONE,
) {
  return formatDate(value, locale, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_DISPLAY_TIME_ZONE,
    timeZoneName: "short",
    year: "numeric",
  });
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

export function formatTimeZoneLabel(timeZone: string, locale: Locale) {
  if (timeZone === "Europe/London") return locale === "zh" ? "伦敦" : "London";
  if (timeZone === "Asia/Hong_Kong") return locale === "zh" ? "香港" : "Hong Kong";
  try {
    const formatter = new Intl.DateTimeFormat(localeTag(locale), {
      timeZone,
      timeZoneName: "longGeneric",
    });
    return formatter.formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value
      ?? timeZone.replaceAll("_", " ");
  } catch {
    return timeZone.replaceAll("_", " ");
  }
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
