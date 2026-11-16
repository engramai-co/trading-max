"use client";

import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import type {
  SeriesOption,
} from "echarts";
import { compact, number, percent } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { EvidenceTable } from "./evidence-table";
import { Empty, useCopy } from "./foundation";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import { historyDay, type CalendarTimeline } from "@/lib/portfolio/history";
import { timelineAxis } from "./timeline-axis";
import { type ChartReadout } from "./chart-readout";
import { chartNumber } from "./research-chart-format";

import { Plot } from "./plot";
export { Plot } from "./plot";

export type ChartLine = {
  name: string;
  values: Array<number | null>;
  colour?: "brand" | "accent" | "secondary" | "negative" | "text" | "axis";
  dashed?: boolean;
  area?: boolean;
  type?: "line" | "bar";
  step?: "end";
  markers?: Array<{ date: string; name: string }>;
};
export function HistoryChart({
  dates,
  lines,
  label,
  percentage = false,
  currencyTick = false,
  height = 300,
  intraday = false,
  timeline,
  emptyDescription,
  notes,
  fullscreen = false,
}: {
  dates: string[];
  lines: ChartLine[];
  label: string;
  percentage?: boolean;
  currencyTick?: boolean;
  height?: number;
  intraday?: boolean;
  timeline?: CalendarTimeline;
  emptyDescription?: string;
  notes?: string[];
  fullscreen?: boolean;
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
        description={
          emptyDescription ??
          t(
            "完成数据更新后，曲线将在这里出现。",
            "Your chart will appear after data has been collected.",
          )
        }
      />
    );
  const categories = timeline?.categories ?? dates;
  const multipleDays =
    intraday && historyDay(categories[0]) !== historyDay(categories.at(-1)!);
  const axisZone = intraday ? timeZone : "UTC";
  const yearOf = (date: string | number) =>
    formatDate(date, locale, { year: "numeric", timeZone: axisZone });
  const latestYear = yearOf(categories.at(-1)!);
  // The year appears only on dates outside the latest year shown, so it marks
  // the boundary instead of repeating on every label.
  const formatAxisDate = (date: string | number) => {
    if (intraday && !multipleDays)
      return formatDate(date, locale, { hour: "2-digit", minute: "2-digit", timeZone });
    const day = formatDate(date, locale, { day: "numeric", month: "short", timeZone: axisZone });
    const year = yearOf(date);
    return year === latestYear ? day : day + "\n" + year;
  };
  const horizontalAxis = timeline
    ? timelineAxis(timeline, formatAxisDate)
    : {
        type: "time" as const,
        minInterval: intraday ? 60000 : 86400000,
        boundaryGap: [0, 0] as [number, number],
        axisLabel: { formatter: formatAxisDate },
      };
  const observations = new Map<number, number>();
  (timeline?.rowIndexes ?? dates.map((_, index) => index)).forEach((row, position) => {
    if (row != null && lines.some((line) => line.values[row] != null)) observations.set(timeline ? position : Date.parse(dates[row]), row);
  });
  const positions = [...observations.keys()];
  const latest = positions.at(-1)!;
  const formatValue = (value: number | null) => value == null ? "—"
    : percentage ? percent(value, true, 2) : currencyTick ? `${number(value, 2)} GBP` : number(value, 2);
  const readout: ChartReadout = {
    positions,
    latest: formatValue(lines[0].values[observations.get(latest)!]),
    records: fullscreen ? (position) => {
      const row = observations.get(position)!;
      return lines.flatMap((line) => line.values[row] == null ? [] : [{
        time: dates[row], zone: intraday ? timeZone : "UTC", currency: percentage ? "%" : currencyTick ? "GBP" : "",
        basis: percentage ? "fractional return" : "level", source: notes?.[row] ?? label, series: line.name, value: line.values[row]!,
      }]);
    } : undefined,
    point: (position) => {
      const row = observations.get(position)!;
      return [
        formatDate(dates[row], locale, {
          year: "numeric", month: "short", day: "numeric",
          ...(intraday ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone } : { timeZone: "UTC" }),
        }),
        ...lines.map((line) => `${line.name}: ${formatValue(line.values[row])}`),
        ...new Set(lines.flatMap((line) => line.markers?.filter((mark) => mark.date === dates[row]).map((mark) => mark.name) ?? [])),
      ].filter(Boolean).join("\n");
    },
    note: (position) => {
      const row = observations.get(position);
      return row == null ? undefined : notes?.[row];
    },
  };
  return (
    <>
      <Plot
        label={label}
        readout={readout}
        fullscreen={fullscreen}
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
                  : currencyTick
                    ? (v < 0 ? "−£" : "£") +
                      Math.abs(v).toLocaleString("en-GB", {
                        notation: "compact",
                        maximumSignificantDigits: 5,
                      })
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
              const rows = entries.filter(
                (entry) =>
                  !String(entry.seriesId ?? "").startsWith("history-gap:") && Array.isArray(entry.value) && entry.value.at(-1) != null,
              );
              if (!rows.length) return "";
              const value = rows[0].value as [number, number];
              const row = timeline?.rowIndexes[value[0]];
              const timestamp = timeline
                ? row == null
                  ? null
                  : dates[row]
                : value[0];
              if (timestamp == null) return "";
              const date = formatDate(
                timestamp,
                locale,
                intraday
                  ? {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone,
                      timeZoneName: "short",
                    }
                  : {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    },
              );
              return [
                date,
                ...rows.map((entry) => {
                  const amount = (entry.value as [number, number])[1];
                  return `${entry.seriesName}: ${percentage ? percent(amount, true, 2) : chartNumber(amount)}`;
                }),
              ].join("\n");
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
          series: lines.flatMap((line, i) => {
            const colour =
              c[
                line.colour ??
                  (i === 0 ? "brand" : i === 1 ? "accent" : "secondary")
              ];
            const data = historySeries(dates, line.values, intraday, timeline);
            const gaps = line.type === "bar" ? [] : historyGapSeries(data);
            const single = line.values.filter((value) => value != null).length === 1;
            const primary = {
              type: line.type ?? "line",
              name: line.name,
              data,
              symbol: single ? "circle" : "none",
              showSymbol: single,
              symbolSize: 4,
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
              markPoint: line.markers?.length ? {
                silent: true, symbol: "circle", symbolSize: 7,
                label: { show: false },
                itemStyle: { color: colour, borderColor: c.tooltip, borderWidth: 1.5 },
                data: line.markers.flatMap(({ date, name }) => {
                  const row = dates.indexOf(date);
                  const x = timeline ? timeline.rowIndexes.indexOf(row) : Date.parse(date);
                  return row < 0 || x < 0 || line.values[row] == null ? [] : [{ coord: [x, line.values[row]], name }];
                }),
              } : undefined,
              emphasis: { focus: "series" },
              barMaxWidth: 24,
            } satisfies SeriesOption;
            return [primary, ...(gaps.length ? [{
              id: `history-gap:${i}`, type: "line" as const, data: gaps,
              silent: true, tooltip: { show: false }, symbol: "none", showSymbol: false,
              connectNulls: false,
              lineStyle: { color: colour, width: 1.5, type: "dotted" as const, opacity: 0.65 },
              emphasis: { disabled: true },
            } satisfies SeriesOption] : [])];
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
            ...(notes
              ? [
                  {
                    label: t("来源与精度", "Source & precision"),
                    value: (row: { index: number }) => notes[row.index],
                  },
                ]
              : []),
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
  items: Array<{ label: string; colour?: string; dashed?: boolean; dotted?: boolean }>;
}) {
  return (
    <div className="mx-chart-legend">
      {items.map((item, i) => (
        <span key={item.label}>
          {item.dashed || item.dotted ? (
            <svg width="15" height="4" aria-hidden="true">
              <path d="M0 2h15" stroke={item.colour ?? `var(--mx-chart-${i})`} strokeWidth="2" strokeDasharray={item.dotted ? "1 4" : "4 3"} />
            </svg>
          ) : <i style={{ background: item.colour ?? `var(--mx-chart-${i})` }} />}
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
        tooltip: {
          valueFormatter: (value) => percentage ? percent(value, true, 2) : chartNumber(value),
        },
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
