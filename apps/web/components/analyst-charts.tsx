"use client";

import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
} from "echarts";
import { useMemo } from "react";

import { useLocale } from "@/components/locale-provider";
import type { PriceSeriesPoint } from "@/lib/types";
import { ChartShell } from "@/ui/charts/chart-shell";
import { useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

function moneyFormatter(currency: string, digits = 0) {
  return (value: number) => new Intl.NumberFormat("en-GB", {
    currency,
    maximumFractionDigits: digits,
    style: "currency",
  }).format(value);
}

function monthLabel(value: string, locale: "zh" | "en") {
  const parsed = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    month: "short",
    timeZone: "UTC",
    year: "2-digit",
  }).format(parsed);
}

function shiftMonth(value: string, months: number) {
  const parsed = new Date(`${value}-01T00:00:00Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return parsed.toISOString().slice(0, 7);
}

function fullMonthLabel(value: string, locale: "zh" | "en") {
  const parsed = new Date(`${value}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(parsed);
}

function targetChange(value: number, spot: number | null) {
  if (spot == null || spot === 0) return "—";
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
    style: "percent",
  }).format((value - spot) / spot);
}

export function PriceTargetChart({
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
    const monthly = new Map<string, PriceSeriesPoint>();
    history.forEach((point) => point.date && monthly.set(point.date.slice(0, 7), point));
    const past = Array.from(monthly.values()).slice(-13);
    if (!past.length) return null;
    const money = moneyFormatter(currency);
    const pastCategories = past.map((point) => point.date.slice(0, 7));
    const currentCategory = pastCategories.at(-1) ?? "";
    const futureCategories = Array.from({ length: 12 }, (_, index) => shiftMonth(currentCategory, index + 1));
    const categories = [...pastCategories, ...futureCategories];
    const forecastCategory = futureCategories.at(-1) ?? currentCategory;
    const forecastTooltipHeading = locale === "zh"
      ? `约 12 个月目标 · ${fullMonthLabel(forecastCategory, locale)}参考落点`
      : `Approx. 12-month target · ${fullMonthLabel(forecastCategory, locale)} reference point`;
    const historyData = past.map((point, index) => {
      const value = index === past.length - 1 && spot != null ? spot : point.close;
      const tooltipLabel = index === past.length - 1
        ? (locale === "zh" ? "最新价格" : "Latest price")
        : (locale === "zh" ? "月末价格" : "Month-end price");
      return {
        name: fullMonthLabel(pastCategories[index], locale),
        tooltip: { formatter: `<b>${fullMonthLabel(pastCategories[index], locale)}</b><br/>${tooltipLabel}: ${money(value)}` },
        value,
      };
    });
    const targetSeries = (
      value: number | null,
      label: string,
      color: string,
    ) => ({
      clip: false,
      connectNulls: true,
      data: value == null ? [] : [
        ...Array.from({ length: past.length - 1 }, () => null),
        { symbolSize: 0, tooltip: { show: false }, value: spot },
        ...Array.from({ length: futureCategories.length - 1 }, () => null),
        {
          symbolSize: 10,
          tooltip: {
            formatter: `<b>${forecastTooltipHeading}</b><br/>${label}: ${money(value)} (${targetChange(value, spot)})`,
          },
          value,
        },
      ],
      name: label,
      itemStyle: { borderColor: chartColours.canvas, borderWidth: 2, color },
      lineStyle: { color, type: "dashed" as const, width: 2 },
      showSymbol: true,
      symbol: "circle" as const,
      type: "line" as const,
      z: 2,
    });
    const targetCalloutSeries = (
      value: number | null,
      label: string,
      color: string,
      verticalOffset: number,
    ) => value == null ? null : ({
      clip: false,
      coordinateSystem: "cartesian2d" as const,
      data: [{
        name: label,
        tooltip: {
          formatter: `<b>${forecastTooltipHeading}</b><br/>${label}: ${money(value)} (${targetChange(value, spot)})`,
        },
        value: [categories.length - 1, value],
      }],
      renderItem: (
        _params: CustomSeriesRenderItemParams,
        api: CustomSeriesRenderItemAPI,
      ): CustomSeriesRenderItemReturn => {
        const point = api.coord([Number(api.value(0)), Number(api.value(1))]);
        if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
        const boxHeight = 50;
        const boxWidth = 82;
        const boxX = point[0] + 18;
        const boxY = point[1] - boxHeight / 2 + verticalOffset;
        const tailCenterY = Math.max(boxY + 12, Math.min(boxY + boxHeight - 12, point[1]));
        return {
          children: [
            {
              shape: {
                points: [
                  [point[0] + 6, point[1]],
                  [boxX, tailCenterY - 8],
                  [boxX, tailCenterY + 8],
                ],
              },
              style: { fill: chartColours.canvas, stroke: chartColours.border },
              type: "polygon" as const,
            },
            {
              shape: { height: boxHeight, r: 6, width: boxWidth, x: boxX, y: boxY },
              style: { fill: chartColours.canvas, lineWidth: 1, stroke: chartColours.border },
              type: "rect" as const,
            },
            {
              style: {
                fill: color,
                font: "700 12px sans-serif",
                lineHeight: 17,
                text: `${label}\n${money(value)}`,
                align: "left",
                verticalAlign: "top",
                x: boxX + 10,
                y: boxY + 8,
              },
              type: "text" as const,
            },
            {
              shape: { cx: point[0], cy: point[1], r: 5 },
              style: { fill: color, lineWidth: 2, stroke: chartColours.canvas },
              type: "circle" as const,
            },
          ],
          type: "group" as const,
        };
      },
      tooltip: { show: true },
      type: "custom" as const,
      z: 8,
    });
    const targetCallouts = [
      targetCalloutSeries(low, locale === "zh" ? "低位" : "Low", chartColours.negative, 8),
      targetCalloutSeries(mean, locale === "zh" ? "均值" : "Mean", chartColours.text, 0),
      targetCalloutSeries(high, locale === "zh" ? "高位" : "High", chartColours.positive, -8),
    ].filter((series) => series !== null);
    return {
      animation: false,
      graphic: [
        {
          left: "25%",
          style: { fill: chartColours.text, font: "700 14px sans-serif", text: locale === "zh" ? "过去 12 个月" : "Past 12 months" },
          top: 2,
          type: "text",
        },
        {
          left: "68%",
          style: { fill: chartColours.text, font: "700 14px sans-serif", text: locale === "zh" ? "未来 12 个月" : "12-month forecast" },
          top: 2,
          type: "text",
        },
      ],
      grid: { bottom: 12, containLabel: true, left: 8, right: 112, top: 34 },
      series: [
        {
          data: [...historyData, ...Array.from({ length: futureCategories.length }, () => null)],
          emphasis: { focus: "series" },
          itemStyle: { borderColor: chartColours.canvas, borderWidth: 2, color: chartColours.brand },
          lineStyle: { color: chartColours.brand, width: 2.5 },
          markLine: {
            data: [{ xAxis: currentCategory }],
            label: { show: false },
            lineStyle: { color: chartColours.border, type: "solid", width: 1 },
            silent: true,
            symbol: "none",
          },
          name: locale === "zh" ? "历史价格" : "Historical price",
          showSymbol: true,
          smooth: false,
          symbol: "circle",
          symbolSize: 8,
          type: "line",
          z: 3,
        },
        targetSeries(low, locale === "zh" ? "低位" : "Low", chartColours.negative),
        targetSeries(mean, locale === "zh" ? "均值" : "Mean", chartColours.text),
        targetSeries(high, locale === "zh" ? "高位" : "High", chartColours.positive),
        ...targetCallouts,
      ],
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderWidth: 0,
        textStyle: { color: chartColours.canvas },
        trigger: "item",
      },
      xAxis: {
        axisLabel: {
          color: chartColours.axis,
          formatter: (value: string, index: number) => (
            index === 0
            || index === 4
            || index === 8
            || index === pastCategories.length - 1
            || index === categories.length - 1
              ? monthLabel(value, locale)
              : ""
          ),
          hideOverlap: true,
        },
        axisLine: { lineStyle: { color: chartColours.border } },
        axisTick: { show: false },
        boundaryGap: false,
        data: categories,
        type: "category",
      },
      yAxis: {
        axisLabel: { color: chartColours.axis, formatter: money },
        scale: true,
        splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } },
        type: "value",
      },
    };
  }, [chartColours, currency, high, history, locale, low, mean, spot]);
  const chartRef = useECharts(option, "research");
  return (
    <ChartShell
      ariaLabel={locale === "zh" ? "过去十二个月历史价格与当前分析师目标价" : "Historical prices over the past twelve months and current analyst targets"}
      embedded
      empty={!option}
      height={390}
    >
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

export function ConsensusGaugeChart({
  breakdown,
  count,
  label,
  score,
}: {
  breakdown?: RatingPeriod;
  count: number;
  label: string;
  score: number | null;
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const option = useMemo<EChartsOption | null>(() => {
    if (score == null) return null;
    const segments = [
      [locale === "zh" ? "强烈卖出" : "Strong sell", breakdown?.strongSell ?? 0, chartColours.negative],
      [locale === "zh" ? "卖出" : "Sell", breakdown?.sell ?? 0, chartColours.accent],
      [locale === "zh" ? "持有" : "Hold", breakdown?.hold ?? 0, chartColours.warning],
      [locale === "zh" ? "买入" : "Buy", breakdown?.buy ?? 0, chartColours.secondary],
      [locale === "zh" ? "强烈买入" : "Strong buy", breakdown?.strongBuy ?? 0, chartColours.positive],
    ] as const;
    return {
      animation: false,
      series: [
        {
          avoidLabelOverlap: false,
          center: ["50%", "70%"],
          clockwise: true,
          data: [
            ...segments.map(([name, ratingCount, color]) => ({
              emphasis: { scale: true, scaleSize: 4 },
              itemStyle: { borderColor: chartColours.canvas, borderWidth: 2, color },
              name,
              tooltip: {
                formatter: `<b>${name}</b><br/><span style="background:${color};border-radius:2px;display:inline-block;height:10px;margin-right:7px;width:10px"></span>${locale === "zh" ? "评级数量" : "Ratings"}: <b>${ratingCount}</b>`,
              },
              value: 1,
            })),
            {
              emphasis: { disabled: true },
              itemStyle: { color: "transparent" },
              name: "",
              tooltip: { show: false },
              value: 5,
            },
          ],
          label: { show: false },
          radius: ["66%", "88%"],
          startAngle: 180,
          type: "pie",
        },
        {
          anchor: {
            itemStyle: { borderColor: chartColours.canvas, borderWidth: 3, color: chartColours.text },
            show: true,
            size: 14,
          },
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          center: ["50%", "70%"],
          data: [{ value: score }],
          detail: { show: false },
          endAngle: 0,
          max: 5,
          min: 1,
          pointer: { itemStyle: { color: chartColours.text }, length: "58%", width: 5 },
          radius: "88%",
          splitLine: { show: false },
          startAngle: 180,
          title: { show: false },
          tooltip: { show: false },
          type: "gauge",
          z: 3,
        },
      ],
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderWidth: 0,
        textStyle: { color: chartColours.canvas },
        trigger: "item",
      },
    };
  }, [breakdown, chartColours, locale, score]);
  const chartRef = useECharts(option, "research");
  return (
    <ChartShell
      ariaLabel={locale === "zh" ? `${label}，基于 ${count} 项评级` : `${label}, based on ${count} ratings`}
      embedded
      empty={!option}
      height={260}
    >
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}

export function RatingTrendChart({ rows }: { rows: RatingPeriod[] }) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const buckets = [
      ["strongSell", locale === "zh" ? "强烈卖出" : "Strong sell", chartColours.negative],
      ["sell", locale === "zh" ? "卖出" : "Sell", chartColours.accent],
      ["hold", locale === "zh" ? "持有" : "Hold", chartColours.warning],
      ["buy", locale === "zh" ? "买入" : "Buy", chartColours.secondary],
      ["strongBuy", locale === "zh" ? "强烈买入" : "Strong buy", chartColours.positive],
    ] as const;
    return {
      animation: false,
      grid: { bottom: 14, containLabel: true, left: 8, right: 8, top: 50 },
      legend: { icon: "roundRect", itemHeight: 9, itemWidth: 18, textStyle: { color: chartColours.axis }, top: 0 },
      series: buckets.map(([key, label, color]) => ({
        barMaxWidth: 44,
        data: rows.map((row) => row[key]),
        emphasis: { focus: "series" },
        itemStyle: { color },
        name: label,
        stack: "ratings",
        type: "bar" as const,
      })),
      tooltip: { backgroundColor: chartColours.tooltip, borderWidth: 0, textStyle: { color: chartColours.canvas }, trigger: "axis" },
      xAxis: {
        axisLabel: { color: chartColours.axis, hideOverlap: true },
        axisLine: { lineStyle: { color: chartColours.border } },
        axisTick: { show: false },
        data: rows.map((row) => row.period),
        type: "category",
      },
      yAxis: {
        axisLabel: { color: chartColours.axis },
        minInterval: 1,
        splitLine: { lineStyle: { color: chartColours.grid } },
        type: "value",
      },
    };
  }, [chartColours, locale, rows]);
  const chartRef = useECharts(option);
  return (
    <ChartShell ariaLabel={locale === "zh" ? "分析师评级数量趋势" : "Analyst rating-count trend"} embedded empty={!rows.length} height={300}>
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}

