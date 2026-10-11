import type { Locale } from "@/components/locale-provider";
import { formatDate, formatTimeZoneLabel, localeTag } from "@/ui/formatters";

export type TimelineDisplay = {
  locale: Locale;
  timeZone: string;
  intraday: boolean;
  clock: boolean;
};

/** Keep broad date context out of the individual ticks and outside the canvas,
 * where long localized timezone names can wrap and remain accessible. */
export function timelineContext(categories: string[], display: TimelineDisplay) {
  const first = categories.find((date) => Number.isFinite(Date.parse(date)));
  const last = categories.findLast((date) => Number.isFinite(Date.parse(date)));
  if (!first || !last) return "";
  const { locale, clock, intraday } = display;
  const timeZone = intraday ? display.timeZone : "UTC";
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric", month: "short", ...(clock ? { day: "numeric" as const } : {}), timeZone,
  }).formatRange(Date.parse(first), Date.parse(last))
    + (intraday ? ` · ${formatTimeZoneLabel(timeZone, locale)}` : "");
}

/** Presentation only: positions remain indexes into the original trading-time
 * calendar. Neither missing observations nor folded weekends are filled here. */
export function timelineLabels(categories: string[], display: TimelineDisplay) {
  const { locale, intraday, clock } = display;
  const timeZone = intraday ? display.timeZone : "UTC";
  const times = categories.map(Date.parse);
  const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = times.map((time) => Number.isFinite(time) ? dayFormat.format(time) : "");
  const dayStarts = days.flatMap((day, index) => day && (index === 0 || day !== days[index - 1]) ? [index] : []);
  const fractionalTimes = new Map<number, number>();
  const hours = clock ? times.flatMap((time, index) => {
    if (!Number.isFinite(time)) return [];
    const label = timeFormat.format(time);
    if (label.endsWith(":00") && time % 60_000 === 0) return [{ index, hour: Number(label.slice(0, 2)), label }];
    // A :45 offset (e.g. Kathmandu) never lands on a ten-minute UTC slot.
    // Interpolate the axis coordinate only, and never across a folded weekend.
    const gap = times[index + 1] - time;
    const untilHour = (60 - Number(label.slice(3))) * 60_000 - time % 60_000;
    if (!(gap > 0 && gap <= 3_600_000 && untilHour < gap)) return [];
    const position = index + untilHour / gap;
    const stamp = time + untilHour;
    const rounded = timeFormat.format(stamp);
    if (!rounded.endsWith(":00")) return []; // A skipped DST wall-clock hour.
    fractionalTimes.set(position, stamp);
    return [{ index: position, hour: Number(rounded.slice(0, 2)), label: rounded }];
  }) : [];

  const ticks = (maxLabels: number) => {
    const count = Math.max(2, Math.floor(maxLabels));
    if (clock) {
      // Local wall-clock boundaries, not a stride starting at the first sample.
      // In particular, never append the latest 23:50 reading as an axis tick.
      for (const step of [1, 2, 3, 4, 6, 8, 12, 24]) {
        const candidates = hours.filter((point) => point.hour % step === 0);
        // A fall-back hour occurs twice; its precise UTC offset stays in the
        // observation tooltip, while the overview axis avoids duplicate labels.
        const unique = candidates.filter((point, index) => index === 0 || point.label !== candidates[index - 1].label || days[Math.floor(point.index)] !== days[Math.floor(candidates[index - 1].index)]);
        if (unique.length && unique.length <= count) return unique.map((point) => point.index);
      }
      return times.length ? [0] : [];
    }
    if (dayStarts.length <= count) return dayStarts;
    const first = dayStarts[0];
    const span = dayStarts[dayStarts.length - 1] - first;
    const selected = new Set<number>();
    for (let i = 0; i < count; i++) {
      const target = first + i * span / (count - 1);
      selected.add(dayStarts.reduce((best, tick) => Math.abs(tick - target) < Math.abs(best - target) ? tick : best, first));
    }
    return [...selected].sort((a, b) => a - b);
  };

  const label = (index: number) => {
    const time = fractionalTimes.get(index) ?? times[index];
    if (!Number.isFinite(time)) return "";
    if (clock) {
      const value = timeFormat.format(time);
      // Make a midnight crossing explicit when the selected timezone differs
      // from the portfolio's collection day.
      if (value !== "00:00" || index === 0) return value;
    }
    return formatDate(time, locale, { month: "short", day: "numeric", timeZone });
  };
  return { ticks, label, context: timelineContext(categories, display) };
}
