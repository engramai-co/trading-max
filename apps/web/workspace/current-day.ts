"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { portfolioCalendarDateKey } from "@/lib/chart-domain";

const HOUR = 3_600_000;

/** The calendar day (YYYY-MM-DD) of a moment in a time zone. */
export function calendarDay(now: number, timeZone: string) {
  return portfolioCalendarDateKey(new Date(now).toISOString(), timeZone) ?? "";
}

/**
 * Milliseconds until the calendar day changes in a time zone, at most a second
 * late. Searching for the change itself keeps it exact on a day whose offset
 * changes, in any zone.
 */
export function untilNextDay(now: number, timeZone: string) {
  const today = calendarDay(now, timeZone);
  let low = 0;
  // Past the next midnight in every zone, whatever its offset change.
  let high = 26 * HOUR;
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (calendarDay(now + middle, timeZone) === today) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * Today in the display time zone (London unless the reader chose another), and the
 * moment it was read. It moves on at midnight and whenever the page is shown or
 * focused again, so a page left open overnight stops calling yesterday today.
 */
export function useCurrentDay() {
  const { timeZone } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: number | undefined;
    const schedule = (from: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, untilNextDay(from, timeZone));
    };
    function refresh() {
      const current = Date.now();
      setNow(current);
      schedule(current);
    }
    const shown = () => {
      if (document.visibilityState === "visible") refresh();
    };
    schedule(Date.now());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [timeZone]);
  return { today: calendarDay(now, timeZone), now };
}
