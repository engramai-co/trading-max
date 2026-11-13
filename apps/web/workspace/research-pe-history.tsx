"use client";

import { useLocale, type Locale } from "@/components/locale-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import type { ChartColours } from "@/ui/charts/palette";
import { formatDate, formatCalendarDate } from "@/ui/formatters";
import { compact, number } from "@/workspace/data";
import type { EChartsOption } from "echarts";
import { useCallback, useMemo, useState } from "react";
import { Plot } from "./charts";
import { Empty, Panel, Segments, useCopy } from "./foundation";

type Trailing = NonNullable<ResearchLensSnapshot["trailingPeHistory"]>;
type Forward = NonNullable<ResearchLensSnapshot["forwardPeHistory"]>;
type Basis = "trailing" | "forward";
type Point = {
  date: string;
  pe: number | null;
  segment: string | number | null;
  trailing?: Trailing["points"][number];
  forward?: Forward["points"][number];
};
type Translator = ReturnType<typeof useCopy>;

function trailingReading(
  point: Trailing["points"][number], history: Trailing, t: Translator,
  date: (iso: string) => string,
) {
  const eps = point.earningsIndex === null ? undefined : history.earnings[point.earningsIndex];
  const basis = eps?.method === "annual"
    ? t("财年披露", "Filed full year")
    : eps?.method === "derivedFourthQuarter"
      ? t("含推算的第四季度", "Includes inferred Q4")
      : t("连续四个季度", "Four consecutive quarters");
  return [
    `${date(point.date)} · ${t("滚动 P/E", "Trailing P/E")} ${point.pe == null
      ? eps && eps.eps <= 0 ? t("不适用", "Not meaningful") : "—"
      : number(point.pe, 2) + "×"}`,
    `${t("收盘价", "Close")} ${point.close === null ? "—" : number(point.close, 2) + " USD"} · Yahoo`,
    `EPS (TTM) ${eps ? number(eps.eps, 4) + " USD" : "—"} · SEC Companyfacts`,
    ...(eps ? [
      `${t("报告期截至", "Period ended")} ${date(eps.periodEnd)}`,
      `${t("生效", "Effective")} ${date(eps.effectiveDate)}`,
      basis,
    ] : []),
  ];
}

function forwardReading(point: Forward["points"][number], history: Forward, t: Translator, locale: Locale) {
  const instant = (value: string) => formatDate(value, locale, {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }) + " UTC";
  const vendor = point.source === "yahoo-forward-pe";
  return [
    `${formatCalendarDate(point.date, locale)} · ${vendor ? t("远期 P/E", "Forward P/E") : "NTM P/E"} ${point.pe == null
      ? point.eps !== null && point.eps <= 0 ? t("不适用", "Not meaningful") : "—"
      : number(point.pe, 2) + "×"}`,
    `${t("价格", "Price")} ${point.price === null ? "—" : number(point.price, 2) + " " + history.currency}`,
    `${vendor ? "Yahoo forwardEps" : "EPS (NTM)"} ${point.eps === null ? "—" : number(point.eps, 4) + (vendor ? "" : " " + history.currency)}`,
    `${t("生效（存档）", "Effective (archive)")} ${instant(point.observedAt)}`,
    ...(point.priceAsOf ? [`${t("报价时间", "Quoted")} ${instant(point.priceAsOf)}`] : []),
    `${t("来源", "Source")}: ${vendor
      ? t("Yahoo forwardPE（备用）", "Yahoo forwardPE (fallback)")
      : point.source === "yahoo-consensus"
        ? t("Yahoo FY1 / FY2 一致预期", "Yahoo FY1 / FY2 consensus")
        : t("Yahoo（预期不足）", "Yahoo (incomplete estimates)")}`,
    ...(point.recovered ? [t("来自历史发布记录", "Recovered publication")] : []),
  ];
}

const dayMs = 86_400_000;

