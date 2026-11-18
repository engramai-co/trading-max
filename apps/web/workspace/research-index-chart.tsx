"use client";

import { MultiSelect, Switch } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQueries, useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import type { LineSeriesOption } from "echarts";
import { useState } from "react";
import { quoteUnit, quoteValue } from "./financial-values";
import { useLocale } from "@/components/locale-provider";
import { historyGapSeries } from "@/lib/portfolio/series";
import { formatCalendarDate, formatDeltaPercent, formatNumber, formatPercent, formatReadingTime } from "@/ui/formatters";
import { useChartColours } from "@/ui/charts/palette";
import type { ChartReadout, Reading, ReadingKey } from "./chart-readout";
import { comparisonFigures, fixed, plainPercent, readingTone, signedPercent } from "./reading-format";
import { DataBasis } from "./reading-card";
import { api } from "./data";
import { Empty, Panel, Pending, QueryError, Segments, useCopy } from "./foundation";
import type { IndexHistory, IndexIdentity, IndexRange } from "./market-indices-data";

const Plot = dynamic(() => import("./charts").then((module) => module.Plot));

export const indexHistoryQuery = (id: string, period: IndexRange, enabled: boolean) => ({
  queryKey: ["index-history", id, period, false],
  queryFn: ({ signal }: { signal: AbortSignal }) => api<IndexHistory>(
    `/indices/${id}/history?range=${period}&currency=local`, { signal },
  ),
  enabled,
  staleTime: 60_000,
  retry: 0,
});

export function comparableSeries(a: IndexIdentity, b: IndexIdentity, period: IndexRange) {
  return a.id !== b.id && a.kind === "index" && b.kind === "index"
    && !!a.variant && a.variant === b.variant && a.currency === b.currency && a.hedging === b.hedging
    && b.ranges.includes(period);
}

export function alignResearchIndices(series: IndexHistory[]) {
  const maps = series.map(({ points }) => new Map((points ?? []).map(({ at, value }) => [at, value])));
  const common = [...(maps[0]?.keys() ?? [])].find((at) => maps.every((map) => map.has(at)));
  const dates = [...new Set(series.flatMap(({ points, gaps }) => [
    ...(points ?? []).map((row) => row.at), ...(gaps ?? []),
  ]))].sort().filter((at) => series.length === 1 || (common && at >= common));
  const values = maps.map((map) => dates.map((date) => {
    const value = map.get(date);
    return value == null ? null : common && series.length > 1 ? 100 * value / map.get(common)! : value;
  }));
  return { dates, values };
}

