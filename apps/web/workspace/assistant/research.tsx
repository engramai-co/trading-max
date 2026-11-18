"use client";

import { useMemo } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { useCopy } from "../foundation";
import { useRouteState } from "../route-state";
import { DigestRow, EvidenceLink, FollowUps, ReadingLines } from "./cards";
import { useAssistant, usePageRole } from "./context";
import { useRoleReading } from "./reading";

export type PriceObject = { ticker: string; published_series_id: string; index_id?: string };

/** Preserve the resolved ticker and lens even when the Research URL uses its defaults. */
export function useResearchOrigin(ticker: string, lens: string, snapshotId?: string) {
  const { params } = useRouteState();
  const search = params.toString();
  return useMemo(() => {
    const query = new URLSearchParams(search);
    query.set("ticker", ticker);
    if (lens === "technical" || lens === "overview" || lens === "price") query.set("scope","broker_total");
    query.set("view", lens);
    return { page: "research", search: "?" + query, snapshotId };
  }, [ticker, lens, snapshotId, search]);
}

type PositionProps = { security: PriceObject; snapshotId?: string; name?: string };
export function PositionReading(props: PositionProps) {
  const { ready, open } = useAssistant();
  return ready && open && props.snapshotId ? <OpenPositionReading {...props} /> : null;
}
function OpenPositionReading({ security, snapshotId, name }: PositionProps) {
  const t = useCopy();
  const result = useRoleReading({ role: "your-position", context: security, snapshotId }, true);
  const origin = useResearchOrigin(security.ticker, "overview", snapshotId);
  const { ticker, published_series_id, index_id } = security;
  const context = useMemo(() => ({ticker, published_series_id, ...(index_id ? {index_id} : {})}), [ticker, published_series_id, index_id]);
  const card = useMemo(() => (result.data || result.isFetching) ? {
    role: "your-position", title: t("与我相关", "Your position"), object: name || security.ticker,
    questions: [t("这段时间价格如何变化？", "How did the price change?"),
      t("有哪些已核实的事件？", "Which dated events can be verified?"),
      t("与同期市场相比呢？", "How does it compare with the market?")],
    context, origin, reading: result.data,
    status: result.isFetching ? t("正在读取行情与成交记录…", "Reading prices and trade records…") : undefined,
  } : null, [result.data, result.isFetching, t, name, security.ticker, context, origin]);
  usePageRole(card);
  return null;
}

export function EarningsBrief({ ticker, lens, snapshotId }: { ticker: string; lens: string; snapshotId: string }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { ready } = useAssistant();
  const result = useRoleReading({ role: "earnings-brief", context: { ticker }, snapshotId, cachedOnly: true, latest: true }, true);
  const reading = ready ? result.data : null;
  const origin = useResearchOrigin(ticker, lens, reading?.snapshotId ?? undefined);
  const card = useMemo(() => reading ? {
    role: "earnings-brief", title: t("财报速读", "Earnings brief"), object: ticker, reading, origin, context: { ticker },
    questions: [t("实际业绩与预期相差多少？", "How did results compare with estimates?"),
      t("哪些预期有变化？", "Which estimates changed?"), t("下一期看哪些数据？", "Which figures are due next?")],
  } : null, [reading, ticker, origin, t]);
  usePageRole(card);
  if (!card || !reading?.lines.length) return null;
  const first = reading.lines[0];
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(reading.asOf));
  return <div className="mx-earnings-brief"><DigestRow storageKey="research-earnings" header={null}
    headline={<>{card.title} · {ticker} <time dateTime={reading.asOf}>{formatCalendarDate(stamp, locale)}</time></>}
    summary={t(first.zh, first.en)} summarySource={<EvidenceLink evidence={first.evidence} />}>
    <ReadingLines card={card} /><FollowUps card={card} />
  </DigestRow></div>;
}
