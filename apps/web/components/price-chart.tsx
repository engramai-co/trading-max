"use client";

import { Alert, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import type { EChartsOption } from "echarts";
import { useMemo, useState } from "react";

import { useLocale } from "@/components/locale-provider";
import type { PriceSeriesPoint } from "@/lib/types";
import { ChartShell } from "@/ui/charts/chart-shell";
import { useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

const RANGES = [
  { key: "1m", sessions: 21 },
  { key: "3m", sessions: 63 },
  { key: "6m", sessions: 126 },
  { key: "1y", sessions: 252 },
  { key: "2y", sessions: 504 },
  { key: "max", sessions: Number.POSITIVE_INFINITY },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];
type ChartMode = "candles" | "line";

export function PriceChart({
  compact = false,
  currency,
  defaultRange = "1y",
  points = [],
  showControls = true,
  ticker,
}: {
  compact?: boolean;
  currency: string;
  defaultRange?: RangeKey;
  points?: PriceSeriesPoint[];
  showControls?: boolean;
  ticker: string;
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const [range, setRange] = useState<RangeKey>(defaultRange);
  const [mode, setMode] = useState<ChartMode>("candles");
  const candles = mode === "candles";
  const visible = useMemo(() => {
    const sessions = RANGES.find((item) => item.key === range)?.sessions ?? 252;
    return Number.isFinite(sessions) ? points.slice(-sessions) : points;
  }, [points, range]);
  const summary = useMemo(() => {
    if (visible.length < 2) return null;
    const first = visible[0].close;
    const last = visible.at(-1)!.close;
    return first ? { change: (last - first) / Math.abs(first), last } : null;
  }, [visible]);
  const option = useMemo<EChartsOption | null>(() => {
    if (visible.length < 2) return null;
    const dates = visible.map((point) => point.date);
    const rising = visible.at(-1)!.close >= visible[0].close;
    const primary = rising ? chartColours.positive : chartColours.negative;
    return {
      animation: false,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: [
        { bottom: "25%", left: 12, right: 64, top: 18 },
        { bottom: 8, height: "14%", left: 12, right: 64 },
      ],
      series: [
        candles
          ? {
              data: visible.map((point) => [
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
              type: "candlestick",
            }
          : {
              areaStyle: { color: `${primary}22` },
              data: visible.map((point) => point.close),
              lineStyle: { color: primary, width: 2 },
              name: ticker,
              showSymbol: false,
              type: "line",
            },
        {
          data: visible.map((point) => point.sma50),
          lineStyle: { color: chartColours.accent, width: 1.3 },
          name: "SMA 50",
          showSymbol: false,
          type: "line",
        },
        {
          data: visible.map((point) => point.sma200),
          lineStyle: { color: chartColours.secondary, width: 1.3 },
          name: "SMA 200",
          showSymbol: false,
          type: "line",
        },
        {
          data: visible.map((point) => point.volume),
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
  }, [candles, chartColours, currency, locale, ticker, visible]);
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
              data={RANGES.map((item) => ({ label: item.key.toUpperCase(), value: item.key }))}
              onChange={(value) => setRange(value as RangeKey)}
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
        <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
      </ChartShell>
    </Stack>
  );
}
