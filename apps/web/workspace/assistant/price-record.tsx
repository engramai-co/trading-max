"use client";

import { ArrowRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import type { ResearchPriceSeries } from "@/lib/types";
import { number } from "../data";
import { useCopy } from "../foundation";
import Link from "../link";
import { volume } from "../reading-format";
import { citationPreview, type Evidence } from "./evidence";
import { useAssistantRecordNavigation } from "./citation";

const price = new Intl.NumberFormat("en-GB", {minimumFractionDigits: 2, maximumFractionDigits: 2});

export function PriceRecord({evidence, text}: {evidence: Evidence; text: string}) {
  const t = useCopy();
  const {locale, timeZone} = useLocale();
  const client = useQueryClient();
  const openRecord = useAssistantRecordNavigation();
  const args = evidence.arguments;
  const href = citationPreview(evidence, locale, timeZone, text)?.href;
  if (!args?.date || !args.ticker || !href?.startsWith("/research?")) return null;
  const series = client.getQueriesData<ResearchPriceSeries>({queryKey: ["workspace-prices", args.ticker, "1d"]})
    .map(([, data]) => data).find(data => data?.ticker === args.ticker && data.actualInterval === "1d" &&
      args.snapshotId && data.snapshotId === args.snapshotId && args.published_series_id &&
      [data.publishedSeriesId, data.observedSeriesId].includes(args.published_series_id));
  const index = series?.points.findIndex(point => point.date === args.date) ?? -1;
  const row = series?.points[index];
  const prior = index >= 20 && series ? series.points.slice(index - 20, index).map(point => point.volume) : [];
  const total = prior.length === 20 && prior.every(value => value != null && Number.isFinite(value))
    ? prior.reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0;
  const ratio = row?.volume != null && total > 0 ? row.volume / (total / 20) : null;
  return <aside className="mx-assistant-record">
    <strong>{args.ticker} · {t("日线", "Daily price")} · {formatCalendarDate(args.date, locale)}</strong>
    {row ? <>
      <p className="mx-assistant-ohlc">{([[t("开", "Open"), row.open], [t("高", "High"), row.high],
        [t("低", "Low"), row.low], [t("收", "Close"), row.close]] as const)
        .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number")
        .map(([label, value]) => <span key={label}>{label} {price.format(value)}</span>)}</p>
      {row.volume != null && <p>{t("成交", "Volume")} {volume(row.volume, locale)}
        {ratio !== null && " · " + t("20 日均量", "20-day average") + " " + number(ratio, 2) + t(" 倍", "×")}</p>}
    </> : <p>{text}</p>}
    <Link className="mx-text-link" href={href} onNavigate={() => openRecord(href)}>{t("打开记录", "Open record")} <ArrowRight size={16} aria-hidden="true" /></Link>
  </aside>;
}
