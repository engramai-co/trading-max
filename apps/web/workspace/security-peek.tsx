"use client";

import { HoverCard } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useLocale } from "@/components/locale-provider";
import { inRange } from "@/lib/portfolio/nav";
import type { ResearchPriceSeries } from "@/lib/types";
import { formatCalendarDate } from "@/ui/formatters";
import { useFinePointer } from "@/ui/pointer";
import { api, currency, percent, tone } from "@/workspace/data";
import { ClosedMarket } from "./closed-market";
import { useCurrentDay } from "./current-day";
import { quoteValue } from "./financial-values";
import { Facts, useCopy } from "./foundation";
import { researchPriceQuery } from "./research-queries";
import { Sparkline } from "./sparks";

export type PeekPosition = { valueGbp?: number | null; weightPct?: number | null; label?: string };
type PeekSession = { label: string; share: number | null; closed?: boolean; price: number | null; currency: string; asOf?: string | null };
/** The price path a card previews: the latest trading session, or three months of closes. */
export type PeekRange = "1D" | "3M";

type Bar = { date: string; close: number | null };

/**
 * The latest session's closes, led by the close before it, from intraday bars dated in exchange time. The
 * reference close makes the line and the change start where the session's move does.
 */
export function latestSession(points: Bar[]) {
  const bars = points.filter((point): point is { date: string; close: number } =>
    point.close != null && Number.isFinite(point.close));
  const day = bars.at(-1)?.date.slice(0, 10) ?? null;
  if (!day) return { day, closes: [] as number[], change: null, bars: 0 };
  const session = bars.filter((bar) => bar.date.slice(0, 10) === day).map((bar) => bar.close);
  const reference = bars.filter((bar) => bar.date.slice(0, 10) < day).at(-1)?.close ?? null;
  const last = session.at(-1);
  return {
    day,
    closes: reference != null ? [reference, ...session] : session,
    change: reference && last != null ? last / reference - 1 : null,
    /** Bars inside the session; a daily fallback has one, which draws no path. */
    bars: session.length,
  };
}

/**
 * A pointer-only preview of a security's recent price path and the reader's position.
 * Touch keeps the plain tap target; prices are requested only once the card opens.
 */
export function SecurityPeek({
  ticker,
  position,
  session,
  range = "3M",
  children,
}: {
  ticker?: string | null;
  position?: PeekPosition;
  session?: PeekSession;
  range?: PeekRange;
  children: ReactNode;
}) {
  const pointer = useFinePointer();
  if (!pointer || !ticker || ticker === "—") return <>{children}</>;
  // The card only previews what the link already leads to, so the target keeps
  // its own semantics: no popup roles on a plain wrapper.
  return (
    <HoverCard openDelay={400} closeDelay={80} position="right-start" offset={14} shadow="md" withinPortal withRoles={false}>
      <HoverCard.Target>
        <div className="mx-peek-target">{children}</div>
      </HoverCard.Target>
      {/* The card renders in a portal but still bubbles through its trigger's link in React: a click on it stays here. */}
      <HoverCard.Dropdown className="mx-peek" onClick={(event) => event.stopPropagation()}>
        {session ? <SessionPeek ticker={ticker} position={position} session={session} /> :
          range === "1D" ? <DayPeek ticker={ticker} position={position} /> : <PeekBody ticker={ticker} position={position} />}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function positionFact(position: PeekPosition | undefined, label: string): Array<[string, ReactNode]> {
  if (position?.valueGbp == null || position.valueGbp <= 0) return [];
  return [[position.label ?? label, currency(position.valueGbp) + (position.weightPct != null ? " · " + percent(position.weightPct) : "")]];
}

function SessionPeek({ ticker, session, position }: { ticker: string; session: PeekSession; position?: PeekPosition }) {
  const t = useCopy();
  return (
    <>
      <div className="mx-peek-head">
        <span>{ticker}</span>
        <strong title={t("券商持仓快照", "Broker position snapshot") + (session.asOf ? " · " + session.asOf : "")}>
          {quoteValue(session.price, session.currency, "")}
        </strong>
      </div>
      <Facts rows={[
        [session.label, session.closed ? <ClosedMarket /> : <span key="session" className={session.share == null ? undefined : "mx-" + tone(session.share)}
          title={t("券商日内持仓变动，以当日首次观测为基准", "Broker position move since the session’s first observation")}>
          {percent(session.share, true, 2)}
        </span>],
        ...positionFact(position, t("持仓", "Position")),
      ]} />
    </>
  );
}

/**
 * The latest session's path from fifteen-minute bars. The last 160 bars span several sessions, so they carry the
 * close before it; without intraday prices the endpoint answers with daily closes, and only the move shows.
 */
function DayPeek({ ticker, position }: { ticker: string; position?: PeekPosition }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { today, now } = useCurrentDay();
  const query = useQuery({
    queryKey: ["workspace-prices", ticker, "15m", "peek"],
    queryFn: ({ signal }) => api<ResearchPriceSeries>(
      `/research/${encodeURIComponent(ticker)}/prices?limit=160&interval=15m`, { signal }),
    staleTime: 300_000,
    retry: 1,
  });
  const { day, closes, change, bars } = latestSession(query.data?.points ?? []);
  const last = closes.at(-1);
  const label = !day || day === today ? t("今日", "Today") : formatCalendarDate(day, locale, now);
  return (
    <>
      <div className="mx-peek-head">
        <span>{ticker}</span>
        <strong>{last != null ? quoteValue(last, query.data?.currency, "") : query.isPending ? "" : "—"}</strong>
      </div>
      {query.isPending ? (
        <div className="mx-peek-skeleton" />
      ) : bars > 1 ? (
        <Sparkline values={closes} className={"mx-" + tone(change)} />
      ) : change == null ? (
        <p className="mx-peek-empty">{t("暂无当日走势", "No intraday prices")}</p>
      ) : null}
      <Facts
        rows={[
          ...(change != null ? [[label, <span key="change" className={"mx-" + tone(change)}>{percent(change, true, 2)}</span>] as [string, ReactNode]] : []),
          ...positionFact(position, t("持仓", "Position")),
        ]}
      />
    </>
  );
}

function PeekBody({ ticker, position }: { ticker: string; position?: PeekPosition }) {
  const t = useCopy();
  const query = useQuery(researchPriceQuery(ticker, undefined, "1d", "3M"));
  const closes = inRange(query.data?.points ?? [], "3M")
    .map((point) => point.close)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const first = closes[0];
  const last = closes.at(-1);
  const change = first && last != null ? last / first - 1 : null;
  return (
    <>
      <div className="mx-peek-head">
        <span>{ticker}</span>
        <strong>{last != null ? quoteValue(last, query.data?.currency, "") : query.isPending ? "" : "—"}</strong>
      </div>
      {query.isPending ? (
        <div className="mx-peek-skeleton" />
      ) : closes.length > 1 ? (
        <Sparkline values={closes} className={"mx-" + tone(change)} />
      ) : (
        <p className="mx-peek-empty">{t("暂无价格走势", "No recent prices")}</p>
      )}
      <Facts
        rows={[
          ...(change != null ? [["3M", <span key="change" className={"mx-" + tone(change)}>{percent(change, true, 1)}</span>] as [string, ReactNode]] : []),
          ...positionFact(position, t("持仓", "Position")),
        ]}
      />
    </>
  );
}
