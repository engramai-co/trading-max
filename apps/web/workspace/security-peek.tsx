"use client";

import { Popover } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import { inRange } from "@/lib/portfolio/nav";
import type { ResearchPriceSeries } from "@/lib/types";
import { formatCalendarDate, formatDateTime, formatExchangeTime } from "@/ui/formatters";
import { useFinePointer } from "@/ui/pointer";
import { api, currency, percent, tone } from "@/workspace/data";
import { ClosedMarket } from "./closed-market";
import { useCurrentDay } from "./current-day";
import { quoteValue } from "./financial-values";
import { Facts, useCopy, useEscapeLayer } from "./foundation";
import type { HoldingPeekQuote } from "./holding-detail-data";
import { researchPriceQuery } from "./research-queries";
import { Sparkline } from "./sparks";

export type PeekPosition = { valueGbp?: number | null; weightPct?: number | null; label?: string };
export type PeekQuote = HoldingPeekQuote;
type PeekSession = { label: string; share: number | null; closed?: boolean; price: number | null; currency: string; asOf?: string | null };
/** The price path a card previews: the latest trading session, or three months of closes. */
export type PeekRange = "1D" | "3M";

type Bar = { date: string; close: number | null };
function hasClose(point: Bar): point is { date: string; close: number } {
  return point.close != null && Number.isFinite(point.close);
}

/** Hover or keyboard focus opens a card after 400 ms; leaving closes it after 100 ms. */
export const PEEK_OPEN_DELAY = 400;
export const PEEK_CLOSE_DELAY = 100;

/**
 * The latest session's closes, led by the close before it, from intraday bars dated in exchange time. The
 * reference close makes the line and the change start where the session's move does.
 */
export function latestSession(points: Bar[]) {
  const bars = points.filter(hasClose);
  const lastBar = bars.at(-1);
  const day = lastBar?.date.slice(0, 10) ?? null;
  if (!day) return { day, lastDate: null as string | null, closes: [] as number[], change: null, bars: 0 };
  const session = bars.filter((bar) => bar.date.slice(0, 10) === day).map((bar) => bar.close);
  const reference = bars.filter((bar) => bar.date.slice(0, 10) < day).at(-1)?.close ?? null;
  const last = session.at(-1);
  return {
    day,
    lastDate: lastBar?.date ?? null,
    closes: reference != null ? [reference, ...session] : session,
    change: reference && last != null ? last / reference - 1 : null,
    /** Bars inside the session; a daily fallback has one, which draws no path. */
    bars: session.length,
  };
}

/**
 * Attributes broker snapshot quotes separately from intraday market paths, and provides market-reading
 * timestamps when a preview opens from aggregated exposure rather than a single broker position.
 */
export function dayPeekBasis({
  quote,
  marketDay,
  marketBars,
  lastDate,
  actualInterval,
  timezone,
  locale,
  timeZone,
  now,
}: {
  quote?: PeekQuote;
  marketDay: string | null;
  marketBars: number;
  lastDate: string | null;
  actualInterval?: string | null;
  timezone?: string | null;
  locale: Locale;
  timeZone: string;
  now: number;
}) {
  if (quote) {
    const asOfText = quote.asOf
      ? formatDateTime(quote.asOf, locale, timeZone, now)
      : (locale === "zh" ? "时间未提供" : "Time unavailable");
    const marketPathDate = marketBars > 1 && marketDay ? formatCalendarDate(marketDay, locale, now) : null;
    const mismatch = Boolean(
      marketPathDate && marketDay && (quote.cited || (quote.moveDay && marketDay !== quote.moveDay.slice(0, 10))),
    );
    const stamped = quote.asOf ? " " + asOfText : "";
    const note = mismatch && marketPathDate
      ? (quote.cited
          ? (locale === "zh"
              ? `已引用券商快照${stamped}；走势为最新行情 ${marketPathDate}`
              : `Cited broker snapshot${stamped}; the path is latest market data from ${marketPathDate}`)
          : (locale === "zh"
              ? `券商快照${stamped}；走势为行情 ${marketPathDate}`
              : `Broker snapshot${stamped}; the path is market data from ${marketPathDate}`))
      : null;
    return {
      mode: "broker" as const,
      asOfText,
      brokerLabel: quote.cited ? (locale === "zh" ? "引用快照" : "Cited snapshot") : (locale === "zh" ? "券商快照" : "Broker snapshot"),
      marketPathLabel: marketPathDate ? (locale === "zh" ? "行情走势" : "Market path") : null,
      marketPathDate,
      note,
    };
  }
  const isDaily = actualInterval === "1d";
  const marketQuoteLabel = isDaily
    ? (locale === "zh" ? "行情收盘" : "Market close")
    : (locale === "zh" ? "行情报价" : "Market quote");
  const marketQuoteTime = !lastDate
    ? (locale === "zh" ? "时间未提供" : "Time unavailable")
    : isDaily || lastDate.length === 10
      ? formatCalendarDate(lastDate, locale, now)
      : formatExchangeTime(lastDate, timezone, locale, true, now);
  return {
    mode: "market" as const,
    marketQuoteLabel,
    marketQuoteTime,
    note: null,
  };
}

