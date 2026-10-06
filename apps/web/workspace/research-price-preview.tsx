"use client";
import { researchPriceQuery } from "./research-queries";

import { useQuery } from "@tanstack/react-query";
import { Plot } from "./charts";
import { inRange } from "@/lib/portfolio/nav";
import { number } from "@/workspace/data";
import type { TechnicalScoreSummary } from "@/lib/types";
import { TechnicalScoreCard } from "./research-technical";
import {
  Empty,
  Panel,
  Pending,
  QueryError,
  useCopy,
} from "./foundation";

/** A stable overview; all analytical controls belong to the technical workspace. */
export function PricePreview({
  ticker,
  runId,
  summary,
  pending = false,
}: {
  ticker: string;
  runId: string;
  summary?: TechnicalScoreSummary | null;
  pending?: boolean;
}) {
  const t = useCopy();
  const query = useQuery(researchPriceQuery(ticker, runId, "1d", "3M"));
  const points = inRange(query.data?.points ?? [], "3M");
  const hasPrices = points.some((p) => Number.isFinite(p.close));
  return (
    <Panel
      title={`${t("价格走势", "Price history")} · 3M`}
      className="mx-price-diagnosis-preview"
    >
      <div className="mx-tech-preview-grid"><div>
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : !hasPrices ? (
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
                formatter: (date: string) => date.slice(0, 10),
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
                  p.date.slice(0, 10) + " · " + query.data.currency,
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
      </div><TechnicalScoreCard data={summary} ticker={ticker} pending={pending} compact /></div>
    </Panel>
  );
}
