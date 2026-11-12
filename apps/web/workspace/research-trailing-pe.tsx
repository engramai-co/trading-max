"use client";

import { useLocale } from "@/components/locale-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import { formatDate } from "@/ui/formatters";
import type { ChartColours } from "@/ui/charts/palette";
import { compact, number } from "@/workspace/data";
import type { EChartsOption } from "echarts";
import { useCallback, useMemo, useState } from "react";
import { Plot } from "./charts";
import { Empty, Panel, Segments, useCopy } from "./foundation";

type History = NonNullable<ResearchLensSnapshot["trailingPeHistory"]>;

export function TrailingPeChart({ history }: { history: History | null }) {
  return history?.points.length ? <HistoryChart history={history} /> : null;
}

function HistoryChart({ history }: { history: History }) {
  const t = useCopy();
  const { locale } = useLocale();
  const [mode, setMode] = useState("quartiles");
  const { points, earnings, distribution } = history;
  const latest = points.at(-1)!;
  const rank = distribution?.latestPercentile;
  const displayMultiple = useCallback((value: number, decimals: number) =>
    `${Math.abs(value) >= 1_000 ? compact(value, locale) : number(value, decimals)}×`, [locale]);
  const latestValue = latest.pe === null ? null : displayMultiple(latest.pe, 2);
  const title = t("滚动 P/E", "Trailing P/E");
  const observed = useMemo(() => points.flatMap(({ pe }) => pe === null ? [] : [pe]), [points]);
  const noPositive = !observed.length;
  const date = useCallback((iso: string) =>
    formatDate(iso + "T00:00:00Z", locale, { dateStyle: "medium", timeZone: "UTC" }), [locale]);

  const readPoint = useCallback((index: number) => {
    const point = points[index];
    if (!point) return "";
    const eps = point.earningsIndex === null ? undefined : earnings[point.earningsIndex];
    const basis = eps?.method === "annual"
      ? t("财年披露", "Filed full year")
      : eps?.method === "derivedFourthQuarter"
        ? t("含推算的第四季度", "Includes inferred Q4")
        : t("连续四个季度", "Four consecutive quarters");
    const multiple = point.pe === null
      ? eps && eps.eps <= 0 ? t("不适用", "Not meaningful") : "—"
      : `${number(point.pe, 2)}×`;
    return [
      `${date(point.date)} · ${title} ${multiple}`,
      `${t("收盘价", "Close")} ${point.close === null ? "—" : number(point.close, 2) + " USD"} · Yahoo`,
      `EPS (TTM) ${eps ? number(eps.eps, 4) + " USD" : "—"} · SEC Companyfacts`,
      ...(eps ? [
        `${t("报告期截至", "Period ended")} ${date(eps.periodEnd)}`,
        `${t("生效", "Effective")} ${date(eps.effectiveDate)} · ${basis}`,
      ] : []),
    ].join("\n");
  }, [points, earnings, t, title, date]);

  const series = useMemo(() => points.map((point) => [Date.parse(point.date), point.pe]), [points]);
  const option = useCallback((c: ChartColours): EChartsOption => {
    const quartiles = mode === "quartiles";
    const band = distribution && (quartiles
      ? { low: distribution.lowerQuartile, middle: distribution.median, high: distribution.upperQuartile }
      : {
          low: distribution.mean - distribution.standardDeviation,
          middle: distribution.mean,
          high: distribution.mean + distribution.standardDeviation,
        });
    const lastIndex = points.length - 1;
    const isolated = points.flatMap((point, index) =>
      index !== lastIndex && point.pe !== null
        && points[index - 1]?.pe == null && points[index + 1]?.pe == null
        ? [{ name: title, coord: [Date.parse(point.date), point.pe], label: { show: false } }]
        : []);
    const endMarker = latestValue && latest.pe !== null
      ? [{
          name: title,
          coord: [Date.parse(latest.date), latest.pe],
          symbolSize: 7,
          label: {
            show: true,
            position: "right" as const,
            distance: 7,
            color: c.text,
            fontSize: 13,
            fontWeight: 600,
            formatter: rank == null ? latestValue : `${latestValue}\n{rank|P${Math.round(rank * 100)}}`,
            rich: { rank: { color: c.axis, fontWeight: 400, fontSize: 12, lineHeight: 17 } },
          },
        }]
      : [];
    return {
      useUTC: true,
      animation: false,
      grid: { top: 18, right: latestValue ? 66 : 14, bottom: 28, left: 48 },
      xAxis: {
        type: "time",
        boundaryGap: ["0%", "0%"],
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { hideOverlap: true },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: 4,
        ...(band && band.low < Math.min(...observed) && { min: band.low }),
        ...(band && band.high > Math.max(...observed) && { max: band.high }),
        axisLabel: { formatter: (value: number) => displayMultiple(value, 1) },
      },
      series: [{
        name: title,
        type: "line",
        data: series,
        connectNulls: false,
        showSymbol: false,
        itemStyle: { color: c.text },
        lineStyle: { color: c.text, width: 1.7 },
        ...(band && {
          markArea: {
            silent: true,
            itemStyle: { color: c.axis, opacity: 0.12 },
            data: [[{ yAxis: band.low }, { yAxis: band.high }]],
          },
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: c.axis, type: "dashed", width: 1 },
            data: [{ yAxis: band.middle }],
          },
        }),
        markPoint: {
          silent: true,
          symbol: "circle",
          symbolSize: 5,
          itemStyle: { color: c.text },
          data: [...isolated, ...endMarker],
        },
      }],
      tooltip: {
        formatter: (input) => {
          const point = Array.isArray(input) ? input[0] : input;
          return point ? readPoint(point.dataIndex) : "";
        },
      },
    };
  }, [displayMultiple, distribution, latest, latestValue, mode, observed, points, rank, readPoint, series, title]);

  return (
    <Panel
      title={title}
      className="mx-trailing-pe"
      action={distribution ? (
        <Segments
          label={t("历史分布区间", "Historical distribution band")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "quartiles", label: "P25–P75" },
            { value: "deviation", label: t("均值 ±1σ", "Mean ±1σ") },
          ]}
        />
      ) : undefined}
      help={<>
        <p>{t(
          "以 Yahoo 每日收盘价（已调整拆股，未调整股息），除以当时已披露的 SEC 摊薄 EPS（同一拆股口径）。EPS 从 SEC 接收文件后的首个收盘生效。财年末优先用已披露的全年 EPS，其他日期用最近四个完整季度；未披露的第四季度由全年减去前三季推算。EPS 不为正时留空。",
          "Yahoo daily close (adjusted for splits, excluding dividends) divided by SEC diluted EPS known at that close, on the same share basis. EPS first applies at the close after EDGAR acceptance. Use filed full-year EPS when available at year end and the latest four complete quarters elsewhere; infer an unreported Q4 from full-year EPS minus Q1–Q3. Nonpositive EPS leaves a gap.",
        )}</p>
        <p>{t(
          "实线是每日 P/E，虚线为中位数或均值。Pxx 表示样本中小于或等于最新读数的比例。区间和分位只使用图中有效的每日读数，至少需要 60 个样本。",
          "The solid line is daily P/E; the dashed line is the median or mean. Pxx is the share of observations at or below the latest reading. The band and percentile use valid daily readings in the chart and require at least 60 observations.",
        )}</p>
        {distribution && <p>{date(points[0].date)} – {date(latest.date)} · {number(distribution.samples, 0)} {t("个有效收盘读数", "valid closes")}</p>}
      </>}
    >
      {noPositive ? (
        <Empty title={t("暂无可计算的滚动 P/E", "No meaningful trailing P/E in this period")} />
      ) : (
        <>
          {latestValue === null && <p>{t("最新收盘暂无 P/E", "No P/E for the latest close")}</p>}
          <Plot
            research
            height={265}
            label={`${t("滚动 P/E 历史", "Trailing P/E history")}. ${readPoint(points.length - 1)}${rank == null ? "" : ` · ${t("历史分位", "Historical percentile")} ${number(rank * 100, 0) + "%"}`}`}
            option={option}
            readPoint={readPoint}
          />
        </>
      )}
    </Panel>
  );
}
