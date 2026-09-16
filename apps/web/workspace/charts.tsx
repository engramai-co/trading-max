"use client";

import { useReducedMotion } from "@mantine/hooks";
import type { EChartsOption, SeriesOption } from "echarts";
import { useMemo } from "react";
import { useLocale } from "@/components/locale-provider";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import { formatDate } from "@/ui/formatters";
import { compact, number, numeric, percent } from "./data";
import { EvidenceTable } from "./evidence-table";
import { Empty, useCopy } from "./foundation";
import { historySeries } from "./history-series";
import { historyDay, type CalendarTimeline } from "./portfolio-history";
import { timelineAxis } from "./timeline-axis";

export function Plot({
  label,
  option,
  height = 300,
  research = false,
}: {
  label: string;
  option: (colours: ChartColours) => EChartsOption;
  height?: number;
  research?: boolean;
}) {
  const colours = useChartColours();
  const reduced = useReducedMotion();
  const settings = useMemo<EChartsOption>(() => {
    const custom = option(colours);
    return {
      backgroundColor: "transparent",
      textStyle: { fontFamily: "inherit", color: colours.text, fontSize: 11 },
      color: [
        colours.brand,
        colours.accent,
        colours.secondary,
        colours.negative,
      ],
      grid: { top: 20, right: 18, bottom: 30, left: 58 },
      ...custom,
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        backgroundColor: colours.tooltip,
        textStyle: { color: colours.tooltipText, fontSize: 12 },
        borderWidth: 1,
        borderColor: colours.tooltipBorder,
        shadowBlur: 16,
        shadowColor: colours.tooltipShadow,
        shadowOffsetY: 4,
        padding: 12,
        confine: true,
        axisPointer: {
          type: "line",
          lineStyle: { color: colours.axis, type: "dashed" },
        },
        ...(custom.tooltip && !Array.isArray(custom.tooltip)
          ? custom.tooltip
          : {}),
      },

      animation: !reduced,
      animationDuration: 350,
      animationDurationUpdate: 180,
    };
  }, [colours, option, reduced]);
  const ref = useECharts(settings, research ? "research" : "core");
  return (
    <div className="mx-plot" style={{ height }}>
      <div
        role="img"
        aria-label={label}
        ref={ref}
        style={{ height: "100%", width: "100%" }}
      />
    </div>
  );
}

