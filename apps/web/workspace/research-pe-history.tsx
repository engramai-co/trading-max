"use client";

import { useLocale, type Locale } from "@/components/locale-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { formatCalendarDate } from "@/ui/formatters";
import { compact, number } from "@/workspace/data";
import type { EChartsOption } from "echarts";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ChartReadout, Reading, ReadingItem } from "./chart-readout";
import { PercentileBand } from "./percentile-band";
import { Empty, Panel, Segments, useCopy } from "./foundation";
import { epsFigure } from "./reading-figures";
import { quoteAmount, quoteUnit, quoteValue } from "./financial-values";

type Trailing = NonNullable<ResearchLensSnapshot["trailingPeHistory"]>;
type Forward = NonNullable<ResearchLensSnapshot["forwardPeHistory"]>;
type Basis = "trailing" | "forward" | "sales";
type Point = {
  date: string;
  pe: number | null;
  segment: string | number | null;
  trailing?: Trailing["points"][number];
  forward?: Forward["points"][number];
};
type Translator = ReturnType<typeof useCopy>;

/** One date on the P/E line: the multiple leads, then where it sits in the band and its two inputs.
 * Sources and effective dates are in the panel help; a point flags only a basis unlike its neighbours. */
function peReading(
  point: Point, trailing: Trailing | null | undefined, forward: Forward | null | undefined,
  t: Translator, locale: Locale, multiple: (value: number) => string, rank: ReadingItem[],
): Reading | null {
  const time = formatCalendarDate(point.date, locale);
  const value = (eps: number | null | undefined) => point.pe != null ? multiple(point.pe)
    : eps != null && eps <= 0 ? t("不适用", "Not meaningful") : "—";
  if (point.trailing && trailing) {
    const eps = point.trailing.earningsIndex === null ? undefined : trailing.earnings[point.trailing.earningsIndex];
    return {
      time,
      flag: eps?.method === "derivedFourthQuarter" ? t("推算 Q4", "Inferred Q4") : undefined,
      primary: { value: value(eps?.eps) },
      groups: [[...rank,
        { label: t("收盘价", "Close"), value: quoteValue(point.trailing.close, trailing.currency, { style: "figure" }) },
        { label: "EPS (TTM)", value: epsFigure(quoteAmount(eps?.eps, trailing.currency)) }]],
    };
  }
  if (point.forward && forward) {
    const vendor = point.forward.source === "yahoo-forward-pe";
    return {
      time,
      flag: vendor ? t("备用口径", "Fallback") : undefined,
      primary: { value: value(point.forward.eps) },
      groups: [[...rank,
        { label: t("价格", "Price"), value: quoteValue(point.forward.price, forward.currency, { style: "figure" }) },
        vendor
          ? { label: t("远期 EPS（单位未核实）", "Forward EPS (unit unverified)"), value: epsFigure(point.forward.eps) }
          : { label: "EPS (NTM)", value: epsFigure(quoteAmount(point.forward.eps, forward.currency)) }]],
    };
  }
  return null;
}

const dayMs = 86_400_000;

