"use client";

import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useLocale } from "@/components/locale-provider";
import { money } from "@/lib/format";
import type { ValuationRow } from "@/lib/types";
import { ChartShell } from "@/ui/charts/chart-shell";
import {
  categoricalChartColours,
  useChartColours,
} from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

export function ValuationPriceChart({
  valuation,
}: {
  valuation: ValuationRow;
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const entries = useMemo(
    () => [
      {
        label: locale === "zh" ? "现价" : "Spot",
        value: valuation.spot,
      },
      { label: "EV 5Y", value: valuation.ev5 },
      { label: "EV 10Y", value: valuation.ev10 },
      {
        label: locale === "zh" ? "分析师中位数" : "Analyst median",
        value: valuation.analystMedian,
      },
    ].filter(
      (item): item is { label: string; value: number } =>
        typeof item.value === "number",
    ),
    [locale, valuation],
  );
  const option = useMemo<EChartsOption | null>(() => {
    if (entries.length < 2) return null;
    return {
      animation: false,
      grid: { bottom: 8, containLabel: true, left: 8, right: 36, top: 8 },
      series: [{
        barMaxWidth: 44,
        data: entries.map((item, index) => ({
          itemStyle: {
            borderRadius: [0, 6, 6, 0],
            color: categoricalChartColours[
              index % categoricalChartColours.length
            ],
          },
          value: item.value,
        })),
        label: {
          color: chartColours.text,
          formatter: (params: unknown) =>
            money(
              Number((params as { value?: unknown }).value),
              valuation.currency,
              0,
            ),
          position: "right",
          show: true,
        },
        type: "bar",
      }],
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderWidth: 0,
        formatter: (params: unknown) => {
          const raw = params as
            | { dataIndex: number; value: number }
            | Array<{ dataIndex: number; value: number }>;
          const point = Array.isArray(raw) ? raw[0] : raw;
          const item = entries[point.dataIndex];
          return `${item.label}<br/>${money(
            point.value,
            valuation.currency,
            2,
          )}`;
        },
        textStyle: { color: chartColours.canvas },
        trigger: "item",
      },
      xAxis: {
        axisLabel: {
          color: chartColours.axis,
          formatter: (value: number) => money(value, valuation.currency, 0),
          hideOverlap: true,
        },
        splitLine: {
          lineStyle: { color: chartColours.grid, type: "dashed" },
        },
        type: "value",
      },
      yAxis: {
        axisLabel: { color: chartColours.axis, hideOverlap: true },
        axisLine: { show: false },
        axisTick: { show: false },
        data: entries.map((item) => item.label),
        type: "category",
      },
    };
  }, [chartColours, entries, valuation.currency]);
  const chartRef = useECharts(option);

  return (
    <ChartShell
      ariaLabel={locale === "zh" ? "现价与估值参考" : "Price and valuation references"}
      description={locale === "zh"
        ? "现价和估值参考使用同一货币、同一刻度。"
        : "Spot and valuation references use the same currency and scale."}
      empty={!option}
      emptyMessage={locale === "zh" ? "暂无估值参考" : "No valuation references"}
      height={340}
      title={locale === "zh" ? "现价与估值参考" : "Price and valuation references"}
    >
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}

export function ValuationSensitivityChart({
  valuation,
}: {
  valuation: ValuationRow;
}) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const sensitivity = valuation.sensitivity;
  const rows = useMemo(() => {
    if (!sensitivity) return [];
    return [
      {
        axis: sensitivity.discountRate,
        label: locale === "zh" ? "折现率" : "Discount rate",
      },
      {
        axis: sensitivity.revenueGrowth,
        label: locale === "zh" ? "营收增长" : "Revenue growth",
      },
      {
        axis: sensitivity.fcfMargin,
        label: "FCF margin",
      },
    ];
  }, [locale, sensitivity]);
  const values = rows.flatMap((row, rowIndex) =>
    row.axis.values.map((value, columnIndex) => [
      columnIndex,
      rowIndex,
      value,
    ]),
  );
  const maxColumns = Math.max(...rows.map((row) => row.axis.values.length), 0);
  const columnLabels = useMemo(() => {
    if (maxColumns === 5) {
      return [
        locale === "zh" ? "更低" : "Lower",
        locale === "zh" ? "较低" : "Low",
        locale === "zh" ? "基准" : "Base",
        locale === "zh" ? "较高" : "High",
        locale === "zh" ? "更高" : "Higher",
      ];
    }
    return Array.from(
      { length: maxColumns },
      (_, index) => `${locale === "zh" ? "情景" : "Case"} ${index + 1}`,
    );
  }, [locale, maxColumns]);
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length || !values.length) return null;
    const allValues = values.map((item) => Number(item[2]));
    return {
      animation: false,
      grid: { bottom: 46, containLabel: true, left: 8, right: 18, top: 14 },
      series: [{
        data: values,
        label: {
          color: chartColours.heatmapText,
          formatter: (params: unknown) => {
            const value = (params as { value: [number, number, number] }).value;
            return money(value[2], valuation.currency, 0);
          },
          show: true,
        },
        type: "heatmap",
      }],
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderWidth: 0,
        formatter: (params: unknown) => {
          const { value } = params as {
            value: [number, number, number];
          };
          const row = rows[value[1]];
          const delta = row.axis.deltas[value[0]];
          return `${row.label} ${new Intl.NumberFormat(
            locale === "zh" ? "zh-CN" : "en-GB",
            {
              signDisplay: "exceptZero",
              style: "percent",
            },
          ).format(delta)}<br/>${money(
            value[2],
            valuation.currency,
            2,
          )}`;
        },
        textStyle: { color: chartColours.canvas },
      },
      visualMap: {
        bottom: 0,
        calculable: false,
        inRange: {
          color: [
            chartColours.heatmapLow,
            chartColours.heatmapMid,
            chartColours.heatmapHigh,
          ],
        },
        max: Math.max(...allValues),
        min: Math.min(...allValues),
        orient: "horizontal",
        show: false,
      },
      xAxis: {
        axisLabel: {
          color: chartColours.axis,
          hideOverlap: true,
        },
        data: columnLabels,
        splitArea: { show: true },
        type: "category",
      },
      yAxis: {
        axisLabel: { color: chartColours.axis, hideOverlap: true },
        data: rows.map((row) => row.label),
        splitArea: { show: true },
        type: "category",
      },
    };
  }, [
    chartColours,
    columnLabels,
    locale,
    rows,
    valuation.currency,
    values,
  ]);
  const chartRef = useECharts(option, "research");

  return (
    <ChartShell
      ariaLabel={locale === "zh" ? "DCF 敏感性" : "DCF sensitivity"}
      description={locale === "zh"
        ? "每一格只改变一个假设；0% 为基准情景。"
        : "Each cell changes one assumption only; 0% is the base case."}
      empty={!option}
      emptyMessage={locale === "zh" ? "暂无敏感性数据" : "No sensitivity data"}
      height={300}
      title={locale === "zh" ? "DCF 敏感性" : "DCF sensitivity"}
    >
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}
