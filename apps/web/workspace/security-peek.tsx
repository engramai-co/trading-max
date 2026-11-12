"use client";

import { HoverCard } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { inRange } from "@/lib/portfolio/nav";
import { useFinePointer } from "@/ui/pointer";
import { currency, percent, tone } from "@/workspace/data";
import { ClosedMarket } from "./closed-market";
import { quoteValue } from "./financial-values";
import { Facts, useCopy } from "./foundation";
import { researchPriceQuery } from "./research-queries";
import { Sparkline } from "./sparks";

export type PeekPosition = { valueGbp?: number | null; weightPct?: number | null; label?: string };
type PeekSession = { label: string; share: number | null; closed?: boolean; price: number | null; currency: string; asOf?: string | null };

/**
 * A pointer-only preview of a security's recent price path and the reader's position.
 * Touch keeps the plain tap target; prices are requested only once the card opens.
 */
export function SecurityPeek({
  ticker,
  position,
  session,
  children,
}: {
  ticker?: string | null;
  position?: PeekPosition;
  session?: PeekSession;
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
          <PeekBody ticker={ticker} position={position} />}
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
