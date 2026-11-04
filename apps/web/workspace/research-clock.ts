"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { scheduleExpired } from "./research-price-basis";

type Quote = NonNullable<Parameters<typeof scheduleExpired>[0]> & { timezone?: string | null };

const dateFormats = new Map<string, Intl.DateTimeFormat | null>();

/** A calendar date (YYYY-MM-DD) in an exchange's time zone; UTC's when the zone is unknown. */
export function exchangeDate(now: Date, timezone?: string | null) {
  const zone = timezone || "UTC";
  if (!dateFormats.has(zone)) {
    let format: Intl.DateTimeFormat | null = null;
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      // An unknown zone name falls back to UTC.
    }
    dateFormats.set(zone, format);
  }
  const format = dateFormats.get(zone);
  if (!format) return now.toISOString().slice(0, 10);
  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * What a security's lenses were built for besides their data: the exchange's
 * date, which decides the next report, and whether its session schedule still
 * covers `now`.
 */
export function lensDay(quote: Quote | undefined, now: Date) {
  return { date: exchangeDate(now, quote?.timezone), expired: scheduleExpired(quote, now) };
}

/** Whether lenses built for one day must be refetched on the next. */
export function lensTurned(
  before: ReturnType<typeof lensDay>,
  after: ReturnType<typeof lensDay>,
) {
  return after.date !== before.date || (after.expired && !before.expired);
}

/**
 * Refetches a security's lenses when the exchange's date turns or its session
 * schedule runs out, and re-renders so date rules read the new day at once.
 * Checked every minute: long timers stall while the computer sleeps.
 */
export function useLensRefresh(ticker: string, quote: Quote | undefined) {
  const client = useQueryClient();
  const [, setTurns] = useState(0);
  useEffect(() => {
    let last = lensDay(quote, new Date());
    const timer = window.setInterval(() => {
      const next = lensDay(quote, new Date());
      if (lensTurned(last, next)) {
        void client.invalidateQueries({ queryKey: ["workspace-research", ticker] });
        setTurns((turns) => turns + 1);
      }
      last = next;
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [client, quote, ticker]);
}
