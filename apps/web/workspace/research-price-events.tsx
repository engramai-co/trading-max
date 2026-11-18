"use client";

import { useId, useState } from "react";
import type { ResearchPriceSeries } from "@/lib/types";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDate } from "@/ui/formatters";
import { formatNumber } from "@/ui/formatters";
import { number, str } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import { useCopy } from "./foundation";

type Marker = NonNullable<ResearchPriceSeries["tradeMarkers"]>[number];
type Event = { date: string; id: string; kind: "split" | "dividend" | "earnings"; value?: unknown; currency?: string };
export type PriceEventDay = { date: string; marker?: Marker; company: Event[]; count: number };

function archivedTrades(marker: Marker) {
  return (["buy", "sell"] as const).flatMap((side) => {
    const fills = marker.fills?.filter((fill) => fill.side === side) ?? [];
    const orders = marker[`${side}Orders`] - fills.length;
    if (orders <= 0) return [];
    const itemisedQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
    const quantity = Number((marker[`${side}Quantity`] - itemisedQuantity).toFixed(8));
    return [{ side, orders, quantity }];
  });
}

export function ArchivedTradeRows({ marker, date }: { marker: Marker; date: string }) {
  const t = useCopy();
  const { locale } = useLocale();
  return archivedTrades(marker).map(({ side, quantity, orders }) => <li key={side}>
    <time dateTime={date}>{formatCalendarDate(date, locale)}</time>
    <span>{side === "buy" ? t("买入", "Buy") : t("卖出", "Sell")} {number(quantity, 8)} {quantity === 1 ? t("股", "share") : t("股", "shares")}</span>
    <span>{orders} {orders === 1 ? t("笔", "order") : t("笔", "orders")}</span>
    <span>{t("旧档案未记录原币金额", "Original amount unavailable in this archive")}</span>
  </li>);
}

export function priceEventDays(markers: Marker[], corporate: Record<string, unknown>[], earnings: Record<string, unknown>[]) {
  const days = new Map<string, PriceEventDay>();
  const get = (date: string) => {
    const day = date.slice(0, 10);
    if (!days.has(day)) days.set(day, { date: day, company: [], count: 0 });
    return days.get(day)!;
  };
  const seen = new Set<string>();
  for (const marker of markers) {
    const entry = get(marker.date);
    if (entry.marker) continue;
    entry.marker = marker;
    entry.count += marker.buyOrders + marker.sellOrders;
  }
  for (const event of [...corporate, ...earnings.map((event): Record<string, unknown> => ({ ...event, kind: "earnings" }))]) {
    const date = str(event.date);
    const kind = event.kind;
    if (!date || (kind !== "split" && kind !== "dividend" && kind !== "earnings")) continue;
    const id = str(event.id);
    const key = [kind, date, id || String(event.value ?? ""), str(event.source)].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = get(date);
    entry.company.push({ date, id, kind, value: event.value, currency: str(event.currency) });
    entry.count++;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function PriceEventTrack({ days, openEarnings }: {
  days: PriceEventDay[];
  openEarnings?: (event: Event) => void;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const id = useId();
  const [selected, setSelected] = useState<string>();
  const day = days.find((event) => event.date === selected);
  const eventLabel = (kind: Event["kind"]) => kind === "split" ? t("拆股", "Split")
    : kind === "dividend" ? t("分红", "Dividend") : t("财报", "Earnings");
  if (!days.length) return null;
  return (
    <section className="mx-price-events" aria-label={t("事件时间轴", "Event timeline")}>
      <div className="mx-event-track">
        {days.map((entry) => {
          const date = formatCalendarDate(entry.date, locale);
          const label = entry.marker?.kind ?? eventLabel(entry.company[0].kind);
          return <button key={entry.date} type="button" aria-controls={id} aria-expanded={entry === day}
            onClick={() => setSelected(entry === day ? undefined : entry.date)}>
            <time dateTime={entry.date}>{date}</time>{" "}
            <strong>{label}{entry.count > 1 ? ` +${entry.count - 1}` : ""}</strong>
          </button>;
        })}
      </div>
      <div id={id} hidden={!day}>
        {day && <ul className="mx-price-event-records">
          {day.marker?.fills?.map((fill, i) => (
            <li key={i}>
              <span>{fill.side === "buy" ? t("买入", "Buy") : t("卖出", "Sell")} · {fill.account.toUpperCase()}</span>
              <time dateTime={fill.at}>{formatDate(fill.at, locale, { dateStyle: "medium", timeStyle: "short", timeZone })}</time>
              <span>{number(fill.quantity, 4)} {number(fill.quantity, 4) === "1" ? t("股", "share") : t("股", "shares")}</span>
              <strong>{fill.amount == null || !fill.currency ? "—" : `${formatNumber(fill.amount, locale, { maximumFractionDigits: 4 })} ${fill.currency}`}</strong>
            </li>
          ))}
          {day.marker && <ArchivedTradeRows marker={day.marker} date={day.date} />}
          {day.company.map((event, i) => <li key={i}>
            <span>{eventLabel(event.kind)}</span>
            <time dateTime={event.date}>{formatCalendarDate(event.date, locale)}</time>
            {event.value != null && <strong>{event.kind === "dividend" ? quoteValue(event.value, event.currency, { style: "code", digits: 4 }) : number(event.value, 4)}</strong>}
            {event.kind === "earnings" && openEarnings && <button type="button" className="mx-text-link" onClick={() => openEarnings(event)}>
              {t("实际与预期", "Actual vs. estimate")}
            </button>}
          </li>)}
        </ul>}
      </div>
    </section>
  );
}
