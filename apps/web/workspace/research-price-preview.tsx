"use client";

import type { ResearchPriceSeries } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Plot } from "./charts";
import { api, inRange, number } from "./data";
import {
  Empty,
  Panel,
  Pending,
  QueryError,
  TextLink,
  useCopy,
} from "./foundation";

/** A stable overview; all analytical controls belong to the technical workspace. */
export function PricePreview({
  ticker,
  runId,
}: {
  ticker: string;
  runId: string;
}) {
  const t = useCopy();
  const query = useQuery({
    queryKey: ["workspace-prices", runId, ticker, "1d"],
    queryFn: () =>
      api<ResearchPriceSeries>(
        `/research/${encodeURIComponent(ticker)}/prices?limit=2000&interval=1d`,
      ),
    staleTime: 300_000,
    retry: 1,
  });
  const points = inRange(query.data?.points ?? [], "3M");
  const hasCandles =
    points.length > 0 &&
    points.every((p) => p.open != null && p.high != null && p.low != null);
  return (
    <Panel
      title={`${t("价格走势", "Price history")} · 3M`}
      action={
        <TextLink
          href={`/research?ticker=${encodeURIComponent(ticker)}&view=technical&priceRange=3M&interval=1d&priceStyle=candles`}
        >
          {t("价格与技术", "Price & technicals")}
        </TextLink>
      }
    >
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : !hasCandles ? (
        <Empty title={t("暂无日线 K 线数据", "Daily candles unavailable")} />
      ) : (
        <Plot
          research
          height={300}
          label={`${ticker} · ${t("近三个月日线 K 线", "Three months of daily candles")} · ${query.data.currency}`}
          option={(c) => ({
            grid: { top: 18, right: 52, bottom: 28, left: 4 },
            xAxis: {
              type: "category",
              data: points.map((p) => p.date),
              boundaryGap: true,
              axisLine: { show: false },
              axisTick: { show: false },
              axisLabel: {
                color: c.axis,
                hideOverlap: true,
                interval: Math.max(0, Math.ceil(points.length / 7) - 1),
                formatter: (date: string) => date.slice(5, 10),
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
                  `${t("开盘", "Open")}  ${number(p.open, 2)}    ${t("最高", "High")}  ${number(p.high, 2)}`,
                  `${t("收盘", "Close")}  ${number(p.close, 2)}    ${t("最低", "Low")}  ${number(p.low, 2)}`,
                ].join("\n");
              },
            },
            series: [
              {
                type: "candlestick",
                name: ticker,
                data: points.map((p) => [p.open!, p.close, p.low!, p.high!]),
                itemStyle: {
                  color: c.positive,
                  color0: c.negative,
                  borderColor: c.positive,
                  borderColor0: c.negative,
                },
                barMaxWidth: 12,
              },
            ],
          })}
        />
      )}
    </Panel>
  );
}
