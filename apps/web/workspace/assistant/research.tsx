"use client";
import "./research.css";

import { useMemo } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { useCopy } from "../foundation";
import { DigestRow, EvidenceLink, FollowUps, ReadingLines } from "./cards";
import { useAssistant, usePageRole } from "./context";
import { readerText, type Reading } from "./evidence";
import { fetchReading, useRoleReading } from "./reading";

export type PriceObject = { ticker: string; published_series_id: string; index_id?: string };

/** Capture the reading's identity so a handoff keeps it across navigation. */
export function useResearchOrigin(ticker: string, lens: string, snapshotId?: string, chartRange?: string, indexId?: string) {
  const { researchChartWindows: { overview } } = useAssistant();
  const range = chartRange ?? (lens === "overview" && overview?.identity === ticker
    ? overview.range : undefined);
  return useMemo(() => ({
    page: "research",
    search: lens === "technical" || lens === "overview" ? "scope=broker_total" : "",
    snapshotId,
    research: { ticker, lens, range, indexId },
  }), [ticker, lens, range, snapshotId, indexId]);
}

type PositionProps = { security: PriceObject; snapshotId?: string; name?: string };
export function PositionReading(props: PositionProps) {
  const { ready, open } = useAssistant();
  return ready && open && props.snapshotId ? <OpenPositionReading {...props} /> : null;
}
function OpenPositionReading({ security, snapshotId, name }: PositionProps) {
  const t = useCopy();
  const result = useRoleReading({ role: "your-position", context: security, snapshotId }, true);
  const { ticker, published_series_id, index_id } = security;
  const origin = useResearchOrigin(ticker, "overview", snapshotId, undefined, index_id);
  const context = useMemo(() => ({ticker, published_series_id, ...(index_id ? {index_id} : {})}), [ticker, published_series_id, index_id]);
  const card = useMemo(() => (result.data || result.isFetching) ? {
    role: "your-position", title: t("与我相关", "Your position"), object: name || ticker,
    questions: [t("这段时间价格如何变化？", "How did the price change?"),
      t("有哪些已核实的事件？", "Which dated events can be verified?"),
      t("与同期市场相比呢？", "How does it compare with the market?")],
    context, origin, reading: result.data,
    status: result.isFetching ? t("正在读取行情与成交记录…", "Reading prices and trade records…") : undefined,
  } : null, [result.data, result.isFetching, t, name, ticker, context, origin]);
  usePageRole(card);
  return null;
}

export function cachedEarnings(ticker: string, snapshotId: string, signal: AbortSignal) {
  return fetchReading({role:"earnings-brief", context:{ticker}, snapshotId, cachedOnly:true, latest:true}, signal);
}

export function EarningsBrief({ ticker, lens, reading, minHeight }: { ticker: string; lens: string; reading: Reading; minHeight?: number }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const origin = useResearchOrigin(ticker, lens, reading?.snapshotId ?? undefined);
  const card = useMemo(() => reading ? {
    role: "earnings-brief", title: t("财报速读", "Earnings brief"), object: ticker, reading, origin, context: { ticker },
    questions: [t("实际业绩与预期相差多少？", "How did results compare with estimates?"),
      t("哪些预期有变化？", "Which estimates changed?"), t("下一期看哪些数据？", "Which figures are due next?")],
  } : null, [reading, ticker, origin, t]);
  usePageRole(card);
  if (!card || !reading?.lines.length) return null;
  const first = reading.lines[0];
  const args = first.evidence.arguments;
  const observed = args?.observedAt || reading.asOf;
  const stamp = args?.reportDate || (/^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed : new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(observed)));
  return <div className="mx-earnings-brief" style={{minHeight}}><DigestRow storageKey="research-earnings" header={null}
    headline={<>{card.title} · {ticker}{args?.fiscalPeriod && " · " + args.fiscalPeriod} <time dateTime={stamp}>{!args?.reportDate && t("观测于 ", "Observed ")}{formatCalendarDate(stamp, locale)}</time></>}
    summary={readerText(first, locale, timeZone)} summarySource={<EvidenceLink evidence={first.evidence} />}>
    <ReadingLines card={card} /><FollowUps card={card} />
  </DigestRow></div>;
}