export function rollingIndexRisk(values: (number | null)[], periods: number) {
  let peak = 0;
  const drawdown = values.map((value) => {
    if (value == null) return null;
    peak = Math.max(peak, value);
    return value / peak - 1;
  });
  const changes = values.map((value, i) => {
    const previous = values[i - 1];
    return value != null && previous ? value / previous - 1 : null;
  });
  const volatility = changes.map((_, i) => {
    if (i < 20) return null;
    const sample = changes.slice(i - 19, i + 1);
    if (sample.some((value) => value == null)) return null;
    const values = sample as number[];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(periods * values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  });
  return { drawdown, volatility };
}

export function indexLogDomain(series: (number | null)[][]) {
  const observed = series.flat().filter((value): value is number => value != null && value > 0);
  if (!observed.length) return {};
  const low = Math.log(Math.min(...observed));
  const high = Math.log(Math.max(...observed));
  const padding = Math.max(.012, (high - low) * .055);
  return {
    min: Math.exp(low - padding),
    max: Math.exp(high + padding),
    logBase: Math.min(10, Math.exp(Math.max(.04, (high - low) / 4))),
  };
}

export function ResearchIndexChart({ index, catalogue, preview = false, demonstration = false }: {
  index: IndexIdentity; catalogue: IndexIdentity[]; preview?: boolean; demonstration?: boolean;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const colours = useChartColours();
  const phone = useMediaQuery("(max-width: 48em)");
  const [range, setRange] = useState<IndexRange>(index.ranges.includes("1Y") ? "1Y" : index.ranges.at(-1) ?? "3M");
  const [log, setLog] = useState(false);
  const [compare, setCompare] = useState<string[]>([]);
  const period = preview ? "3M" : range;
  const hasRange = index.ranges.includes(period) && !demonstration;
  const available = catalogue.filter((item) => comparableSeries(index, item, period));
  const peers = compare.flatMap((id) => {
    const match = available.find((item) => item.id === id);
    return match ? [match] : [];
  });
  const query = useQuery(indexHistoryQuery(index.id, period, hasRange));
  const requested = useQueries({ queries: peers.map((peer) => indexHistoryQuery(peer.id, period, hasRange)) });
  const history = query.data;
  const comparisons = requested.flatMap((peer, i) => {
    const data = peer.data;
    return data && data.points?.length && history && data.displayInterval
      && data.displayInterval === history.displayInterval && Boolean(data.hourlyClose) === Boolean(history.hourlyClose)
      ? [{ data, index: peers[i] }] : [];
  });
  const series = history ? [history, ...comparisons.map(({ data }) => data)] : [];
  const prepared = alignResearchIndices(series);
  const comparing = comparisons.length > 0 && prepared.dates.length > 1;
  const { dates, values } = comparing ? prepared : alignResearchIndices(history ? [history] : []);
  const primary = values[0] ?? [];
  const labels = [index, ...(comparing ? comparisons.map(({ index }) => index) : [])]
    .map((item) => t(item.nameZh, item.name));
  const intraday = ["1D", "1W", "1M"].includes(period);
  const daily = history?.displayInterval === "1d";
  const weekly = history?.displayInterval === "1wk";
  const fundPrice = !comparing && index.kind === "etf-price";
  const priceUnit = history?.currency ?? index.currency;
  const levelText = (value: number | null | undefined) => fundPrice
    ? quoteValue(value, priceUnit, { style: "figure" }) : fixed(value);
  const unit = comparing ? "100" : index.kind === "volatility" ? t("波动率点数", "Volatility points")
    : fundPrice ? quoteUnit(priceUnit).currency || "—" : t("点", "pts");
  const first = primary.find((value) => value != null);
  const last = primary.findLast((value) => value != null);
  const performance = first && last != null ? last / first - 1 : null;
  const { drawdown, volatility } = rollingIndexRisk(primary, weekly ? 52 : 252);
  const label = preview ? t("走势 · 3M", "Price · 3M") : t("价格与走势", "Price & trend");
  const stamp = (at: string) => intraday
    ? new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone })
    : formatCalendarDate(at, locale);
  const valueText = (value: number | null | undefined) => value == null ? "—"
    : fundPrice ? quoteValue(value, priceUnit, { style: "number" }) : formatNumber(value, locale, { maximumFractionDigits: 2 });
  // The index is the one solid primary line; comparisons are an ink dash and a grey dot.
  const strokes: ReadingKey[] = [
    { colour: colours.brand },
    { colour: colours.text, dashed: true },
    { colour: colours.axis, dotted: true },
  ];
  const read = (i: number): Reading | null => {
    if (!dates[i]) return null;
    const time = intraday ? formatReadingTime(dates[i], locale, timeZone, period === "1D" ? "clock" : "intraday") : formatCalendarDate(dates[i], locale);
    if (!comparing) return { time, primary: { value: levelText(primary[i]) } };
    return {
      time: time + " · " + t("起点 = 100", "Rebased to 100"),
      ...comparisonFigures(labels.map((name, series) => {
        const value = values[series]?.[i];
        return { item: { label: name, key: strokes[series], value: fixed(value) }, change: value == null ? null : value / 100 - 1 };
      }), t("相差", "Difference")),
    };
  };
  const positions = primary.flatMap((value, i) => value == null ? [] : [i]);
  const readout: ChartReadout = {
    positions,
    latest: positions.length ? levelText(primary[positions.at(-1)!]) : "—",
    read,
    marks: (i) => values.flatMap((series, s) => series[i] == null ? [] : [{ value: series[i]!, colour: strokes[s].colour }]),
    gap: (i: number) => primary[Math.round(i)] == null,
    observationCount: positions.length,
  };
  const tools = !preview && hasRange;
  const logarithmic = log && ["1Y", "3Y", "5Y", "MAX"].includes(period);
  const logDomain = logarithmic ? indexLogDomain(values) : {};
  return (
    <Panel title={label} help={<>
      <p>{t(
        "区间收益从图中首个有效读数计算。对比按第一个共同日期归一为 100；只允许同币种、同回报口径和同对冲的指数。",
        "Period return uses the first visible observation. Comparisons start at 100 on the first common date, with matching currency, return variant and hedge basis.",
      )}</p>
      <DataBasis>{t(
        "指数点位来自数据源的收盘或盘中读数，单位见图上方；回撤和滚动波动率按图中的读数计算，点线跨过缺失的读数。",
        "Index levels are the provider’s closing or intraday readings, in the unit shown above the chart. Drawdown and rolling volatility use the plotted readings; dotted lines bridge missing ones.",
      )}</DataBasis>
    </>}>
      {tools && <div className="mx-index-research-chart-tools">
        <Segments label={t("时间范围", "Range")} value={period}
          options={index.ranges.map((value) => ({ value, label: value === "MAX" ? t("全部", "All") : value }))}
          onChange={setRange} />
        <div>
          {available.length > 0 && <MultiSelect searchable clearable maxValues={2}
            value={peers.map((item) => item.id)} onChange={setCompare}
            aria-label={t("比较指数", "Compare with index")} placeholder={t("比较指数", "Compare with index")}
            data={available.map((item) => ({ value: item.id, label: t(item.nameZh, item.name) }))} />}
          {["1Y", "3Y", "5Y", "MAX"].includes(period) &&
            <Switch checked={logarithmic} onChange={(event) => setLog(event.currentTarget.checked)}
              label={t("对数", "Log")} />}
        </div>
      </div>}
      {hasRange && query.isPending ? <Pending label={t("正在加载走势", "Loading index history")} /> : query.isError
        ? <QueryError retry={query.refetch} showDataStatusLink={false} /> : dates.length < 2
          ? <Empty title={t("此范围没有走势", "No history for this range")} /> : <>
            <div className="mx-index-research-chart-top">
              <span>{t("区间收益", "Period return")} <strong className={performance == null ? "" : performance > 0 ? "mx-up" : performance < 0 ? "mx-down" : ""}>
                {formatDeltaPercent(performance, locale, 2)}
              </strong></span>
              <span>{comparing ? t("基准化 · 100", "Rebased · 100") : [unit, index.kind === "index" ? index.currency : null].filter(Boolean).join(" · ")}</span>
            </div>
            {history?.coverageReason && <small className="mx-index-research-caveat">
              {history.coverageReason === "source-interval-mismatch"
                ? t("来源未返回日线。频率：", "Daily data unavailable. Source interval: ") + (history.sourceInterval ?? t("未知", "unknown"))
                : t("日线覆盖不完整", "Daily coverage is incomplete")}
            </small>}
            {peers.length > comparisons.length && !requested.some((result) => result.isPending)
              && <small className="mx-index-research-caveat">{t("部分对比没有相同频率的历史。", "Some comparisons lack history at the same interval.")}</small>}
            {comparisons.length > 0 && !comparing &&
              <small className="mx-index-research-caveat">{t("对比序列没有足够的共同日期。", "The comparison series have too few shared dates.")}</small>}
            <Plot height={phone ? 235 : preview ? 276 : 330} label={label}
              readout={readout}
              option={(colours) => {
                const inks = [colours.brand, colours.text, colours.axis];
                const series: LineSeriesOption[] = values.map((data, i) => ({
                  name: labels[i], type: "line", data, showSymbol: false,
                  lineStyle: { color: inks[i], width: i ? 1.35 : 2, type: i ? (i === 1 ? "dashed" : "dotted") : "solid" },
                  itemStyle: { color: inks[i] },
                }));
                return {
                  animation: false,
                  grid: { left: 64, right: 15, top: comparing ? 40 : 17, bottom: 30 },
                  legend: comparing ? { top: 2, left: "center", show: true, data: labels,
                    textStyle: { color: colours.text } } : undefined,
                  xAxis: { type: "category", data: dates, boundaryGap: false,
                    axisLabel: { formatter: (at: string) => period === "MAX" ? at.slice(0, 4) : stamp(at) } },
                  yAxis: { type: logarithmic ? "log" : "value", scale: true, splitNumber: 4,
                    ...logDomain, axisLabel: { formatter: valueText } },
                  series: [...series, {
                    id: "history-gap:index", type: "line",
                    data: historyGapSeries(primary.map((value, i) => ({ value: [i, value], symbolSize: 0 }))),
                    silent: true, tooltip: { show: false }, showSymbol: false, connectNulls: false,
                    lineStyle: { color: colours.axis, type: "dotted", width: 1.5 },
                  }],
                };
              }}
            />
            {!preview && (daily || weekly) && <div className="mx-index-research-risk">
              <RiskChart dates={dates} values={drawdown} title={t("回撤", "Drawdown")} signed />
              <RiskChart dates={dates} values={volatility} title={t("滚动波动率 · 20 点", "Rolling volatility · 20 bars")} />
            </div>}
          </>}
    </Panel>
  );
}

