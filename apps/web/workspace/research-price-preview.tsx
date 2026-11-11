"use client";

import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { Plot } from "./charts";
import { inRange } from "@/lib/portfolio/nav";
import { number } from "@/workspace/data";
import type { TechnicalScoreSummary } from "@/lib/types";
import type { useOverviewPrices } from "./research";
import { TechnicalScoreCard } from "./research-technical";
import {
  Empty,
  Panel,
  Pending,
  QueryError,
  UpdateFailure,
  useCopy,
} from "./foundation";

/** A stable overview; all analytical controls belong to the technical workspace. */
export function PricePreview({
  ticker,
  query,
  summary,
  pending = false,
}: {
  ticker: string;
  query: ReturnType<typeof useOverviewPrices>;
  summary?: TechnicalScoreSummary | null;
  pending?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const points = inRange(query.data?.points ?? [], "3M");
  const hasPrices = points.some((p) => Number.isFinite(p.close));
  return (
    <Panel
      title={`${t("价格走势", "Price history")} · 3M`}
      className="mx-price-diagnosis-preview"
      action={query.isRefetchError && <UpdateFailure updatedAt={query.dataUpdatedAt} retry={query.refetch} />}
    >
      <div className="mx-tech-preview-grid"><div>
      {query.isPending ? (
        <Pending shape="chart" height={300} label={t("正在读取价格走势…", "Loading price history…")} />
      ) : query.isError && !query.data ? (
        <QueryError retry={query.refetch} />
      ) : !query.data || !hasPrices ? (
        <Empty title={t("暂无价格数据", "Price history unavailable")} />
      ) : (
        <Plot
          research
          height={300}
          label={`${ticker} · ${t("近三个月价格走势", "Three months of closing prices")} · ${query.data.currency}`}
          option={(c) => ({
            grid: { top: 18, right: 52, bottom: 28, left: 4 },
            xAxis: {
              type: "category",
              data: points.map((p) => p.date),
              boundaryGap: false,
              axisLine: { show: false },
              axisTick: { show: false },
              axisLabel: {
                color: c.axis,
                hideOverlap: true,
                interval: Math.max(0, Math.ceil(points.length / 7) - 1),
                formatter: (date: string) => formatCalendarDate(date, locale),
              },
            },
            yAxis: {
              type: "value",
              scale: true,
              position: "right",
              splitNumber: 4,
              name: query.data.currency,
              nameTextStyle: { color: c.axis },
              axisLabel: { color: c.axis },
              splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
            },
            tooltip: {
              formatter: (input) => {
                const entry = (Array.isArray(input) ? input : [input])[0];
                const p = points[entry?.dataIndex];
                if (!p) return "";
                return [
                  formatCalendarDate(p.date, locale) + " · " + query.data.currency,
                  `${t("收盘", "Close")}  ${number(p.close, 2)}`,
                ].join("\n");
              },
            },
            series: [
              {
                type: "line",
                name: ticker,
                data: points.map((p) => p.close),
                showSymbol: false,
                connectNulls: false,
                smooth: false,
                lineStyle: { color: c.brand, width: 2 },
                itemStyle: { color: c.brand },
                areaStyle: { color: c.brand, opacity: 0.06 },
              },
            ],
          })}
        />
      )}
      </div><TechnicalScoreCard data={summary} pending={pending} compact /></div>
    </Panel>
  );
}