/**
 * A preview of a security's recent price path and the reader's holding, for pointer and keyboard.
 * Touch keeps the plain tap target; prices are requested only once the card opens.
 */
export function SecurityPeek({
  ticker,
  priceTicker,
  position,
  session,
  quote,
  range = "3M",
  children,
}: {
  ticker?: string | null;
  priceTicker?: string | null;
  position?: PeekPosition;
  session?: PeekSession;
  quote?: PeekQuote;
  range?: PeekRange;
  children: ReactNode;
}) {
  const pointer = useFinePointer();
  if (!pointer || !ticker || ticker === "—") return <>{children}</>;
  return <Peek ticker={ticker} priceTicker={priceTicker} position={position} session={session} quote={quote} range={range}>{children}</Peek>;
}

function Peek({ ticker, priceTicker, position, session, quote, range, children }: {
  ticker: string; priceTicker?: string | null; position?: PeekPosition; session?: PeekSession; quote?: PeekQuote; range: PeekRange; children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
  };
  const schedule = (open: boolean) => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpened(open);
    }, open ? PEEK_OPEN_DELAY : PEEK_CLOSE_DELAY);
  };
  useEffect(() => cancel, []);
  // The card previews what the row's own link or button already leads to, so it
  // opens on that element's keyboard focus and closes when focus moves on.
  useEffect(() => {
    const host = target.current?.closest<HTMLElement>("a[href], button, [tabindex]");
    if (!host) return;
    const focus = () => { if (host.matches(":focus-visible")) schedule(true); };
    const blur = () => schedule(false);
    host.addEventListener("focus", focus);
    host.addEventListener("blur", blur);
    return () => {
      host.removeEventListener("focus", focus);
      host.removeEventListener("blur", blur);
    };
    // schedule only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEscapeLayer(opened, () => {
    cancel();
    setOpened(false);
  });
  // Below the name keeps the row's own figures visible; it flips above near the window's end.
  return (
    <Popover opened={opened} position="bottom-start" offset={6} withinPortal withRoles={false} trapFocus={false}
      returnFocus={false} hideDetached={false} middlewares={{ flip: true, shift: { padding: 8 } }}
      transitionProps={{ transition: "fade", duration: 120, timingFunction: "ease-out" }} zIndex="var(--mx-overlay-z-popover)">
      <Popover.Target>
        <div ref={target} className="mx-peek-target"
          onPointerEnter={(event) => { if (event.pointerType !== "touch") schedule(true); }}
          onPointerLeave={() => schedule(false)}>
          {children}
        </div>
      </Popover.Target>
      {/* The card renders in a portal but still bubbles through its trigger's link in React: a click on it stays here. */}
      <Popover.Dropdown className="mx-peek" onClick={(event) => event.stopPropagation()}
        onPointerEnter={cancel} onPointerLeave={() => schedule(false)}>
        {session ? <SessionPeek ticker={ticker} position={position} session={session} /> :
          range === "1D" ? <DayPeek ticker={ticker} priceTicker={priceTicker} position={position} quote={quote} /> : <PeekBody ticker={ticker} position={position} />}
      </Popover.Dropdown>
    </Popover>
  );
}

function positionFact(position: PeekPosition | undefined, label: string): Array<[string, ReactNode]> {
  if (position?.valueGbp == null || position.valueGbp <= 0) return [];
  // The row already carries the weight; the card adds the holding's value.
  return [[position.label ?? label, currency(position.valueGbp)]];
}

/** Code and price; a 6px warning dot marks a price whose source or time differs from the row's. */
function PeekHead({ ticker, price, note }: { ticker: string; price: string; note?: string | null }) {
  return (
    <div className="mx-peek-head">
      <span>{ticker}</span>
      <strong aria-label={note ? price + "，" + note : undefined}>
        {note && <i className="mx-peek-flag" aria-hidden="true" />}
        {price}
      </strong>
    </div>
  );
}

