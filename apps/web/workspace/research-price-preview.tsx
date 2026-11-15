"use client";

import Link from "./link";
import { useMediaQuery } from "@mantine/hooks";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { inRange } from "@/lib/portfolio/nav";
import { number } from "@/workspace/data";
import type { TechnicalScoreSummary } from "@/lib/types";
import type { useOverviewPrices } from "./research";
import { Plot } from "./charts";
import { candleSeries, candleValues, priceBarReading, priceGapConnectors } from "./research-price-candles";
import { TechnicalScoreCard } from "./research-technical";
import { Empty, Panel, Pending, QueryError, UpdateFailure, useCopy } from "./foundation";

/** A fixed three-month daily preview. Analytical controls live in Technical. */
export function PricePreview({ ticker, query, summary, pending = false }: {
  ticker: string;
  query: ReturnType<typeof useOverviewPrices>;
  summary?: TechnicalScoreSummary | null;
  pending?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const phone = useMediaQuery("(max-width: 767px)");
  const height = phone ? 235 : 280;
  const points = inRange(query.data?.points ?? [], "3M").filter((p) => Number.isFinite(p.close));
  const latest = points.at(-1);
  const code = query.data?.currency ?? "";
  const bars = candleValues(points);
  const candles = bars.some((bar) => bar[0] != null);
  const gaps = candles ? priceGapConnectors(bars.map((bar) => bar[1])) : [];
  const labels = { open: t("开盘", "Open"), high: t("最高", "High"), low: t("最低", "Low"), close: t("收盘", "Close") };
  const format = (v: number | null) => number(v, 2);
  return (
    <Panel
      title={`${t("价格走势", "Price history")} · 3M`}
      className="mx-price-diagnosis-preview"
      action={<>
        {query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={query.refetch} />}
        <Link className="mx-text-link" href={`/research?${new URLSearchParams({ ticker, view: "technical", priceRange: "3M", priceStyle: "candles" })}`}>
          {t("技术面", "Technicals")}
        </Link>
      </>}
    >
      <div className="mx-tech-preview-grid">
        <div>
          {query.isPending ? (
            <Pending shape="chart" height={height} label={t("正在读取价格走势…", "Loading price history…")} />
          ) : query.isError && !query.data ? (
            <QueryError retry={query.refetch} />
          ) : !latest ? (
            <Empty title={t("暂无价格数据", "Price history unavailable")} />
          ) : (
            <>
              {!candles && <p className="mx-price-caveat" role="status">{t("暂无 OHLC，仅显示收盘价", "OHLC unavailable; closing prices shown")}</p>}
              <Plot
                research
                height={height}
                label={`${ticker} · ${candles ? t("近三个月 K 线", "Three-month candlestick chart") : t("近三个月收盘价", "Three months of closing prices")}`}
                readout={{
                  positions: points.flatMap((_, index) => !candles || bars[index][0] != null ? [index] : []),
                  gap: (index) => candles && bars[Math.round(index)]?.[0] == null,
                  latest: `${format(latest.close)} ${code}`,
                  point: (index) => priceBarReading(points[index], formatCalendarDate(points[index].date, locale), code, labels, format, candles).join("\n"),
                }}
                option={(c) => ({
                  grid: { top: 12, right: 52, bottom: 28, left: 4 },
                  xAxis: {
                    type: "category",
                    data: points.map((p) => p.date),
                    boundaryGap: candles,
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: {
                      interval: Math.max(0, Math.ceil(points.length / (phone ? 3 : 6)) - 1),
                      formatter: (date: string) => formatCalendarDate(date, locale),
                    },
                  },
                  yAxis: {
                    type: "value", scale: true, splitNumber: 4, position: "right",
                    axisLabel: { formatter: (v: number) => number(v, 2) },
                  },
                  series: [candles ? candleSeries(ticker, bars, c) : {
                    type: "line",
                    name: ticker,
                    data: points.map((p) => p.close),
                    showSymbol: points.length < 3,
                    connectNulls: false,
                    lineStyle: { color: c.brand, width: 2 },
                    itemStyle: { color: c.brand },
                  }, ...(gaps.length ? [{
                    id: "history-gap:preview", type: "line" as const, data: gaps, silent: true, showSymbol: false,
                    tooltip: { show: false }, lineStyle: { color: c.axis, type: "dotted" as const, width: 1.5 },
                  }] : [])],
                })}
              />
              <div className="mx-chart-footer">{formatDateSpan(points[0].date, latest.date, locale)}</div>
            </>
          )}
        </div>
        <TechnicalScoreCard data={summary} pending={pending} compact />
      </div>
    </Panel>
  );
}
