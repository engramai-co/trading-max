"use client";
import { Checkbox, Group } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ResearchPriceSeries } from "@/lib/types";
import { EvidenceTable } from "./evidence-table";
import { Plot, Legend } from "./charts";
import { api, compact, number, inRange, numeric, type Range } from "./data";
import {
  Empty,
  Notice,
  Panel,
  Pending,
  QueryError,
  Segments,
  useCopy,
} from "./foundation";

export function PriceHistory({
  ticker,
  runId,
  technical = false,
}: {
  ticker: string;
  runId: string;
  technical?: boolean;
}) {
  const t = useCopy();
  const [range, setRange] = useState<Range>("3M");
  const [style, setStyle] = useState<"line" | "candles">("line");
  const [averages, setAverages] = useState(technical);
  const [trades, setTrades] = useState(true);
  const query = useQuery({
    queryKey: ["workspace-prices", runId, ticker],
    queryFn: () =>
      api<ResearchPriceSeries>(
        "/research/" + encodeURIComponent(ticker) + "/prices?limit=2000",
      ),
    staleTime: 300_000,
    retry: 1,
  });
  const points = inRange(query.data?.points ?? [], range);
  const markers = (query.data?.tradeMarkers ?? []).filter((m) =>
    points.some((p) => p.date.slice(0, 10) === m.date.slice(0, 10)),
  );
  const candlesAvailable = points.every(
    (p) => p.open != null && p.high != null && p.low != null,
  );
  const candle = style === "candles" && candlesAvailable;
  return (
    <Panel
      title={t("价格与交易足迹", "Price & your trading footprint")}
      description={
        query.data
          ? query.data.currency || t("币种未提供", "Currency unavailable")
          : undefined
      }
      help={t(
        "交易标记放在当日收盘价上；悬浮或轻点标记可查看实际成交价。原始 OHLC 与成交量记录可在图下展开。按住 Ctrl 滚轮可缩放。",
        "Trade markers sit at the session close. Hover or tap a marker for execution prices. Expand the table below for OHLC and volume records. Hold Ctrl while scrolling to zoom.",
      )}
      action={
        <Segments
          label={t("价格图类型", "Price chart style")}
          value={style}
          onChange={setStyle}
          options={[
            { value: "line", label: t("折线", "Line") },
            { value: "candles", label: t("K 线", "Candles") },
          ]}
        />
      }
    >
      <div className="mx-toolbar" style={{ marginBottom: 16 }}>
        <Segments
          value={range}
          onChange={setRange}
          label={t("价格历史区间", "Price history range")}
          options={["1M", "3M", "6M", "YTD", "1Y", "2Y", "ALL"].map((v) => ({
            value: v as Range,
            label: v === "ALL" ? t("全部", "All") : v,
          }))}
        />
        <Group gap="md">
          <Checkbox
            size="xs"
            label={t("均线", "Moving averages")}
            checked={averages}
            onChange={(e) => setAverages(e.currentTarget.checked)}
          />
          <Checkbox
            size="xs"
            label={t("我的交易", "My trades")}
            checked={trades}
            onChange={(e) => setTrades(e.currentTarget.checked)}
          />
        </Group>
      </div>
      {query.isPending ? (
        <Pending compact />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : !points.length ? (
        <Empty
          title={t("价格历史暂不可用", "Price history is unavailable")}
          description={t(
            "研究数据与价格历史独立更新，其他研究视图仍可使用。",
            "Prices update separately from research. Other research views remain available.",
          )}
        />
      ) : (
        <>
          <Plot
            label={
              ticker +
              " · " +
              t("价格、成交量与交易记录", "Price, volume and trade markers")
            }
            height={360}
            research
            option={(c) => ({
              grid: [
                { top: 16, left: 60, right: 18, height: "68%" },
                { top: "79%", left: 60, right: 18, height: "12%" },
              ],
              axisPointer: { link: [{ xAxisIndex: "all" }] },
              tooltip: {
                formatter: (input) => {
                  const entry = (Array.isArray(input) ? input : [input])[0];
                  const point = points[entry?.dataIndex];
                  if (!point) return "";
                  return [
                    point.date.slice(0, 10) +
                      (query.data?.currency ? " · " + query.data.currency : ""),
                    t("收盘", "Close") + "  " + number(point.close, 2),
                    ...(candle
                      ? [
                          [t("开盘", "Open"), point.open],
                          [t("最高", "High"), point.high],
                          [t("最低", "Low"), point.low],
                        ].map(
                          ([label, value]) => label + "  " + number(value, 2),
                        )
                      : []),
                    ...(averages
                      ? (["sma20", "sma50", "sma200"] as const)
                          .filter((key) => numeric(point[key]) != null)
                          .map(
                            (key) =>
                              key.toUpperCase() + "  " + number(point[key], 2),
                          )
                      : []),
                    t("成交量", "Volume") + "  " + number(point.volume, 0),
                  ].join("\n");
                },
              },
              xAxis: [0, 1].map((i) => ({
                type: "category",
                gridIndex: i,
                data: points.map((p) => p.date.slice(0, 10)),
                boundaryGap: candle,
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: {
                  show: i === 1,
                  color: c.axis,
                  hideOverlap: true,
                  formatter: (v: string) => v.slice(5),
                },
              })),
              yAxis: [
                {
                  type: "value",
                  scale: true,
                  axisLabel: { color: c.axis },
                  splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
                },
                {
                  type: "value",
                  gridIndex: 1,
                  axisLabel: {
                    color: c.axis,
                    formatter: (v: number) => compact(v),
                  },
                  splitLine: { show: false },
                  splitNumber: 1,
                },
              ],
              dataZoom: [
                {
                  type: "inside",
                  xAxisIndex: [0, 1],
                  zoomOnMouseWheel: "ctrl",
                  moveOnMouseWheel: false,
                },
              ],
              series: [
                {
                  ...(candle
                    ? {
                        type: "candlestick" as const,
                        data: points.map((p) => [
                          p.open!,
                          p.close,
                          p.low!,
                          p.high!,
                        ]),
                        itemStyle: {
                          color: c.positive,
                          color0: c.negative,
                          borderColor: c.positive,
                          borderColor0: c.negative,
                        },
                      }
                    : {
                        type: "line" as const,
                        data: points.map((p) => p.close),
                        showSymbol: points.length === 1,
                        symbolSize: 6,
                        lineStyle: { color: c.brand, width: 2.2 },
                        itemStyle: { color: c.brand },
                        areaStyle: { color: c.brand, opacity: 0.06 },
                      }),
                  name: ticker,
                  markPoint: trades
                    ? {
                        tooltip: {
                          trigger: "item",
                          formatter: (input) => {
                            const entry = Array.isArray(input)
                              ? input[0]
                              : input;
                            const marker = markers[entry.dataIndex];
                            if (!marker) return "";
                            return [
                              marker.date.slice(0, 10),
                              ...(marker.buyAveragePrice != null
                                ? [
                                    t("买入均价", "Average buy price") +
                                      "  " +
                                      number(marker.buyAveragePrice, 2),
                                  ]
                                : []),
                              ...(marker.sellAveragePrice != null
                                ? [
                                    t("卖出均价", "Average sell price") +
                                      "  " +
                                      number(marker.sellAveragePrice, 2),
                                  ]
                                : []),
                            ].join("\n");
                          },
                        },
                        symbol: "pin",
                        symbolSize: 24,
                        label: {
                          color: c.canvas,
                          fontSize: 9,
                          formatter: (p) => String(p.name ?? ""),
                        },
                        data: markers.map((m) => ({
                          name: m.kind,
                          coord: [
                            m.date.slice(0, 10),
                            points.find(
                              (p) =>
                                p.date.slice(0, 10) === m.date.slice(0, 10),
                            )?.close ?? 0,
                          ],
                          itemStyle: {
                            color:
                              m.kind === "B"
                                ? c.positive
                                : m.kind === "S"
                                  ? c.negative
                                  : c.accent,
                          },
                          value:
                            "B " +
                            (m.buyAveragePrice ?? "—") +
                            " · S " +
                            (m.sellAveragePrice ?? "—"),
                        })),
                      }
                    : undefined,
                },
                ...(averages
                  ? (["sma20", "sma50", "sma200"] as const).map((key, i) => ({
                      type: "line" as const,
                      name: key.toUpperCase(),
                      data: points.map((p) => p[key]),
                      showSymbol: false,
                      connectNulls: false,
                      lineStyle: {
                        color:
                          i === 0 ? c.accent : i === 1 ? c.secondary : c.axis,
                        width: 1.2,
                        type: "dashed" as const,
                      },
                    }))
                  : []),
                {
                  type: "bar",
                  name: t("成交量", "Volume"),
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: points.map((p, i) => ({
                    value: p.volume,
                    itemStyle: {
                      color:
                        i > 0 && p.close < points[i - 1].close
                          ? c.negative
                          : c.brand,
                      opacity: 0.4,
                    },
                  })),
                  barMaxWidth: 12,
                },
              ],
            })}
          />
          <Legend
            items={[
              { label: ticker },
              ...(averages
                ? [
                    { label: "SMA 20" },
                    { label: "SMA 50", colour: "var(--mx-chart-2)" },
                    { label: "SMA 200", colour: "var(--mx-muted)" },
                  ]
                : []),
            ]}
          />
          <div className="mx-chart-footer">
            <span>
              {points[0].date.slice(0, 10)} → {points.at(-1)?.date.slice(0, 10)}{" "}
              · {points.length} {t("个交易日", "sessions")}
            </span>
          </div>
          <details className="mx-chart-data">
            <summary>
              {t("逐日价格与成交量", "Daily prices and volume")}
            </summary>
            <EvidenceTable
              key={range}
              label={t("历史行情", "Historical prices")}
              rows={[...points].reverse()}
              columns={[
                { label: t("日期", "Date"), value: (p) => p.date.slice(0, 10) },
                {
                  label: t("开盘", "Open"),
                  numeric: true,
                  value: (p) => number(p.open, 2),
                },
                {
                  label: t("最高", "High"),
                  numeric: true,
                  value: (p) => number(p.high, 2),
                },
                {
                  label: t("最低", "Low"),
                  numeric: true,
                  value: (p) => number(p.low, 2),
                },
                {
                  label: t("收盘", "Close"),
                  numeric: true,
                  value: (p) => number(p.close, 2),
                },
                {
                  label: t("成交量", "Volume"),
                  numeric: true,
                  value: (p) => number(p.volume, 0),
                },
              ]}
            />
          </details>
          {range === "ALL" && points.length >= 2000 && (
            <p className="mx-form-help">
              {t(
                "最多 2,000 个交易日",
                "Up to 2,000 available trading sessions",
              )}
            </p>
          )}
          {style === "candles" && !candlesAvailable && (
            <Notice>
              {t(
                "部分日期缺少开盘、最高或最低价，暂以收盘价折线展示。",
                "Some sessions lack complete OHLC data. Closing prices are shown as a line.",
              )}
            </Notice>
          )}
          {trades && (
            <p className="mx-form-help" style={{ marginTop: 12 }}>
              {markers.length
                ? t("B 买入 · S 卖出 · T 双向", "B buy · S sell · T two-way")
                : t(
                    "此区间没有匹配的账户交易记录。",
                    "No matching account trades in this period.",
                  )}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
