"use client";
import { useResearchChartWindow } from "./assistant/context";
import { useMediaQuery } from "@mantine/hooks";
import { markerHeadroom } from "./assistant/marker-layout";
import { MomentOverlay, useKeyMoments } from "./assistant/moment-controls";
import { researchLensQuery, researchPriceQuery } from "./research-queries";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button, Checkbox, Group, Modal, Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ECharts, SeriesOption } from "echarts";
import { useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateSpan, formatExchangeTime } from "@/ui/formatters";
import { useChartColours } from "@/ui/charts/palette";
import { Legend, Plot } from "./charts";
import type { Reading, ReadingItem, ReadingMark } from "./chart-readout";
import { comparisonFigures, fixed, readingTone, signedPercent, telling, volume } from "./reading-format";
import { quoteAmount, quoteUnit, quoteValue } from "./financial-values";
import { DataBasis } from "./reading-card";
import { candleSeries, candleValues, previousCloses, priceGapConnectors, priceReading, priceSlots } from "./research-price-candles";
import { PriceEventTrack, priceEventDays } from "./research-price-events";
import { ApiError, compactTick, number, object, objects, percent, str } from "@/workspace/data";
import { inRange, type Range } from "@/lib/portfolio/nav";
import { EvidenceTable } from "./evidence-table";
import {
  Empty,
  Freshness,
  Panel,
  Pending,
  QueryError,
  Segments,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { previousForIdentity } from "./loading-state";
import { useRetainedResult } from "./retained-result";
import { useRouteState } from "./route-state";
import {
  compactPriceRanges,
  incompletePriceRange,
  priceIntervals,
  priceRanges,
  resolvePriceInterval,
  supportsPriceRange,
} from "./research-price-settings";

const intervals = priceIntervals;
const fullSelectStyles = { input: { height: 44, minHeight: 44 } };
export function PriceHistory({
  ticker,
  runId,
  snapshotId,
  context,
  compactChart = false,
}: {
  ticker: string;
  runId: string;
  snapshotId?: string;
  technical?: boolean;
  context?: ResearchLensSnapshot;
  compactChart?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const colours = useChartColours();
  const { params, update } = useRouteState("push");
  const ranges = priceRanges;
  const full = params.get("chart") === "full";
  const range = ranges.includes(params.get("priceRange") ?? "")
    ? params.get("priceRange")!
    : "3M";
  const requested = params.get("interval");
  const interval = resolvePriceInterval(range, requested, true);
  const style = params.get("priceStyle") === "line" ? "line" : "candles";
  const scale = params.get("priceScale") ?? "linear";
  const averages = params.get("ma") === "on";
  const selectedMa = params.get("highlightMa");
  const averagePeriods = full || params.has("maPeriods")
    ? (params.get("maPeriods") ?? "20,50")
        .split(",")
        .filter((v) => ["20", "50", "200"].includes(v))
    : [...new Set(["20", "50", ...(selectedMa === "sma200" ? ["200"] : [])])];
  const rsi = full && params.get("rsi") === "on";
  const macd = full && params.get("macd") === "on";
  const comparison = params.get("benchmark") ?? "none";
  const [eventTrack, setEventTrack] = useState<boolean>();
  const chart = useRef<ECharts | null>(null);
  const [selection, setSelection] = useState<number | null>(null);
  const inlineChart = useRef<HTMLDivElement | null>(null);
  const fullButton = useRef<HTMLButtonElement>(null);
  const [inlineHeight, setInlineHeight] = useState(550);
  const query = useQuery(researchPriceQuery(ticker, runId, interval));
  const listingUnavailable = query.error instanceof ApiError && query.error.status === 404 &&
    query.error.message === "security-price-history-unavailable";
  const current = !listingUnavailable && query.data && !query.isPlaceholderData
    ? { data: query.data, ticker, interval, range, updatedAt: query.dataUpdatedAt } : undefined;
  const retained = useRetainedResult(current, (a, b) => a.data === b.data &&
    a.ticker === b.ticker && a.interval === b.interval && a.range === b.range && a.updatedAt === b.updatedAt);
  // A listing refusal also clears an earlier chart and its moment controls.
  const shown = listingUnavailable ? undefined : previousForIdentity(retained, retained?.ticker, ticker);
  const priceData = shown?.data;
  const unit = priceData?.currency;
  const priceFigure = (value: unknown, digits = 2) => quoteValue(value, unit, { style: "figure", digits });
  const displayedRange = shown?.range ?? range;
  useResearchChartWindow(ticker, "technical", displayedRange, priceData?.snapshotId ?? undefined);
  const displayedInterval = shown?.interval ?? interval;
  const updating = Boolean(shown && !current && !query.isError);
  const zoomKey = `tm-research-zoom:${ticker}:${displayedRange}:${displayedInterval}`;
  const savedZoom = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(zoomKey) ?? "null");
      if (
        saved &&
        Number.isFinite(saved.start) &&
        Number.isFinite(saved.end) &&
        saved.start >= 0 &&
        saved.end <= 100 &&
        saved.end > saved.start
      )
        return saved as { start: number; end: number };
    } catch {
      /* Storage can be disabled; chart interaction still works. */
    }
    return { start: 0, end: 100 };
  };
  const benchmark = useQuery({
    ...researchPriceQuery(comparison, runId, interval),
    enabled: comparison !== "none",
    retry: false,
  });
  const all = priceData?.points ?? [],
    sessions = [...new Set(all.map((p) => p.date.slice(0, 10)))];
  const points =
    displayedRange === "1D" || displayedRange === "5D"
      ? all.filter((p) =>
          sessions
            .slice(displayedRange === "1D" ? -1 : -5)
            .includes(p.date.slice(0, 10)),
        )
      : inRange(all, displayedRange as Range);
  const actualInterval = priceData?.actualInterval ?? displayedInterval;
  const isIntraday = actualInterval.endsWith("m"),
    dates = points.map((p) => p.date);
  const intradayDateFormatter = new Intl.DateTimeFormat(t("zh-CN", "en-GB"), {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: priceData?.timezone ?? "UTC",
  });
  const clockFormatter = new Intl.DateTimeFormat(t("zh-CN", "en-GB"), {
    hour: "2-digit", minute: "2-digit",
    timeZone: priceData?.timezone ?? "UTC",
  });
  const formatDate = (date: string) =>
    isIntraday
      ? intradayDateFormatter.format(new Date(date))
      : formatCalendarDate(date, locale);
  const benchmarkPoints = new Map(
    benchmark.data?.points.map((p) => [p.date, p]) ?? [],
  );
  const matched = points.filter((p) => benchmarkPoints.has(p.date));
  const comparable =
    comparison !== "none" &&
    benchmark.data?.currency === priceData?.currency &&
    benchmark.data?.actualInterval === priceData?.actualInterval &&
    matched.length > 1;
  const normalized = scale === "percent" || comparable,
    anchor = comparable ? matched[0] : points[0];
  const benchmarkAnchor = benchmarkPoints.get(anchor?.date)?.close;
  const bars = candleValues(points);
  const candle = style === "candles" && !normalized && bars.some((bar) => bar[0] != null);
  const marketDay = new Intl.DateTimeFormat("en-CA", { timeZone: priceData?.timezone ?? "UTC", dateStyle: "short" });
  const slots = priceSlots(points, actualInterval, (date) => marketDay.format(new Date(date)));
  const slotDates = slots.map((slot) => slot.date);
  const slotCandles = slots.map((slot) => slot.bar ? bars[slot.index] : [null, null, null, null]);
  const value = (price: number | null | undefined) =>
    price == null ? null : normalized ? price / anchor.close - 1 : price;
  const plottedCloses = slots.map((slot) => !slot.bar || (comparable && slot.date < anchor.date) || (candle && bars[slot.index][0] == null)
    ? null : value(slot.bar.close));
  const gapSeries = priceGapConnectors(plottedCloses);
  const visibleDays = new Set(dates.map((date) => date.slice(0, 10)));
  const markers = (priceData?.tradeMarkers ?? []).filter((m) => visibleDays.has(m.date.slice(0, 10)));
  const corporate = (priceData?.events ?? []).filter((e) => visibleDays.has(str(e.date).slice(0, 10)));
  const eventQuery = useQuery({ ...researchLensQuery(ticker, "analyst", runId), enabled: full || eventTrack === true, retry: false });
  const earnings = objects(object(eventQuery.data?.analyst ?? context?.analyst).earningsEvents).filter((e) => visibleDays.has(str(e.date).slice(0, 10)));
  const days = priceEventDays(markers, corporate, earnings);
  const [chartZoom, setChartZoom] = useState<{key: string; start: number; end: number}>();
  const visibleZoom = chartZoom?.key === zoomKey ? chartZoom : savedZoom();
  const span = Math.max(0, slotDates.length - 1);
  const low = Math.round(span * visibleZoom.start / 100), high = Math.round(span * visibleZoom.end / 100);
  const seriesId = priceData?.publishedSeriesId || priceData?.observedSeriesId;
  const published = current && actualInterval === "1d" && seriesId && eventTrack !== false;
  const moments = useKeyMoments(published ? {ticker: priceData!.ticker, published_series_id: seriesId} : null,
    slotDates[low]?.slice(0, 10), slotDates[high]?.slice(0, 10), priceData?.snapshotId ?? snapshotId);
  const showEvents = eventTrack ?? (full || markers.length > 0 || moments.items.length > 0);
  const desktop = useMediaQuery("(min-width: 768px)");
  const headroom = desktop && showEvents && moments.items.length ? markerHeadroom : 0;
  const baseHeight = full ? Math.max(450, typeof window === "undefined" ? 650 : window.innerHeight - 280)
    : (compactChart ? 260 : 410) + (rsi ? 125 : 0) + (macd ? 125 : 0);

  const momentPoints = moments.items.flatMap(m => {
    const index = slotDates.indexOf(m.date);
    const point = slots[index]?.bar;
    const high = point && (candle ? bars[slots[index].index][3] : plottedCloses[index]);
    return high == null ? [] : [{date: m.date, category: m.date, high}];
  });
  const labels = { change: t("涨跌", "Change"), volume: t("量", "Volume") };
  const shownAverages = averages ? (["sma20", "sma50", "sma200"] as const).filter((key) => averagePeriods.includes(key.slice(3))) : [];
  // Each average keeps its stroke: ink solid, grey dashed, ink dotted.
  const averageStroke = (i: number) => ({
    colour: [colours.text, colours.axis, colours.text][i],
    ...(i === 1 ? { dashed: true } : i === 2 ? { dotted: true } : {}),
  });
  const references = previousCloses(points, isIntraday, (date) => marketDay.format(new Date(date)));
  const multipleSessions = new Set(points.map((p) => marketDay.format(new Date(p.date)))).size > 1;
  const readingTime = (date: string) => isIntraday
    ? formatExchangeTime(date, priceData?.timezone, locale, multipleSessions)
    : formatCalendarDate(date, locale);
  // Pane under the pointer: its indicators come first so the card's four cells keep them.
  const panesShown = ["price", "volume", ...(rsi ? ["rsi"] : []), ...(macd ? ["macd"] : [])];
  const indicatorCells = (bar: (typeof points)[number], pane: string | undefined): ReadingItem[] => {
    const macdDigits = telling([quoteAmount(bar.macd, unit), quoteAmount(bar.macdSignal, unit)]);
    const cells = [
      ...(normalized ? [] : shownAverages.map((key, i) => ({
        pane: "price", label: "SMA " + key.slice(3), value: priceFigure(bar[key]), key: averageStroke(i),
      }))),
      ...(rsi ? [{ pane: "rsi", label: "RSI 14", value: fixed(bar.rsi14), key: { colour: colours.secondary } }] : []),
      ...(macd ? [
        { pane: "macd", label: "MACD", value: priceFigure(bar.macd, macdDigits), key: { colour: colours.text } },
        { pane: "macd", label: t("信号", "Signal"), value: priceFigure(bar.macdSignal, macdDigits), key: { colour: colours.axis, dashed: true } },
      ] : []),
    ];
    const ordered = [...cells.filter((cell) => cell.pane === pane), ...cells.filter((cell) => cell.pane !== pane)];
    return ordered.map(({ label, value, key }) => ({ label, value, key }));
  };
  const readPrice = (index: number, grid?: number): Reading => {
    const bar = slots[index].bar!;
    const pane = grid == null ? undefined : panesShown[grid];
    const indicators = indicatorCells(bar, pane);
    const time = readingTime(bar.date);
    if (!normalized) {
      return priceReading({
        bar, unit, previous: references[slots[index].index], time, candle, labels, indicators,
        volume: bar.volume == null ? undefined : volume(bar.volume, locale),
      });
    }
    const other = benchmarkPoints.get(bar.date)?.close;
    const ownChange = value(bar.close);
    const figures = comparisonFigures([
      { item: { label: ticker, key: { colour: colours.brand }, value: signedPercent(ownChange), tone: readingTone((ownChange ?? 0) * 100) }, change: ownChange },
      ...(comparable && benchmarkAnchor ? [{
        item: { label: comparison, key: { colour: colours.text, dashed: true }, value: signedPercent(other == null ? null : other / benchmarkAnchor - 1),
          tone: readingTone(other == null ? 0 : (other / benchmarkAnchor - 1) * 100) },
        change: other == null ? null : other / benchmarkAnchor - 1,
      }] : []),
    ], t("相差", "Difference"));
    // A single normalised line needs no label; a comparison keys both lines.
    const primary = comparable ? figures.primary : figures.primary && { value: figures.primary.value, tone: figures.primary.tone };
    return { time, primary, groups: [...(figures.groups ?? []), ...(indicators.length ? [indicators] : [])] };
  };
  const readMarks = (index: number): ReadingMark[] => {
    const bar = slots[index].bar;
    if (!bar) return [];
    const other = benchmarkPoints.get(bar.date)?.close;
    const at = (pane: string) => panesShown.indexOf(pane);
    return [
      ...(candle ? [] : [{ value: plottedCloses[index], colour: colours.brand }]),
      ...(comparable && benchmarkAnchor && other != null ? [{ value: other / benchmarkAnchor - 1, colour: colours.text }] : []),
      ...shownAverages.map((key, i) => ({ value: value(bar[key]), colour: averageStroke(i).colour })),
      ...(rsi ? [{ value: bar.rsi14, colour: colours.secondary, xAxisIndex: at("rsi"), yAxisIndex: at("rsi") }] : []),
      ...(macd ? [
        { value: bar.macd, colour: colours.text, xAxisIndex: at("macd"), yAxisIndex: at("macd") },
        { value: bar.macdSignal, colour: colours.axis, xAxisIndex: at("macd"), yAxisIndex: at("macd") },
      ] : []),
    ].flatMap((mark) => mark.value == null || !Number.isFinite(mark.value) ? [] : [{ ...mark, value: mark.value }]);
  };
  const zoom = (factor: number) => {
    const saved = savedZoom();
    const span = Math.min(100, Math.max(5, (saved.end - saved.start) * factor));
    const start = Math.max(0, Math.min(100 - span, (saved.start + saved.end - span) / 2));
    chart.current?.dispatchAction({ type: "dataZoom", start, end: start + span });
  };
  const reset = () => {
    try {
      sessionStorage.removeItem(zoomKey);
    } catch {
      /* Optional view preference. */
    }
    setSelection(null);
    chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
  };
  const toggleFull = (next: boolean) => {
    if (next && inlineChart.current)
      setInlineHeight(inlineChart.current.offsetHeight);
    const current = (
      chart.current?.getOption().dataZoom as
        | { start?: number; end?: number }[]
        | undefined
    )?.[0];
    if (current?.start != null && current.end != null) {
      try {
        sessionStorage.setItem(zoomKey, JSON.stringify(current));
      } catch {
        /* Optional view state. */
      }
    }
    update({
      chart: next ? "full" : null,
      ...(next
        ? {
            interval:
              requested && supportsPriceRange(requested, range)
                ? requested
                : interval,
          }
        : {}),
    });
  };
  const tools = (
    <div className="mx-price-tools">
      <Segments
        label={t("价格区间", "Price range")}
        value={range}
        onChange={(v) => {
          update({ priceRange: v, interval: full && supportsPriceRange(interval, v) ? interval : null });
          reset();
        }}
        options={ranges.filter((v) => full || compactPriceRanges.includes(v) || v === range)
          .map((v) => ({ value: v, label: v === "ALL" ? t("全部", "All") : v }))}
      />
      <Group gap="xs" className="mx-price-common">
        <Segments label={t("价格样式", "Price style")} value={style} onChange={(v) => update({ priceStyle: v })}
          options={[{ value: "candles", label: t("K 线", "Candles") }, { value: "line", label: t("线", "Line") }]} />
        <Checkbox size="xs" label="SMA" checked={averages}
          onChange={(e) => update({ ma: e.currentTarget.checked ? "on" : null, highlightMa: null })} />
        <Checkbox size="xs" label={t("事件", "Events")} checked={showEvents}
          onChange={(e) => setEventTrack(e.currentTarget.checked)} />
      </Group>
      {full && <details className="mx-price-advanced">
        <summary>{t("高级", "Advanced")}</summary>
        <Group gap="sm">
          <Select styles={fullSelectStyles} w={145} aria-label={t("行情粒度", "Bar interval")} value={interval}
            onChange={(v) => { update({ interval: v }); reset(); }}
            data={intervals.map((v, i) => ({
              value: v,
              label: [t("15 分钟", "15 min"), t("1 小时", "1 hour"), t("日线", "Daily"), t("周线", "Weekly")][i],
              disabled: !supportsPriceRange(v, range),
            }))} />
          <Select styles={fullSelectStyles} w={110} aria-label={t("纵轴", "Price axis")} value={scale} onChange={(v) => update({ priceScale: v })}
            data={[
              { value: "linear", label: t("线性", "Linear") },
              { value: "log", label: t("对数", "Log") },
              { value: "percent", label: t("涨跌幅", "Return %") },
            ]} />
          <Select styles={fullSelectStyles} w={165} aria-label={t("基准对比", "Benchmark comparison")} value={comparison}
            onChange={(v) => update({ benchmark: v === "none" ? null : v })}
            data={[
              { value: "none", label: t("加入对比", "Compare with") },
              { value: "SPY", label: "SPY · S&P 500 ETF" },
              { value: "QQQ", label: "QQQ · Nasdaq 100 ETF" },
              { value: "VT", label: "VT · Global stocks" },
            ]} />
          {averages && <Checkbox.Group aria-label={t("均线周期", "Average periods")}
            value={averagePeriods} onChange={(v) => update({ maPeriods: v.join(","), highlightMa: null, ma: v.length ? "on" : null })}>
            <Group gap="sm">
              {["20", "50", "200"].map((v) => <Checkbox key={v} size="xs" value={v} label={`SMA ${v}`} />)}
            </Group>
          </Checkbox.Group>}
          <Checkbox size="xs" label="RSI 14" checked={rsi} onChange={(e) => update({ rsi: e.currentTarget.checked ? "on" : null })} />
          <Checkbox size="xs" label="MACD 12/26/9" checked={macd} onChange={(e) => update({ macd: e.currentTarget.checked ? "on" : null })} />
          <Button component="a" href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`}
            target="_blank" rel="noreferrer" variant="subtle" size="compact-sm">TradingView ↗</Button>
        </Group>
      </details>}
    </div>
  );
  const content = (
    <>
      {tools}
      {listingUnavailable ? (
        <Empty title={t("暂无此上市证券的价格记录", "Price history unavailable for this listing")} />
      ) : query.isPending && !priceData ? (
        <Pending shape="chart" height={300} label={t("正在读取价格记录…", "Loading price records…")} />
      ) : query.isError && !priceData ? (
        <QueryError error={query.error} retry={query.refetch} />
      ) : !priceData || !points.length ? (
        <Empty
          title={t("当前区间没有行情", "No price history in this range")}
        />
      ) : (
        <>
          {query.isError && shown && <div className="mx-freshness-group">
            <Freshness date={dates.at(-1)} />
            <UpdateFailure updatedAt={shown.updatedAt} retry={query.refetch} />
          </div>}
          <div className="mx-data-body" aria-busy={updating || undefined}>
          {full && requested && requested !== interval && (
            <p role="status">
              {t(
                "所选范围不支持该粒度，已改用",
                "The selected range requires ",
              )}
              {
                {
                  "15m": t("15 分钟线", "15-minute bars"),
                  "60m": t("小时线", "hourly bars"),
                  "1d": t("日线", "daily bars"),
                  "1wk": t("周线", "weekly bars"),
                }[interval]
              }
            </p>
          )}
          {incompletePriceRange(dates, displayedRange) && (
            <p role="status">
              {t(
                "记录未覆盖整个所选范围",
                "History does not cover the full selected range",
              )}{" "}
              · {formatDate(points[0].date)} → {formatDate(points.at(-1)!.date)}
            </p>
          )}
          {priceData.coverageReason && (
            <p role="status">
              {t(
                "该粒度暂不可用，当前显示已有日线。",
                "This interval is unavailable. Available daily history is shown.",
              )}
            </p>
          )}
          {comparison !== "none" && !comparable && (
            <p role="status">
              {benchmark.isPending
                ? t("正在载入比较行情…", "Loading comparison…")
                : t(
                    "当前记录缺少同币种、同粒度的重合区间。",
                    "No matching currency, interval and common coverage for comparison.",
                  )}
            </p>
          )}
          {style === "candles" && !candle && !normalized && <p className="mx-price-caveat" role="status">
            {t("暂无 OHLC，仅显示收盘价", "OHLC unavailable; closing prices shown")}
          </p>}
          <Plot
            key={zoomKey}
            research
            customGestures
            initialSelection={selection}
            onSelectionChange={setSelection}
            readout={{
              positions: plottedCloses.flatMap((v, index) => v == null ? [] : [index]),
              latest: normalized ? signedPercent(value(points.at(-1)!.close)) : priceFigure(points.at(-1)!.close),
              gap: (index) => plottedCloses[Math.round(index)] == null,
              records: (index) => {
                const bar = slots[index].bar!;
                const actual = normalized ? [["close_return", value(bar.close)]]
                  : [["open", bar.open], ["high", bar.high], ["low", bar.low], ["close", bar.close], ["volume", bar.volume]];
                if (comparable && benchmarkAnchor) {
                  const b = benchmarkPoints.get(bar.date);
                  if (b) actual.push([comparison + "_return", b.close / benchmarkAnchor - 1]);
                }
                return actual.flatMap(([series, number]) => typeof number !== "number" ? [] : [{
                  time: bar.date, zone: isIntraday ? priceData.timezone ?? "UTC" : "UTC",
                  currency: series === "volume" ? "" : normalized ? "%" : priceData.currency,
                  basis: normalized ? "fractional return" : priceData.adjustment,
                  source: series === comparison + "_return" ? benchmark.data?.source ?? "Price comparison" : priceData.source,
                  gapType: index > 0 && plottedCloses[index - 1] == null ? "after-missing-bar" : "",
                  series: String(series), value: number,
                }]);
              },
              read: (index, context) => readPrice(index, context?.grid),
              marks: readMarks,
            }}
            overlay={showEvents && moments.items.length > 0 && <MomentOverlay chart={chart} moments={moments} points={momentPoints} range={displayedRange} />}
            controller={chart}
            onZoom={(instance) => {
              const current = (
                instance.getOption().dataZoom as
                  | { start?: number; end?: number }[]
                  | undefined
              )?.[0];
              if (current?.start != null && current.end != null) {
                setChartZoom({key: zoomKey, start: current.start, end: current.end});
                try {
                  sessionStorage.setItem(
                    zoomKey,
                    JSON.stringify({ start: current.start, end: current.end }),
                  );
                } catch {
                  /* Optional view preference. */
                }
              }
            }}
            label={`${ticker} · ${t("价格、成交量和技术指标", "Price, volume and indicators")}`}
            height={baseHeight}
            option={(c) => {
              const panes = [
                "price",
                "volume",
                ...(rsi ? ["rsi"] : []),
                ...(macd ? ["macd"] : []),
              ];
              const extra = panes.length - 2,
                mainHeight = 67 - extra * 12;
              // One volume tick at the period high keeps the 10% pane readable.
              const volumeTop = Math.max(0, ...points.map((p) => p.volume ?? 0)) || undefined;
              const positions = [
                { top: 3, height: mainHeight },
                { top: 6 + mainHeight, height: 10 },
                ...Array.from({ length: extra }, (_, i) => ({
                  top: 20 + mainHeight + i * 16,
                  height: 13,
                })),
              ];
              const series: SeriesOption[] = [
                candle
                  ? candleSeries(ticker, slotCandles, c)
                  : {
                      type: "line",
                      name: ticker,
                      data: plottedCloses,
                      showSymbol: points.length < 3,
                      connectNulls: false,
                      lineStyle: { width: 2, color: c.brand },
                      areaStyle: normalized || points.length < 3
                        ? undefined
                        : { color: c.brand, opacity: 0.04 },
                    },
              ];
              if (comparable && benchmarkAnchor)
                series.push({
                  type: "line",
                  name: comparison,
                  showSymbol: false,
                  connectNulls: false,
                  data: slots.map(({ date, bar }) => {
                    const b = benchmarkPoints.get(date);
                    return !bar || date < anchor.date || !b
                      ? null
                      : b.close / benchmarkAnchor - 1;
                  }),
                  lineStyle: { color: c.text, width: 1.6, type: "dashed" },
                });
              if (averages)
                (["sma20", "sma50", "sma200"] as const)
                  .filter((key) => averagePeriods.includes(key.slice(3)))
                  .forEach((key, i) =>
                    series.push({
                      type: "line",
                      name:
                        key.toUpperCase() +
                        (actualInterval === "1d"
                          ? t(" · 日线", " · daily")
                          : t(" · ", " · ") + actualInterval),
                      showSymbol: false,
                      connectNulls: false,
                      data: slots.map(({ bar }) => value(bar?.[key])),
                      lineStyle: {
                        color: [c.text, c.axis, c.text][i],
                        type: ["solid", "dashed", "dotted"][i] as "solid" | "dashed" | "dotted",
                        width: selectedMa === key ? 2.5 : 1.2,
                        opacity: selectedMa && selectedMa !== key ? 0.3 : 1,
                      },
                    }),
                  );
              series.push({
                type: "bar",
                name: t("成交量", "Volume"),
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: slots.map(({ bar }) => bar?.volume ?? null),
                itemStyle: { color: c.axis, opacity: 0.52 },
                barMaxWidth: 14,
              });
              if (rsi) {
                const index = panes.indexOf("rsi");
                series.push({
                  type: "line",
                  name: "RSI 14",
                  xAxisIndex: index,
                  yAxisIndex: index,
                  data: slots.map(({ bar }) => bar?.rsi14 ?? null),
                  connectNulls: false,
                  showSymbol: false,
                  lineStyle: { color: c.secondary, width: 1.4 },
                  markLine: {
                    silent: true,
                    symbol: "none",
                    lineStyle: { color: c.axis, type: "dashed", opacity: 0.5 },
                    data: [{ yAxis: 30 }, { yAxis: 70 }],
                    label: { show: false },
                  },
                });
              }
              if (macd) {
                const index = panes.indexOf("macd");
                series.push(
                  ...(["macd", "macdSignal"] as const).map(
                    (key, i): SeriesOption => ({
                      type: "line",
                      name: i ? t("信号", "Signal") : "MACD",
                      xAxisIndex: index,
                      yAxisIndex: index,
                      data: slots.map(({ bar }) => bar?.[key] ?? null),
                      connectNulls: false,
                      showSymbol: false,
                      lineStyle: { color: i ? c.axis : c.text, width: 1.4, type: i ? "dashed" : "solid" },
                    }),
                  ),
                  {
                    type: "bar",
                    name: t("MACD 柱值", "MACD histogram"),
                    xAxisIndex: index,
                    yAxisIndex: index,
                    data: slots.map(({ bar }) => ({
                      value: bar?.macdHistogram ?? null,
                      itemStyle: {
                        color:
                          (bar?.macdHistogram ?? 0) < 0 ? c.negative : c.positive,
                        opacity: 0.5,
                      },
                    })),
                    barMaxWidth: 10,
                  },
                );
              }
              const eventDay = params.get("eventDate");
              const eventIndex =
                eventDay &&
                eventDay >= dates[0]?.slice(0, 10) &&
                eventDay <= dates.at(-1)!.slice(0, 10)
                  ? slotDates.findIndex((d) => d.slice(0, 10) >= eventDay)
                  : -1;
              if (
                eventIndex >= 0 &&
                series[0] &&
                (series[0].type === "line" || series[0].type === "candlestick")
              ) {
                series[0].markLine = {
                  silent: true,
                  symbol: "none",
                  lineStyle: { color: c.axis, type: "dashed" },
                  label: {
                    show: true,
                    formatter: eventDay ?? "",
                    position: "insideEndTop",
                  },
                  data: [{ xAxis: slotDates[eventIndex] }],
                };
              }
              if (gapSeries.length) series.push({
                id: "history-gap:price", type: "line", data: gapSeries,
                silent: true, tooltip: { show: false }, showSymbol: false, connectNulls: false,
                lineStyle: { color: c.axis, type: "dotted", width: 1.5 },
                emphasis: { disabled: true },
              });
              return {
                grid: positions.map((p) => ({
                  left: 64,
                  right: 24,
                  top: headroom ? headroom + (baseHeight - headroom) * p.top / 100 : p.top + "%",
                  height: headroom ? (baseHeight - headroom) * p.height / 100 : p.height + "%",
                })),
                axisPointer: { link: [{ xAxisIndex: "all" }] },
                xAxis: panes.map((_, i) => ({
                  type: "category",
                  data: slotDates,
                  gridIndex: i,
                  boundaryGap: candle,
                  axisLine: { show: false },
                  axisTick: { show: false },
                  axisLabel: {
                    show: i === panes.length - 1,
                    hideOverlap: true,
                    padding: [0, 8],
                    color: c.axis,
                    formatter: (d: string) =>
                      isIntraday && dates[0]?.slice(0, 10) === dates.at(-1)?.slice(0, 10)
                        ? clockFormatter.format(new Date(d))
                        : formatDate(d),
                  },
                })),
                yAxis: panes.map((pane, i) => ({
                  type:
                    pane === "price" && scale === "log" && !normalized
                      ? "log"
                      : "value",
                  gridIndex: i,
                  // Volume bars start at zero; a scaled axis exaggerates small changes.
                  scale: pane !== "volume",
                  min: pane === "rsi" || pane === "volume" ? 0 : undefined,
                  max: pane === "rsi" ? 100 : pane === "volume" ? volumeTop : undefined,
                  interval: pane === "volume" ? volumeTop : undefined,
                  splitNumber: pane === "price" ? 4 : pane === "volume" ? 1 : 2,
                  name:
                    pane === "price" || pane === "volume"
                      ? ""
                      : pane.toUpperCase(),
                  nameTextStyle: { color: c.axis, fontSize: 11 },
                  axisLabel: {
                    color: c.axis,
                    // Stacked panes sit close together: the lower pane's top label would collide.
                    showMinLabel: pane !== "volume" && i === panes.length - 1 ? undefined : false,
                    formatter: (v: number) =>
                      pane === "volume"
                        ? t("量 ", "Vol ") + compactTick(v, locale)
                        : pane === "price" && normalized ? percent(v) : pane === "rsi" ? compactTick(v, locale) : compactTick(quoteAmount(v, unit), locale),
                  },
                  splitLine: {
                    show: pane !== "volume",
                    lineStyle: { color: c.grid, type: "dashed" },
                  },
                })),
                dataZoom: [
                      {
                        type: "inside",
                        xAxisIndex: panes.map((_, i) => i),
                        ...savedZoom(),
                        disabled: true,
                        zoomOnMouseWheel: false,
                        moveOnMouseWheel: false,
                      },
                      ...(full ? [{
                        type: "slider" as const,
                        xAxisIndex: panes.map((_, i) => i),
                        bottom: 0,
                        height: 18,
                        showDetail: false,
                        borderColor: c.grid,
                        ...savedZoom(),
                      }] : []),
                    ],
                series,
              };
            }}
          />
          {/* A single series needs no legend; a comparison names both lines. */}
          {comparable && (
            <Legend
              items={[{ label: ticker }, { label: comparison, colour: "var(--mx-ink)", dashed: true }]}
            />
          )}
          {gapSeries.length > 0 && <Legend items={[{ label: t("缺失行情", "Missing price bars"), colour: "var(--mx-muted)", dotted: true }]} />}
          <div className="mx-chart-footer mx-price-footer">
            <Group gap={4} aria-label={t("图表缩放", "Chart zoom")}>
              <Button variant="default" size="compact-sm" aria-label={t("放大", "Zoom in")} onClick={() => zoom(0.65)}>+</Button>
              <Button variant="default" size="compact-sm" aria-label={t("缩小", "Zoom out")} onClick={() => zoom(1.55)}>−</Button>
              <Button variant="subtle" size="compact-sm" onClick={reset}>{t("恢复范围", "Reset zoom")}</Button>
            </Group>
            <span>
              {isIntraday
                ? formatDate(points[0].date) + " → " + formatDate(points.at(-1)!.date)
                : formatDateSpan(points[0].date, points.at(-1)!.date, locale)}
            </span>
          </div>
          {moments.coverage}
          {showEvents && <PriceEventTrack moments={moments}
            days={full || eventTrack === true ? days : days.filter((day) => day.marker)}
            openEarnings={(event) => update({ view: "analyst", analystView: "events", eventId: event.id, eventDate: event.date, chart: null })}
          />}
          <details className="mx-chart-data">
            <summary>
              {t("行情与指标明细", "Price & indicator records")}
            </summary>
            <EvidenceTable
              key={displayedRange + displayedInterval}
              label={t("价格记录", "Price records")}
              rows={[...points].reverse()}
              columns={[
                { label: t("时间", "Time"), value: (p) => formatDate(p.date) },
                ...(
                  [
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    "rsi14",
                    "macd",
                    "macdSignal",
                  ] as const
                ).map((key, i) => ({
                  label: [
                    "Open",
                    "High",
                    "Low",
                    "Close",
                    "Volume",
                    "RSI 14",
                    "MACD",
                    "Signal",
                  ][i],
                  numeric: true,
                  value: (p: (typeof points)[number]) =>
                    key === "volume" ? number(p.volume, 0) : key === "rsi14" ? number(p.rsi14, 2) : priceFigure(p[key]),
                })),
              ]}
            />
          </details>
          </div>
        </>
      )}
    </>
  );
  return (
    <>
      <Panel
        bare={compactChart}
        className={compactChart ? "mx-tech-chart" : undefined}
        title={[t("价格走势", "Price history"), quoteUnit(unit).currency].filter(Boolean).join(" · ")}
        action={<Button ref={fullButton} variant="default" size="compact-sm" onClick={() => toggleFull(true)}>{t("完整图表", "Full chart")}</Button>}
        help={<>
          <p>{t(
            "均线与指标按当前 K 线粒度计算：RSI 14 使用 Wilder 平滑，MACD 为 12/26/9。交易和公司事件另列于时间轴，不把当日收盘价当成交价。读数里的涨跌相对前一根 K 线的收盘价，盘中相对前一交易日的最后一根。",
            "Indicators use the selected bar interval: Wilder RSI 14, MACD 12/26/9. Trades and company events have a separate track; a close is not an execution price. A reading's change is from the previous bar's close, or intraday from the previous session's last bar.",
          )}</p>
          <DataBasis>{t(
            "拆股及分红调整后的价格，币种见标题；盘中 K 线按交易所当地时间。比较按同币种、同粒度和共同起点归一化；点线表示缺失的行情。",
            "Split- and dividend-adjusted prices in the currency shown in the title; intraday bars use the exchange's local time. Comparisons share currency, interval and starting time; dotted lines mark missing bars.",
          )}</DataBasis>
        </>}
      >
        <div
          ref={inlineChart}
          style={full ? { height: inlineHeight } : undefined}
        >
          {!full && content}
        </div>
      </Panel>
      <Modal
        fullScreen
        opened={full}
        onClose={() => toggleFull(false)}
        returnFocus={false}
        onExitTransitionEnd={() => fullButton.current?.focus({ preventScroll: true })}
        closeButtonProps={{ "aria-label": t("退出全屏", "Exit fullscreen"), size: 44 }}
        title={ticker + " · " + t("完整图表", "Full chart")}
      >
        <div className="mx-full-chart">{full && content}</div>
      </Modal>
    </>
  );
}
