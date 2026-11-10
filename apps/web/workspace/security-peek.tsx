"use client";

import { HoverCard } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { inRange } from "@/lib/portfolio/nav";
import { useFinePointer } from "@/ui/pointer";
import { currency, percent, tone } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import { Facts, useCopy } from "./foundation";
import { researchPriceQuery } from "./research-queries";
import { Sparkline } from "./sparks";

export type PeekPosition = { valueGbp?: number | null; weightPct?: number | null; label?: string };

/**
 * A pointer-only preview of a security's recent price path and the reader's position.
 * Touch keeps the plain tap target; prices are requested only once the card opens.
 */
export function SecurityPeek({
  ticker,
  position,
  children,
}: {
  ticker?: string | null;
  position?: PeekPosition;
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
        <PeekBody ticker={ticker} position={position} />
      </HoverCard.Dropdown>
    </HoverCard>
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
  const held = position?.valueGbp != null && position.valueGbp > 0;
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
          ...(held ? [[position?.label ?? t("持仓", "Position"), currency(position?.valueGbp) + (position?.weightPct != null ? " · " + percent(position.weightPct) : "")] as [string, ReactNode]] : []),
        ]}
      />
    </>
  );
}