/**
 * A small daily percentage chart read through the reading card: the date as a calendar day,
 * one figure in the line's colour, signed and toned when `signed` (drawdown, differences).
 */
export function RiskChart({ dates, values, title, primary = false, signed = false }: {
  dates: string[]; values: (number | null)[]; title: string; primary?: boolean; signed?: boolean;
}) {
  const { locale } = useLocale();
  const t = useCopy();
  const colours = useChartColours();
  const colour = primary ? colours.brand : colours.text;
  const positions = values.flatMap((value, i) => value == null ? [] : [i]);
  const figure = (value: number | null | undefined) => signed
    ? { value: signedPercent(value), ...(readingTone((value ?? 0) * 100) ? { tone: readingTone((value ?? 0) * 100) } : {}) }
    : { value: plainPercent(value) };
  const readout: ChartReadout = {
    positions,
    latest: positions.length ? figure(values[positions.at(-1)!]).value : "—",
    read: (i) => values[i] == null ? null : { time: formatCalendarDate(dates[i], locale), primary: figure(values[i]) },
    marks: (i) => values[i] == null ? [] : [{ value: values[i]!, colour }],
    gap: (i) => values[Math.round(i)] == null,
  };
  return <section className="mx-index-research-risk-chart" aria-label={title}>
    <h3>{title}</h3>
    {values.every((value) => value == null) ? <p>{t("历史数据不足", "Insufficient history")}</p>
      : <Plot height={155} label={title}
        readout={readout}
        option={(chartColours) => ({
          animation: false,
          grid: { top: 12, bottom: 32, left: 62, right: 14 },
          xAxis: { type: "category", boundaryGap: false, data: dates,
            axisLabel: { formatter: (day: string) => formatCalendarDate(day, locale) } },
          yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { formatter: (value) => formatPercent(value, locale, 1) } },
          series: [{ type: "line", data: values, showSymbol: false, lineStyle: { color: primary ? chartColours.brand : chartColours.text, width: 1.5 } }],
        })} />}
  </section>;
}
