"use client";

import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useLocale } from "@/components/locale-provider";
import type { PriceSeriesPoint } from "@/lib/types";
import { ChartShell } from "@/ui/charts/chart-shell";
import { categoricalChartColours, useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

export function TargetFanChart({
  currency,
  high,
  history,
  low,
  mean,
  spot,
}: {
  currency: string;
  high: number | null;
  history: PriceSeriesPoint[];
  low: number | null;
  mean: number | null;
  spot: number | null;
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const option = useMemo<EChartsOption | null>(() => {
    if (spot == null) return null;
    const monthly = new Map<string, PriceSeriesPoint>();
    history.forEach((point) => point.date && monthly.set(point.date.slice(0, 7), point));
    const past = Array.from(monthly.values()).slice(-13);
    const anchorDate = past.length
      ? new Date(`${past.at(-1)!.date.slice(0, 7)}-01T00:00:00Z`)
      : new Date();
    const future = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(anchorDate);
      date.setUTCMonth(date.getUTCMonth() + index + 1);
      return date.toISOString().slice(0, 7);
    });
    const dates = [...past.map((point) => point.date.slice(0, 7)), ...future];
    const anchor = Math.max(0, past.length - 1);
    const projection = (target: number | null) => {
      const line = new Array<number | null>(dates.length).fill(null);
      if (target == null) return line;
      line[anchor] = spot;
      future.forEach((_, index) => {
        line[anchor + index + 1] = spot + (target - spot) * ((index + 1) / future.length);
      });
      return line;
    };
    const money = (value: number) =>
      new Intl.NumberFormat("en-GB", { currency, maximumFractionDigits: 0, style: "currency" }).format(value);
    const targetSeries = (target: number | null, color: string, name: string) => ({
      data: projection(target),
      lineStyle: { color, type: "dashed" as const, width: 2 },
      name,
      showSymbol: false,
      type: "line" as const,
    });
    return {
      animation: false,
      grid: { bottom: 12, containLabel: true, left: 8, right: 16, top: 48 },
      legend: {
        icon: "roundRect",
        textStyle: { color: chartColours.axis },
        top: 0,
      },
      series: [
        {
          data: [...past.map((point) => point.close), ...new Array(future.length).fill(null)],
          itemStyle: { color: chartColours.brand },
          lineStyle: { color: chartColours.brand, width: 2 },
          name: locale === "zh" ? "历史价格" : "Price",
          showSymbol: true,
          symbolSize: 6,
          type: "line",
        },
        targetSeries(high, chartColours.positive, locale === "zh" ? "最高" : "High"),
        targetSeries(mean, chartColours.text, locale === "zh" ? "均值" : "Mean"),
        targetSeries(low, chartColours.negative, locale === "zh" ? "最低" : "Low"),
      ],
      tooltip: { backgroundColor: chartColours.tooltip, borderWidth: 0, textStyle: { color: chartColours.canvas }, trigger: "axis" },
      xAxis: {
        axisLabel: { color: chartColours.axis, hideOverlap: true },
        axisLine: { lineStyle: { color: chartColours.border } },
        axisTick: { show: false },
        boundaryGap: false,
        data: dates,
        type: "category",
      },
      yAxis: {
        axisLabel: { color: chartColours.axis, formatter: money },
        scale: true,
        splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } },
      },
    };
  }, [chartColours, currency, high, history, locale, low, mean, spot]);
  const chartRef = useECharts(option);
  return (
    <ChartShell ariaLabel={locale === "zh" ? "历史价格与目标价区间" : "Price history and target range"} empty={spot == null} height={390}>
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}

export type RatingPeriod = {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
};

export function RatingTrendChart({ rows }: { rows: RatingPeriod[] }) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const buckets = [
      ["strongBuy", locale === "zh" ? "强烈买入" : "Strong buy"],
      ["buy", locale === "zh" ? "买入" : "Buy"],
      ["hold", locale === "zh" ? "持有" : "Hold"],
      ["sell", locale === "zh" ? "卖出" : "Sell"],
      ["strongSell", locale === "zh" ? "强烈卖出" : "Strong sell"],
    ] as const;
    return {
      animation: false,
      grid: { bottom: 16, containLabel: true, left: 8, right: 8, top: 34 },
      legend: { icon: "roundRect", textStyle: { color: chartColours.axis }, top: 0 },
      series: buckets.map(([key, label], index) => ({
        data: rows.map((row) => row[key]),
        itemStyle: { color: categoricalChartColours[index] },
        name: label,
        stack: "ratings",
        type: "bar" as const,
      })),
      tooltip: { backgroundColor: chartColours.tooltip, borderWidth: 0, textStyle: { color: chartColours.canvas }, trigger: "axis" },
      xAxis: { axisLabel: { color: chartColours.axis, hideOverlap: true }, data: rows.map((row) => row.period), type: "category" },
      yAxis: { axisLabel: { color: chartColours.axis }, splitLine: { lineStyle: { color: chartColours.grid } }, type: "value" },
    };
  }, [chartColours, locale, rows]);
  const chartRef = useECharts(option);
  return (
    <ChartShell ariaLabel={locale === "zh" ? "分析师评级趋势" : "Analyst rating trend"} empty={!rows.length} height={330}>
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}

export type EstimateBar = { label: string; value: number | null; low: number | null; high: number | null };

export function EstimateChart({ compactValue, rows }: { compactValue: (value: number) => string; rows: EstimateBar[] }) {
  const chartColours = useChartColours();
  const option = useMemo<EChartsOption | null>(() => rows.length ? ({
    animation: false,
    grid: { bottom: 12, containLabel: true, left: 8, right: 8, top: 24 },
    series: [{
      barMaxWidth: 50,
      data: rows.map((row) => row.value),
      itemStyle: { color: chartColours.brand },
      label: { color: chartColours.text, formatter: ({ value }: { value?: unknown }) => typeof value === "number" ? compactValue(value) : "—", position: "top", show: true },
      type: "bar",
    }],
    tooltip: { backgroundColor: chartColours.tooltip, borderWidth: 0, textStyle: { color: chartColours.canvas }, trigger: "axis" },
    xAxis: { axisLabel: { color: chartColours.axis, hideOverlap: true, rotate: 18 }, data: rows.map((row) => row.label), type: "category" },
    yAxis: { axisLabel: { color: chartColours.axis, formatter: compactValue }, splitLine: { lineStyle: { color: chartColours.grid } }, type: "value" },
  }) : null, [chartColours, compactValue, rows]);
  const chartRef = useECharts(option);
  return (
    <ChartShell ariaLabel="Analyst estimates" empty={!rows.length} height={320}>
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}