function SessionPeek({ ticker, session, position }: { ticker: string; session: PeekSession; position?: PeekPosition }) {
  const t = useCopy();
  return (
    <>
      <PeekHead ticker={ticker} price={quoteValue(session.price, session.currency)} />
      <Facts rows={[
        [session.label, session.closed ? <ClosedMarket /> : <span key="session" className={session.share == null ? undefined : "mx-" + tone(session.share)}>
          {percent(session.share, true, 2)}
        </span>],
        ...positionFact(position, t("持仓", "Holding")),
      ]} />
    </>
  );
}

/**
 * The latest session's path from fifteen-minute bars. The last 160 bars span several sessions, so they carry the
 * close before it; without intraday prices the endpoint answers with daily closes, and only the move shows.
 */
function DayPeek({ ticker, priceTicker, position, quote }: { ticker: string; priceTicker?: string | null; position?: PeekPosition; quote?: PeekQuote }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { today, now } = useCurrentDay();
  const symbol = priceTicker || ticker;
  const query = useQuery({
    queryKey: ["workspace-prices", symbol, "15m", "peek"],
    queryFn: ({ signal }) => api<ResearchPriceSeries>(
      `/research/${encodeURIComponent(symbol)}/prices?limit=160&interval=15m`, { signal }),
    staleTime: 300_000,
    retry: 1,
  });
  const { day, lastDate, closes, change, bars } = latestSession(query.data?.points ?? []);
  const last = closes.at(-1);
  // A held row carries its own account's broker price and move; aggregated exposure reads the market series.
  const moveDay = quote ? quote.moveDay : day;
  const move = quote ? quote.move : change;
  const label = !moveDay || moveDay.slice(0, 10) === today ? t("今日", "Today") : formatCalendarDate(moveDay.slice(0, 10), locale, now);
  const price = quote ? quoteValue(quote.price, quote.currency) : last != null ? quoteValue(last, query.data?.currency) : query.isPending ? "" : "—";
  const basis = dayPeekBasis({
    quote,
    marketDay: day,
    marketBars: bars,
    lastDate,
    actualInterval: query.data?.actualInterval,
    timezone: query.data?.timezone,
    locale,
    timeZone,
    now,
  });
  return (
    <>
      <PeekHead ticker={ticker} price={price} note={basis.note} />
      {/* The path takes the tone of the move shown beside it, so the two never disagree in colour. */}
      {query.isPending ? <div className="mx-peek-skeleton" /> : bars > 1 && <Sparkline values={closes} className={"mx-" + tone(move)} />}
      <Facts
        rows={[
          ...(quote?.closed ? [[label, <ClosedMarket key="closed" />] as [string, ReactNode]]
            : move != null ? [[label, <span key="change" className={"mx-" + tone(move)}>{percent(move, true, 2)}</span>] as [string, ReactNode]] : []),
          ...positionFact(position, t("持仓", "Holding")),
          ...(basis.mode === "broker" && quote ? [
            [t("账户", "Account"), quote.account] as [string, ReactNode],
            [basis.brokerLabel, quote.asOf ? <time key="broker-time" dateTime={quote.asOf}>{basis.asOfText}</time> : basis.asOfText] as [string, ReactNode],
            ...(basis.marketPathLabel && basis.marketPathDate && day
              ? [[basis.marketPathLabel, <time key="market-day" dateTime={day}>{basis.marketPathDate}</time>] as [string, ReactNode]]
              : []),
          ] : !query.isPending && last != null ? [
            [basis.marketQuoteLabel, lastDate ? <time key="market-time" dateTime={lastDate}>{basis.marketQuoteTime}</time> : basis.marketQuoteTime] as [string, ReactNode],
          ] : []),
        ]}
      />
    </>
  );
}

function PeekBody({ ticker, position }: { ticker: string; position?: PeekPosition }) {
  const t = useCopy();
  const query = useQuery(researchPriceQuery(ticker, undefined, "1d", "3M"));
  const points = inRange(query.data?.points ?? [], "3M").filter(hasClose);
  const closes = points.map(({ close }) => close);
  const first = closes[0];
  const last = closes.at(-1);
  const change = first && last != null ? last / first - 1 : null;
  return (
    <>
      <PeekHead ticker={ticker} price={last != null ? quoteValue(last, query.data?.currency) : query.isPending ? "" : "—"} />
      {query.isPending ? <div className="mx-peek-skeleton" /> : closes.length > 1 && <Sparkline values={closes} className={"mx-" + tone(change)} />}
      <Facts
        rows={[
          ...(change != null ? [["3M", <span key="change" className={"mx-" + tone(change)}>{percent(change, true, 1)}</span>] as [string, ReactNode]] : []),
          ...positionFact(position, t("持仓", "Holding")),
        ]}
      />
    </>
  );
}