export function PeHistoryChart({ trailing, forward }: { trailing?: Trailing | null; forward?: Forward | null }) {
  const t = useCopy();
  const { locale } = useLocale();
  const [chosen, choose] = useState<Basis>();
  const [mode, setMode] = useState<"quartiles" | "deviation">("quartiles");
  const basis = chosen ?? (trailing?.points.length ? "trailing" : "forward");
  const isTrailing = basis === "trailing";
  const title = isTrailing ? t("滚动 P/E", "Trailing P/E") : "NTM P/E";
  const distribution = (isTrailing ? trailing : forward)?.distribution;

  const points = useMemo<Point[]>(() => isTrailing
    ? (trailing?.points ?? []).map((p) => ({ date: p.date, pe: p.pe, segment: p.earningsIndex, trailing: p }))
    : (forward?.points ?? []).map((p) => ({ date: p.date, pe: p.pe, segment: p.source, forward: p })),
  [isTrailing, trailing, forward]);
  const latest = points.at(-1);
  const rank = distribution?.latestPercentile;
  const displayMultiple = useCallback((value: number, decimals: number) =>
    `${Math.abs(value) >= 1_000 ? compact(value, locale) : number(value, decimals)}×`, [locale]);
  const latestValue = latest?.pe != null ? displayMultiple(latest.pe, 2) : null;
  const date = useCallback((iso: string) => formatCalendarDate(iso, locale), [locale]);
  const readPoint = useCallback((index: number) => {
    const point = points[index];
    if (!point) return "";
    if (point.trailing && trailing) return trailingReading(point.trailing, trailing, t, date).join("\n");
    if (point.forward && forward) return forwardReading(point.forward, forward, t, locale).join("\n");
    return "";
  }, [points, trailing, forward, t, date, locale]);

  const plot = useMemo(() => {
    const readings = points.map((p) => [Date.parse(p.date), p.pe] as const);
    const hasBreak = (i: number) => i > 0 && (
      points[i - 1].segment !== points[i].segment
      || (!isTrailing && readings[i][0] - readings[i - 1][0] > 7 * dayMs)
    );
    const line = readings.flatMap(([time, pe], i) => hasBreak(i)
      ? [[(readings[i - 1][0] + time) / 2, null], [time, pe]]
      : [[time, pe]]);
    const isolated = readings.flatMap(([time, pe], i) =>
      i !== readings.length - 1 && pe !== null &&
      (readings[i - 1]?.[1] == null || hasBreak(i)) && (readings[i + 1]?.[1] == null || hasBreak(i + 1))
        ? [{ coord: [time, pe], label: { show: false }, name: String(time) }] : []);
    const observed = readings.flatMap(([, pe]) => pe == null ? [] : [pe]);
    return { readings, line, isolated, observed };
  }, [isTrailing, points]);

  const option = useCallback((c: ChartColours): EChartsOption => {
    const band = distribution && (mode === "quartiles"
      ? { low: distribution.lowerQuartile, middle: distribution.median, high: distribution.upperQuartile }
      : {
          low: Math.max(0, distribution.mean - distribution.standardDeviation),
          middle: distribution.mean,
          high: distribution.mean + distribution.standardDeviation,
        });
    const endNote = [
      rank == null ? "" : `P${Math.round(rank * 100)}`,
      latest?.forward?.source === "yahoo-forward-pe" ? "Yahoo" : "",
    ].filter(Boolean).join(" · ");
    const endMarker = latestValue && latest?.pe != null
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
            fontFamily: "monospace",
            formatter: endNote ? `${latestValue}\n{note|${endNote}}` : latestValue,
            rich: { note: { color: c.axis, fontWeight: 400, fontSize: 12, lineHeight: 17 } },
          },
        }]
      : [];
    return {
      useUTC: true,
      animation: false,
      grid: { top: 18, right: latestValue ? endNote.includes("Yahoo") ? 96 : 76 : 14, bottom: 28, left: 53 },
      xAxis: {
        type: "time",
        boundaryGap: points.length === 1 ? ["8%", "8%"] : ["0%", "0%"],
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { hideOverlap: true },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: 4,
        axisLabel: {
          showMinLabel: false,
          showMaxLabel: false,
          fontFamily: "monospace",
          formatter: (value: number) => displayMultiple(value, 1),
        },
      },
      series: [
        {
          // Navigation and tooltips use only actual dates; the visual path
          // has extra null separators at filing changes and archive gaps.
          name: title,
          type: "line",
          data: plot.readings.map(([time, pe]) => [time, pe]),
          showSymbol: false,
          lineStyle: { opacity: 0 },
          itemStyle: { color: c.text },
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
            data: [...plot.isolated, ...endMarker],
          },
        },
        {
          type: "line",
          data: plot.line,
          connectNulls: false,
          silent: true,
          tooltip: { show: false },
          showSymbol: false,
          lineStyle: { color: c.text, width: 1.7 },
        },
        ...(band ? [{
          type: "line" as const,
          data: [[plot.readings[0][0], band.low], [plot.readings.at(-1)![0], band.high]],
          silent: true,
          tooltip: { show: false },
          showSymbol: false,
          lineStyle: { opacity: 0 },
        }] : []),
      ],
      tooltip: {
        formatter: (input) => {
          const point = Array.isArray(input) ? input.find((entry) => entry.seriesIndex === 0) : input;
          return point ? readPoint(point.dataIndex) : "";
        },
      },
    };
  }, [displayMultiple, distribution, latest, latestValue, mode, plot, points.length, rank, readPoint, title]);

  if (!trailing?.points.length && !forward?.points.length) return null;

  return (
    <Panel
      title={t("P/E 历史", "P/E history")}
      className="mx-pe-history"
      action={
        <div className="mx-pe-history-controls">
          <Segments
            label={t("P/E 口径", "P/E basis")}
            value={basis}
            onChange={choose}
            options={[
              { value: "trailing", label: t("滚动 P/E", "Trailing P/E"), short: "TTM" },
              { value: "forward", label: "NTM P/E", short: "NTM" },
            ]}
          />
          {distribution && <Segments
            label={t("历史分布区间", "Historical distribution band")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "quartiles", label: "P25–P75" },
              { value: "deviation", label: t("均值 ±1σ", "Mean ±1σ") },
            ]}
          />}
        </div>
      }
      help={<>
        <p>{isTrailing ? t(
          "以 Yahoo 每日收盘价（调整拆股，不调整股息）除以同一拆股口径的 SEC 摊薄 EPS。每次 EPS 变更分段，从 SEC 接收文件后的首个收盘生效。财年末优先用已披露全年 EPS；其他日期用最近四个完整季度，缺少第四季度时以全年减前三季推算。EPS 不为正时留空。",
          "Yahoo daily close (split adjusted, excluding dividends) divided by SEC diluted EPS on the same share basis. Each new EPS vintage starts a segment at the first close after EDGAR acceptance. At year end use filed full-year EPS; otherwise use the latest four complete quarters, inferring an unreported Q4 from full-year EPS minus Q1–Q3. Nonpositive EPS leaves a gap.",
        ) : t(
          "NTM 是未来 12 个月。按存档日到本财年末的剩余天数占财年长度的比例，对 Yahoo 本财年和下一财年的一致预期 EPS 加权，再用同一存档里的价格相除。口径不足时用存档中的 Yahoo forwardPE，预测期限可能不同；加权 EPS 不为正时留空。每个交易所当地日期取最后一条存档，从已有记录起画。",
          "NTM means next twelve months. Weight Yahoo current- and next-fiscal-year consensus EPS by the fraction of the fiscal year remaining on the archive date, then divide the archived price by that EPS. If the fiscal inputs cannot be aligned, use archived Yahoo forwardPE, whose horizon can differ. Nonpositive weighted EPS leaves a gap. Each exchange-local date uses its last stored observation, starting with the archive.",
        )}</p>
        <p>{isTrailing ? t(
          "阴影为 P25–P75 或均值 ±1σ，虚线为中位数或均值。Pxx 表示小于或等于最新读数的样本占比，至少需 60 个有效收盘读数。",
          "The band shows P25–P75 or mean ±1σ; the dashed line is the median or mean. Pxx is the share at or below the latest reading and requires 60 valid closes.",
        ) : t(
          "阴影为 P25–P75 或均值 ±1σ，虚线为中位数或均值。分布和 Pxx 只与最新值同口径的存档比较，至少需 30 个有效日期。相隔超过 7 天的观测不连线。",
          "The band shows P25–P75 or mean ±1σ; the dashed line is the median or mean. The band and percentile compare the latest reading with at least 30 valid archive dates on the same basis. Observations more than seven days apart are not joined.",
        )}</p>
        {distribution && latest && <p>{date(points[0].date)} – {date(latest.date)} · {number(distribution.samples, 0)} {t("个有效读数", "valid readings")}</p>}
      </>}
    >
      {!plot.observed.length ? (
        <Empty title={isTrailing
          ? t("暂无可计算的滚动 P/E", "No meaningful trailing P/E in this period")
          : points.length
            ? t("现有存档暂无可计算的远期 P/E", "No meaningful forward P/E in the archive")
            : t("暂无远期 P/E 存档", "No forward P/E archive yet")} />
      ) : (
        <>
          {latestValue === null && <p>{isTrailing
            ? t("最新收盘暂无 P/E", "No P/E for the latest close")
            : t("最新存档暂无 P/E", "No P/E for the latest archive date")}</p>}
          <Plot
            key={basis}
            research
            height={265}
            label={`${isTrailing ? t("滚动 P/E 历史", "Trailing P/E history") : t("NTM P/E 历史", "NTM P/E history")}. ${readPoint(points.length - 1)}${rank == null ? "" : ` · ${t("历史分位", "Historical percentile")} ${number(rank * 100, 0) + "%"}`}`}
            option={option}
            readPoint={readPoint}
          />
        </>
      )}
    </Panel>
  );
}