export type EstimateBar = {
  label: string;
  value: number | null;
  low: number | null;
  high: number | null;
};

export function EstimateChart({
  ariaLabel,
  compactValue,
  rows,
}: {
  ariaLabel: string;
  compactValue: (value: number) => string;
  rows: EstimateBar[];
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const available = useMemo(() => rows.filter((row) => row.value != null), [rows]);
  const option = useMemo<EChartsOption | null>(() => available.length ? ({
    animation: false,
    grid: { bottom: 18, containLabel: true, left: 8, right: 8, top: 26 },
    series: [
      {
        barMaxWidth: 54,
        data: available.map((row, index) => ({
          itemStyle: {
            borderRadius: [6, 6, 0, 0],
            color: index === 0 ? chartColours.brandDark : chartColours.brand,
          },
          value: row.value,
        })),
        name: locale === "zh" ? "均值" : "Mean",
        type: "bar",
      },
      {
        data: available.flatMap((row, index) => (
          row.low == null || row.high == null ? [] : [[index, row.low, row.high]]
        )),
        encode: { x: 0, y: [1, 2] },
        renderItem: (
          _params: CustomSeriesRenderItemParams,
          api: CustomSeriesRenderItemAPI,
        ) => {
          const category = Number(api.value(0));
          const low = Number(api.value(1));
          const high = Number(api.value(2));
          if (!Number.isFinite(category) || !Number.isFinite(low) || !Number.isFinite(high)) return null;
          const lowPoint = api.coord([category, low]);
          const highPoint = api.coord([category, high]);
          const capHalfWidth = 13;
          const lineStyle = { lineWidth: 1.6, stroke: chartColours.text };
          return {
            children: [
              { shape: { x1: lowPoint[0], x2: highPoint[0], y1: lowPoint[1], y2: highPoint[1] }, style: lineStyle, type: "line" },
              { shape: { x1: lowPoint[0] - capHalfWidth, x2: lowPoint[0] + capHalfWidth, y1: lowPoint[1], y2: lowPoint[1] }, style: lineStyle, type: "line" },
              { shape: { x1: highPoint[0] - capHalfWidth, x2: highPoint[0] + capHalfWidth, y1: highPoint[1], y2: highPoint[1] }, style: lineStyle, type: "line" },
            ],
            type: "group",
          };
        },
        silent: true,
        tooltip: { show: false },
        type: "custom",
        z: 4,
      },
    ],
    tooltip: {
      backgroundColor: chartColours.tooltip,
      borderWidth: 0,
      textStyle: { color: chartColours.canvas },
      trigger: "axis",
      valueFormatter: (value) => typeof value === "number" ? compactValue(value) : "—",
    },
    xAxis: {
      axisLabel: {
        color: chartColours.axis,
        formatter: (value: string, index: number) => `{period|${value}}\n{value|${compactValue(available[index]?.value ?? 0)}}`,
        hideOverlap: true,
        lineHeight: 19,
        rich: {
          period: { color: chartColours.axis },
          value: { color: chartColours.text, fontWeight: 700 },
        },
      },
      axisLine: { lineStyle: { color: chartColours.border } },
      axisTick: { show: false },
      data: available.map((row) => row.label),
      type: "category",
    },
    yAxis: {
      axisLabel: { color: chartColours.axis, formatter: compactValue },
      min: (value: { min: number }) => Math.min(0, value.min),
      scale: true,
      splitLine: { lineStyle: { color: chartColours.grid } },
      type: "value",
    },
  }) : null, [available, chartColours, compactValue, locale]);
  const chartRef = useECharts(option, "research");
  return (
    <ChartShell ariaLabel={ariaLabel} embedded empty={!option} height={320}>
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}
