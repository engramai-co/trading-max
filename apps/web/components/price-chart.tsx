"use client";

import { Alert, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import type { EChartsOption } from "echarts";
import { useMemo, useState } from "react";

import { useLocale } from "@/components/locale-provider";
import {
  PRICE_CHART_RANGES,
  priceChartRangePoints,
  priceChartWindow,
  type PriceChartRange,
} from "@/lib/price-chart";
import type { PriceSeriesPoint, ResearchTradeMarker } from "@/lib/types";
import { ChartShell } from "@/ui/charts/chart-shell";
import { useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

type ChartMode = "candles" | "line";

export function PriceChart({
  compact = false,
  currency,
  defaultRange = "1y",
  panHistory = false,
  points = [],
  showControls = true,
  ticker,
  tradeMarkers = [],
}: {
  compact?: boolean;
  currency: string;
  defaultRange?: PriceChartRange;
  panHistory?: boolean;
  points?: PriceSeriesPoint[];
  showControls?: boolean;
  ticker: string;
  tradeMarkers?: ResearchTradeMarker[];
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const [range, setRange] = useState<PriceChartRange>(defaultRange);
  const [mode, setMode] = useState<ChartMode>("candles");
  const candles = mode === "candles";
  const summaryPoints = useMemo(
    () => priceChartRangePoints(points, range),
    [points, range],
  );
  const chartPoints = panHistory ? points : summaryPoints;
  const chartWindow = useMemo(
    () => priceChartWindow(chartPoints, range),
    [chartPoints, range],
  );
  const summary = useMemo(() => {
    if (summaryPoints.length < 2) return null;
    const first = summaryPoints[0].close;
    const last = summaryPoints.at(-1)!.close;
    return first ? { change: (last - first) / Math.abs(first), last } : null;
  }, [summaryPoints]);
  const canPanHistory = Boolean(
    panHistory && chartWindow && chartWindow.startIndex > 0,
  );
  const option = useMemo<EChartsOption | null>(() => {
    if (chartPoints.length < 2 || !chartWindow) return null;
    const dates = chartPoints.map((point) => point.date);
    const pointsByDate = new Map(chartPoints.map((point) => [point.date, point]));
    const visibleMarkers = tradeMarkers.filter((marker) => pointsByDate.has(marker.date));
    const rising = summaryPoints.at(-1)!.close >= summaryPoints[0].close;
    const primary = rising ? chartColours.positive : chartColours.negative;
    return {
      animation: false,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      dataZoom: canPanHistory
        ? [{
            cursorGrab: "grab",
            cursorGrabbing: "grabbing",
            endValue: chartWindow.endValue,
            filterMode: "filter",
            moveOnMouseMove: true,
            moveOnMouseWheel: false,
            preventDefaultMouseMove: true,
            startValue: chartWindow.startValue,
            throttle: 32,
            type: "inside",
            xAxisIndex: [0, 1],
            zoomLock: true,
            zoomOnMouseWheel: false,
          }]
        : undefined,
      grid: [
        { bottom: "25%", left: 12, right: 64, top: 18 },
        { bottom: 8, height: "14%", left: 12, right: 64 },
      ],
      series: [
        candles
          ? {
              data: chartPoints.map((point) => [
                point.open ?? point.close,
                point.close,
                point.low ?? point.close,
                point.high ?? point.close,
              ]),
              itemStyle: {
                borderColor: chartColours.positive,
                borderColor0: chartColours.negative,
                color: chartColours.positive,
                color0: chartColours.negative,
              },
              name: ticker,
              markPoint: visibleMarkers.length
                ? {
                    data: visibleMarkers.map((marker) => {
                      const point = pointsByDate.get(marker.date)!;
                      const belowCandle = marker.kind === "B";
                      return {
                        coord: [
                          marker.date,
                          belowCandle ? point.low ?? point.close : point.high ?? point.close,
                        ],
                        itemStyle: {
                          color: marker.kind === "B"
                            ? chartColours.brand
                            : marker.kind === "S"
                            ? chartColours.negative
                            : chartColours.warning,
                        },
                        label: {
                          color: marker.kind === "T"
                            ? chartColours.tooltip
                            : chartColours.canvas,
                          fontSize: 11,
                          fontWeight: 800,
                          formatter: marker.kind,
                        },
                        marker,
                        name: marker.kind,
                        symbol: "roundRect",
                        symbolOffset: [0, belowCandle ? 14 : -14],
                        symbolSize: [22, 20],
                        value: marker.kind,
                      };
                    }),
                    tooltip: {
                      backgroundColor: chartColours.tooltip,
                      borderWidth: 0,
                      confine: true,
                      formatter: (params: unknown) => {
                        const marker = (
                          params as { data?: { marker?: ResearchTradeMarker } }
                        ).data?.marker;
                        if (!marker) return "";
                        const accountLabel = marker.accounts
                          .map((account) => account === "isa" ? "ISA" : "Invest")
                          .join(" + ");
                        const formatQuantity = (value: number) =>
                          new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-GB", {
                            maximumFractionDigits: 4,
                          }).format(value);
                        const formatPrice = (value: number | null) =>
                          value == null
                            ? "—"
                            : new Intl.NumberFormat("en-GB", {
                                currency,
                                maximumFractionDigits: 4,
                                style: "currency",
                              }).format(value);
                        const lines = [
                          `<strong>${marker.date} · ${marker.kind}</strong>`,
                        ];
                        if (marker.buyOrders) {
                          lines.push(
                            locale === "zh"
                              ? `买入 ${marker.buyOrders} 笔 · ${formatQuantity(marker.buyQuantity)} 股 · 均价 ${formatPrice(marker.buyAveragePrice)}`
                              : `Bought ${marker.buyOrders} · ${formatQuantity(marker.buyQuantity)} shares · avg ${formatPrice(marker.buyAveragePrice)}`,
                          );
                        }
                        if (marker.sellOrders) {
                          lines.push(
                            locale === "zh"
                              ? `卖出 ${marker.sellOrders} 笔 · ${formatQuantity(marker.sellQuantity)} 股 · 均价 ${formatPrice(marker.sellAveragePrice)}`
                              : `Sold ${marker.sellOrders} · ${formatQuantity(marker.sellQuantity)} shares · avg ${formatPrice(marker.sellAveragePrice)}`,
                          );
                        }
                        if (accountLabel) lines.push(accountLabel);
                        return lines.join("<br/>");
                      },
                      textStyle: { color: chartColours.canvas },
                      trigger: "item",
                    },
                  }
                : undefined,
              type: "candlestick",
            }
          : {
              areaStyle: { color: `${primary}22` },
              data: chartPoints.map((point) => point.close),
              lineStyle: { color: primary, width: 2 },
              name: ticker,
              showSymbol: false,
              type: "line",
            },
        {
          data: chartPoints.map((point) => point.sma50),
          lineStyle: { color: chartColours.accent, width: 1.3 },
          name: "SMA 50",
          showSymbol: false,
          type: "line",
        },
        {
          data: chartPoints.map((point) => point.sma200),
          lineStyle: { color: chartColours.secondary, width: 1.3 },
          name: "SMA 200",
          showSymbol: false,
          type: "line",
        },
        {
          data: chartPoints.map((point) => point.volume),
          itemStyle: { color: chartColours.border },
          name: locale === "zh" ? "成交量" : "Volume",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
        },
      ],
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderWidth: 0,
        textStyle: { color: chartColours.canvas },
        trigger: "axis",
      },
      xAxis: [
        {
          axisLabel: { color: chartColours.axis, hideOverlap: true },
          axisLine: { lineStyle: { color: chartColours.border } },
          axisTick: { show: false },
          boundaryGap: true,
          data: dates,
          type: "category",
        },
        {
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          data: dates,
          gridIndex: 1,
          type: "category",
        },
      ],
      yAxis: [
        {
          axisLabel: {
            color: chartColours.axis,
            formatter: (value: number) =>
              new Intl.NumberFormat("en-GB", {
                currency,
                maximumFractionDigits: 0,
                style: "currency",
              }).format(value),
          },
          position: "right",
          scale: true,
          splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } },
        },
        {
          axisLabel: { show: false },
          gridIndex: 1,
          scale: true,
          splitLine: { show: false },
        },
      ],
    };
  }, [
    candles,
    canPanHistory,
    chartPoints,
    chartColours,
    chartWindow,
    currency,
    locale,
    summaryPoints,
    ticker,
    tradeMarkers,
  ]);
  const chartRef = useECharts(option, "research");

  if (points.length < 2) {
    return (
      <Alert color="gray" title={locale === "zh" ? "暂无价格序列" : "No price series"}>
        {locale === "zh"
          ? "更新技术面数据后即可查看真实日线。这里不会显示合成价格。"
          : "Update technical data to view real daily prices. Synthetic prices are never shown here."}
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Text fw={800} size="xl">
            {summary
              ? new Intl.NumberFormat("en-GB", {
                  currency,
                  maximumFractionDigits: 2,
                  style: "currency",
                }).format(summary.last)
              : "—"}
          </Text>
          {summary ? (
            <Text c={summary.change >= 0 ? "green" : "red"} fw={700}>
              {new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-GB", {
                maximumFractionDigits: 1,
                signDisplay: "always",
                style: "percent",
              }).format(summary.change)}
            </Text>
          ) : null}
        </Group>
        {showControls ? (
          <Group gap="sm" wrap="wrap">
            <SegmentedControl
              aria-label={locale === "zh" ? "图表类型" : "Chart type"}
              data={[
                { label: locale === "zh" ? "K 线" : "Candles", value: "candles" },
                { label: locale === "zh" ? "折线" : "Line", value: "line" },
              ]}
              onChange={(value) => setMode(value as ChartMode)}
              size="xs"
              value={mode}
            />
            <SegmentedControl
              aria-label={locale === "zh" ? "价格区间" : "Price range"}
              data={PRICE_CHART_RANGES.map((item) => ({
                label: item.key.toUpperCase(),
                value: item.key,
              }))}
              onChange={(value) => setRange(value as PriceChartRange)}
              size="xs"
              value={range}
            />
          </Group>
        ) : (
          <Text c="dimmed" fw={700} size="xs">
            {locale === "zh" ? "近 1 个月 · K 线" : "1 month · Candles"}
          </Text>
        )}
      </Group>
      <ChartShell
        ariaLabel={`${ticker} ${locale === "zh" ? "价格与成交量图" : "price and volume chart"}`}
        height={compact ? 284 : 440}
      >
        <div
          ref={chartRef}
          style={{
            height: "100%",
            touchAction: canPanHistory ? "pan-y" : "auto",
            width: "100%",
          }}
        />
      </ChartShell>
    </Stack>
  );
}