export function PeHistoryChart({ trailing, forward, sales, disclosure }: { trailing?: Trailing | null; forward?: Forward | null; sales: ReactNode; disclosure: ReactNode }) {
  const t = useCopy();
  const { locale } = useLocale();
  const colours = useChartColours();
  const [chosen, choose] = useState<Basis>();
  const [mode, setMode] = useState<"quartiles" | "deviation">("quartiles");
  const basis = chosen ?? (trailing?.points.length || !forward ? "trailing" : "forward");
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
  // The band's sample: valid readings, and for NTM only those on the latest reading's basis.
  const inSample = useCallback((point: Point) =>
    point.pe != null && (isTrailing || point.segment === latest?.segment), [isTrailing, latest?.segment]);
  const sample = useMemo(() => distribution
    ? points.flatMap((point) => inSample(point) ? [point.pe as number] : []).sort((a, b) => a - b)
    : [], [distribution, points, inSample]);
  const readout = useMemo<ChartReadout>(() => {
    const times = points.map((point) => Date.parse(point.date));
    const at = new Map(times.map((time, index) => [time, index]));
    const read = (position: number) => {
      const point = points[at.get(position) ?? -1];
      if (!point) return null;
      // Pxx is the share of the sample at or below this reading, as for the latest value.
      const rank: ReadingItem[] = sample.length && inSample(point)
        ? [{ label: t("历史分位", "Percentile"), value: "P" + Math.round(100 * sample.filter((v) => v <= point.pe!).length / sample.length) }]
        : [];
      return peReading(point, trailing, forward, t, locale, (value) => displayMultiple(value, 2), rank);
    };
    return {
      positions: times,
      read,
      marks: (position) => {
        const pe = points[at.get(position) ?? -1]?.pe;
        return pe == null ? [] : [{ value: pe, colour: colours.text }];
      },
      latest: latestValue ?? "—",
    };
  }, [points, sample, inSample, trailing, forward, t, locale, displayMultiple, colours.text, latestValue]);

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
          // Navigation and readings use only actual dates; the visual path
          // has extra null separators at filing changes and archive gaps.
          name: title,
          type: "line",
          data: plot.readings.map(([time, pe]) => [time, pe]),
          showSymbol: false,
          lineStyle: { opacity: 0 },
          itemStyle: { color: c.text },
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
      ],
    };
  }, [displayMultiple, latest, latestValue, plot, points.length, rank, title]);

  const nonPositive = isTrailing
    ? latest?.trailing?.earningsIndex != null && (trailing?.earnings[latest.trailing.earningsIndex]?.eps ?? Infinity) <= 0
    : latest?.forward?.eps != null && latest.forward.eps <= 0;
  const supported = isTrailing ? trailing != null : true;
  const emptyReason = !supported ? t("暂不支持滚动 P/E 历史", "Trailing P/E history is unavailable")
    : !points.length ? t("历史存档尚无记录", "History archive is empty")
    : nonPositive ? t("EPS 不为正，无法计算 P/E", "P/E is undefined for nonpositive EPS")
    : t("有效样本不足", "Not enough valid observations");
  const validDates = points
    .filter((point) => point.pe != null && (isTrailing || !distribution || point.segment === latest?.segment))
    .map((point) => point.date);
  const unit = quoteUnit((isTrailing ? trailing : forward)?.currency).currency;
  const span = validDates.length ? `${date(validDates[0])} – ${date(validDates.at(-1)!)}` : undefined;

  return (
    <Panel
      title={t("历史估值", "Historical valuation")}
      className="mx-pe-history"
      action={
        <div className="mx-pe-history-controls">
          <Segments
            label={t("历史估值口径", "Historical valuation basis")}
            value={basis}
            onChange={choose}
            options={[
              { value: "trailing", label: t("滚动 P/E", "Trailing P/E"), short: "TTM" },
              { value: "forward", label: "NTM P/E", short: "NTM" },
              { value: "sales", label: t("市销率", "P/S"), short: "P/S" },
            ]}
          />
          {basis !== "sales" && distribution && <Segments
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
      help={basis !== "sales" && <>
        <p>{isTrailing ? t(
          "每日收盘价除以同一拆股口径的摊薄 EPS。财年末用已披露的全年 EPS，其他日期用最近四个完整季度；缺少第四季度时以全年减前三季推算，读数标「推算 Q4」。每次 EPS 更新开始新的一段，EPS 不为正时留空。",
          "Daily close divided by diluted EPS on the same share basis. At year end use filed full-year EPS; otherwise use the latest four complete quarters. An unreported Q4 is inferred from full-year EPS minus Q1–Q3 and its readings say Inferred Q4. Each new EPS starts a segment; nonpositive EPS leaves a gap.",
        ) : t(
          "NTM 是未来 12 个月。按存档日到本财年末的剩余天数占财年长度的比例，对本财年和下一财年的一致预期 EPS 加权，再用同一存档里的价格相除；加权 EPS 不为正时留空。财年口径对不上时改用备用的远期 P/E，预测期限可能不同，读数标「备用口径」。",
          "NTM means next twelve months. Current- and next-fiscal-year consensus EPS are weighted by the fraction of the fiscal year remaining on the archive date, and the archived price is divided by that EPS; nonpositive weighted EPS leaves a gap. When the fiscal inputs cannot be aligned, a fallback forward P/E is used, whose horizon can differ; its readings say Fallback.",
        )}</p>
        <p>{isTrailing ? t(
          "阴影为 P25–P75 或均值 ±1σ，虚线为中位数或均值。Pxx 表示小于或等于该读数的样本占比，至少需 60 个有效收盘读数。",
          "The band shows P25–P75 or mean ±1σ; the dashed line is the median or mean. Pxx is the share of the sample at or below a reading and requires 60 valid closes.",
        ) : t(
          "阴影为 P25–P75 或均值 ±1σ，虚线为中位数或均值。分布和 Pxx 只与最新值同口径的存档比较，至少需 30 个有效日期。相隔超过 7 天的观测不连线。",
          "The band shows P25–P75 or mean ±1σ; the dashed line is the median or mean. The band and percentile use at least 30 valid archive dates on the latest reading's basis. Observations more than seven days apart are not joined.",
        )}</p>
      </>}
      helpBasis={<>
        {isTrailing ? t(
          "Yahoo 每日收盘价（调整拆股，不调整分红）；SEC Companyfacts 摊薄 EPS，从 EDGAR 接收文件后的首个收盘生效。每个交易日更新。",
          "Yahoo daily close (split adjusted, excluding dividends); SEC Companyfacts diluted EPS, effective from the first close after EDGAR acceptance. Updated each trading day.",
        ) : t(
          "Yahoo 本财年和下一财年一致预期 EPS 与价格的存档，备用口径为存档中的 Yahoo forwardPE。每个交易所当地日期取最后一条存档，从已有记录起画。",
          "Archived Yahoo current- and next-fiscal-year consensus EPS and price; the fallback is archived Yahoo forwardPE. Each exchange-local date uses its last stored observation, starting with the archive.",
        )}
        {unit && <>{" "}{t("价格币种：", "Price currency: ")}{unit}.</>}
        {span && <>{" "}{t("样本：", "Sample: ")}{span}{t("。", ".")}</>}
      </>}
    >
      {basis === "sales" ? sales : !plot.observed.length ? (
        <Empty title={emptyReason} />
      ) : (
        <>
          {!distribution && <p className="mx-price-caveat">{t("有效样本不足，暂无分位带", "Not enough observations for a percentile band")}</p>}
          {latestValue === null && nonPositive && <p className="mx-price-caveat">{t("最新 EPS 不为正，无法计算 P/E", "Latest EPS is nonpositive; P/E is undefined")}</p>}
          {latestValue === null && !nonPositive && <p>{isTrailing
            ? t("最新收盘暂无 P/E", "No P/E for the latest close")
            : t("最新存档暂无 P/E", "No P/E for the latest archive date")}</p>}
          <PercentileBand
            distribution={distribution}
            level={mode === "quartiles" ? "P25–P75" : "mean ±1σ"}
            extent={[plot.readings[0][0], plot.readings.at(-1)![0]]}
            key={basis}
            research
            height={265}
            label={`${isTrailing ? t("滚动 P/E 历史", "Trailing P/E history") : t("NTM P/E 历史", "NTM P/E history")}${rank == null ? "" : ` · ${t("历史分位", "Historical percentile")} P${number(rank * 100, 0)}`}`}
            option={option}
            readout={readout}
          />
        </>
      )}
      {basis !== "sales" && <details className="mx-chart-data"><summary>{t("披露时的估值", "Valuation at disclosure")}</summary>{disclosure}</details>}
    </Panel>
  );
}