export type ChartLine = {
  name: string;
  values: Array<number | null>;
  colour?: "brand" | "accent" | "secondary" | "negative";
  dashed?: boolean;
  area?: boolean;
  type?: "line" | "bar";
};
export function HistoryChart({
  dates,
  lines,
  label,
  percentage = false,
  height = 300,
  intraday = false,
  timeline,
  emptyDescription,
  notes,
}: {
  dates: string[];
  lines: ChartLine[];
  label: string;
  percentage?: boolean;
  height?: number;
  intraday?: boolean;
  timeline?: CalendarTimeline;
  emptyDescription?: string;
  notes?: string[];
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (
    !dates.length ||
    (timeline && !timeline.rowIndexes.some((row) => row != null)) ||
    !lines.some((line) => line.values.some((v) => v != null))
  )
    return (
      <Empty
        title={t("还没有可展示的观测记录", "No observations to chart yet")}
        description={emptyDescription ?? t(
          "完成数据更新后，曲线将在这里出现。",
          "Your chart will appear after data has been collected.",
        )}
      />
    );
  const categories = timeline?.categories ?? dates;
  const multipleDays = intraday && historyDay(categories[0]) !== historyDay(categories.at(-1)!);
  const formatAxisDate = (date: string | number) => formatDate(
    date, locale, intraday && !multipleDays
      ? { hour: "2-digit", minute: "2-digit", timeZone }
      : { day: "numeric", month: "short", timeZone: intraday ? timeZone : "UTC" },
  );
  const horizontalAxis = timeline ? timelineAxis(timeline, formatAxisDate) : {
    type: "time" as const,
    minInterval: intraday ? 60000 : 86400000,
    boundaryGap: [0, 0] as [number, number],
    axisLabel: { formatter: formatAxisDate },
  };
  return (
    <>
      <Plot
        label={label}
        height={height}
        option={(c) => ({
          xAxis: {
            ...horizontalAxis,
            axisTick: { show: false },
            axisLine: { show: false },
            axisLabel: {
              ...horizontalAxis.axisLabel,
              hideOverlap: true,
              color: c.axis,
              margin: 16,
            },
          },
          yAxis: {
            type: "value",
            scale: true,
            axisLabel: {
              color: c.axis,
              formatter: (v: number) =>
                percentage
                  ? percent(v, false, 2)
                  : Math.abs(v) < 10000
                    ? number(v, 2)
                    : compact(v),
            },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          tooltip: {
            trigger: "axis",
            renderMode: "richText",
            confine: true,
            formatter: (input) => {
              const entries = Array.isArray(input) ? input : [input];
              const rows = entries.filter((entry) => Array.isArray(entry.value) && entry.value.at(-1) != null);
              if (!rows.length) return "";
              const value = rows[0].value as [number, number];
              const row = timeline?.rowIndexes[value[0]];
              const timestamp = timeline ? row == null ? null : dates[row] : value[0];
              if (timestamp == null) return "";
              const date = formatDate(timestamp, locale, intraday
                ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }
                : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
              return [date, ...rows.map((entry) => {
                const amount = (entry.value as [number, number])[1];
                return `${entry.seriesName}: ${percentage ? percent(amount, true, 2) : number(amount, 2)}`;
              })].join("\n");
            },
            valueFormatter: (input) => {
              const value = Array.isArray(input) ? input.at(-1) : input;
              return numeric(value) == null
                ? "—"
                : percentage
                  ? percent(value, true, 2)
                  : Number(value).toLocaleString("en-GB", {
                      maximumFractionDigits: 2,
                    });
            },
          },
          series: lines.map((line, i) => {
            const colour =
              c[
                line.colour ??
                  (i === 0 ? "brand" : i === 1 ? "accent" : "secondary")
              ];
            return {
              type: line.type ?? "line",
              name: line.name,
              data: historySeries(dates, line.values, intraday, timeline),
              showSymbol: true,
              symbolSize: 7,
              connectNulls: false,
              smooth: false,
              lineStyle: {
                width: line.dashed ? 1.5 : 2.5,
                color: colour,
                type: line.dashed ? "dashed" : "solid",
              },
              itemStyle: { color: colour },
              areaStyle: line.area
                ? { opacity: 0.08, color: colour }
                : undefined,
              emphasis: { focus: "series" },
              barMaxWidth: 24,
            } satisfies SeriesOption;
          }),
        })}
      />
      <details className="mx-chart-data">
        <summary>{t("查看精确数据", "View exact values")}</summary>
        <EvidenceTable
          label={label}
          rows={dates.map((date, index) => ({ date, index }))}
          columns={[
            { label: t("日期", "Date"), value: (row) => row.date },
            ...(notes ? [{ label: t("来源与精度", "Source & precision"), value: (row: { index: number }) => notes[row.index] }] : []),
            ...lines.map((line) => ({
              label: line.name,
              numeric: true,
              value: (row: { index: number }) =>
                percentage
                  ? percent(line.values[row.index], false, 2)
                  : number(line.values[row.index], 2),
            })),
          ]}
        />
      </details>
    </>
  );
}

export function Legend({
  items,
}: {
  items: Array<{ label: string; colour?: string }>;
}) {
  return (
    <div className="mx-chart-legend">
      {items.map((item, i) => (
        <span key={item.label}>
          <i
            style={{ background: item.colour ?? "var(--mx-chart-" + i + ")" }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function Bars({
  labels,
  values,
  label,
  percentage = false,
  height,
}: {
  labels: string[];
  values: Array<number | null>;
  label: string;
  percentage?: boolean;
  height?: number;
}) {
  const t = useCopy();
  if (!labels.length || values.every((v) => v == null))
    return (
      <Empty title={t("暂时没有这项数据", "This data is not available yet")} />
    );
  return (
    <Plot
      label={label}
      height={height ?? Math.max(190, labels.length * 38 + 36)}
      option={(c) => ({
        grid: { top: 10, bottom: 20, left: 112, right: 70 },
        xAxis: {
          type: "value",
          splitNumber: 3,
          axisLabel: {
            color: c.axis,
            hideOverlap: true,
            formatter: (v: number) =>
              percentage
                ? percent(v, false, 0)
                : Math.abs(v) < 10000
                  ? number(v, 2)
                  : compact(v),
          },
          splitLine: { lineStyle: { color: c.grid } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: labels,
          axisLabel: { color: c.text, width: 102, overflow: "truncate" },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "bar",
            name: label,
            barMaxWidth: 12,
            data: values.map((v) => ({
              value: v,
              itemStyle: {
                color: (v ?? 0) < 0 ? c.negative : c.brand,
                borderRadius: 3,
              },
            })),
            label: {
              show: true,
              position: "right",
              color: c.text,
              formatter: (p) =>
                numeric(p.value) == null
                  ? "—"
                  : percentage
                    ? percent(p.value)
                    : compact(p.value),
            },
          },
        ],
      })}
    />
  );
}
