"use client";

import { ChartColumnIncreasing, ChevronRight, RotateCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import type { SeriesOption } from "echarts";
import type { CSSProperties, MouseEvent } from "react";
import { useLayoutEffect, useRef } from "react";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { useComputedColorScheme } from "@/components/color-scheme-provider";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import { sampleLine } from "@/lib/portfolio/line-sampling";
import { historyGapSeries } from "@/lib/portfolio/series";
import { formatCalendarDate, formatCurrency, formatDate, formatDateTime, formatDeltaPercent, formatNumber, formatPercent, formatReadingTime } from "@/ui/formatters";
import { useChartColours } from "@/ui/charts/palette";
import type { ChartReadout, Reading } from "./chart-readout";
import { comparisonFigures, fixed } from "./reading-format";
import { quoteUnit, quoteValue } from "./financial-values";
import { EvidenceTable } from "./evidence-table";
import { ChartRecords, ChartRecordsPanel, ChartRecordsTrigger } from "./chart-records";
import { DataBasis } from "./reading-card";
import { api, isReadTimeout, readApi } from "@/workspace/data";
import { Empty, Help, Pending, QueryError, Segments, TextLink, useCopy } from "./foundation";
import { useGlobalContribution, type GlobalMarketContribution } from "./global-markets-data";
import Link from "./link";
import { IndexBreadthPanel, IndexValuationPanel, IndexVixPanel } from "./market-index-depth";
import {
  alignIndices, comparable, indexHistoryRows, indexHref, researchIndexHref, useIndexCatalog,
  type IndexContext, type IndexContribution, type IndexHistory, type IndexIdentity, type IndexMarket,
  type IndexQuote, type IndexRange, type IndexScope,
} from "./market-indices-data";
import { heatMix, sparkline } from "./sectors-data";
import { SearchPicker } from "./picker";

const IndexDrawdownChart = dynamic(() => import("./index-drawdown-chart").then((module) => module.IndexDrawdownChart));
const Plot = dynamic(() => import("./charts").then((module) => module.Plot));

function useNames() {
  const t = useCopy();
  return {
    name: (index: IndexIdentity) => t(index.nameZh, index.name),
    basis: (index: IndexIdentity) => ({
      "price": index.kind === "etf-price" ? t("ETF 价格", "ETF price") : t("价格指数", "Price return"),
      "total-return": t("总回报", "Total return"),
      "net-return": t("净回报", "Net return"),
      "implied-volatility": t("隐含波动率", "Implied volatility"),
    })[index.basis],
  };
}

const GLOBAL_GROUPS = [
  { name: ["全球", "Global"], ids: ["msci-acwi"] },
  { name: ["发达", "Developed"], ids: ["msci-world", "msci-world-ex-usa"] },
  { name: ["新兴", "Emerging"], ids: ["msci-em", "msci-em-imi"] },
] as const;

const GLOBAL_PRICE_PROXIES = new Set(["ftse-all-world-etf"]);

const GLOBAL_CARD_NAMES: Record<string, string> = {
  "msci-acwi": "MSCI ACWI",
  "msci-world": "MSCI World",
  "msci-world-ex-usa": "MSCI World ex USA",
  "msci-em": "MSCI EM",
  "msci-em-imi": "MSCI EM IMI",
};

function RetryIndices({ retry, busy }: { retry: () => void; busy?: boolean }) {
  const t = useCopy();
  return (
    <button type="button" className="mx-index-retry" disabled={busy} onClick={retry}>
      <RotateCw size={16} aria-hidden="true" />{t("重试", "Retry")}
    </button>
  );
}

export function IndexStrip({ market, open, selected, marketName, globalClock }: {
  market: IndexScope;
  open: (event: MouseEvent<HTMLAnchorElement>, index: IndexIdentity) => void;
  selected?: string | null;
  marketName?: string;
  globalClock?: Pick<GlobalMarketContribution, "asOf" | "referenceDate" | "phase" | "acwiMove" | "acwiLevel" | "pricesStale"> | null;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const query = useQuery({
    queryKey: ["market-indices", market],
    queryFn: ({ signal }) => api<IndexMarket>(`/indices?scope=${market}`, { signal }),
    refetchInterval: 60_000,
    staleTime: 60_000,
    retry: 0,
  });
  const regions = useGlobalContribution(market === "global" && !selected && globalClock === undefined);
  const global = globalClock === undefined ? regions.data : globalClock;
  const newest = (query.data?.quotes ?? []).map((quote) => quote.asOf ?? "").sort().at(-1);
  const error = query.isError || query.data?.refreshFailed;
  const card = (quote: IndexQuote) => (
    <IndexCard
      key={quote.index.id}
      quote={quote}
      selected={selected === quote.index.id}
      open={open}
      nameOverride={market === "global" ? GLOBAL_CARD_NAMES[quote.index.id] : undefined}
      primaryBenchmark={market === "global" && !selected && quote.index.id === "msci-acwi"}
      globalBenchmark={market === "global"}
    />
  );
  if (market === "global") {
    const quotes = new Map(query.data?.quotes.map((quote) => [quote.index.id, quote]));
    const acwi = quotes.get("msci-acwi");
    const stamp = global?.asOf ?? acwi?.asOf ?? newest;
    const phase = global?.pricesStale ? t("最近报价", "Latest quote")
      : global?.phase === "completed" ? t("已收盘", "Closed")
      : global?.phase === "live" ? t("盘中", "Open") : t("最近报价", "Latest quote");
    const day = global?.referenceDate;
    // A finished global day is named by its MSCI date; the publication clock belongs to another day here.
    const closedDay = day && !global?.pricesStale && global?.phase === "completed" ? day : null;
    const time = stamp && formatDate(stamp, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
    if (acwi && global?.acwiMove != null) {
      quotes.set(acwi.index.id, {
        ...acwi, change: global.acwiMove, level: global.acwiLevel, asOf: global.asOf,
        state: global.pricesStale ? "stale" : global.phase === "completed" ? "closed" : "live",
        points: acwi.points?.filter(({ at }) => global.asOf != null && Date.parse(at) <= Date.parse(global.asOf)),
      });
    }
    return <section className="mx-index-strip mx-index-global" aria-label={t("市场指数", "Market indices")}>
      {(stamp || error) && <div className="mx-index-stamp mx-sectors-clock">
        {stamp && <>
          <span>{phase}</span>
          <span>{closedDay
            ? <time dateTime={closedDay}>{formatCalendarDate(closedDay, locale)}</time>
            : <time dateTime={stamp}>{t("截至 ", "As of ")}{global?.phase === "live" && !global.pricesStale
              ? time : formatDateTime(stamp, locale, timeZone)}</time>}</span>
        </>}
        {global?.pricesStale && <span>{t("全球报价未更新", "Global quotes haven’t updated")}</span>}
        {error && <><span>{stamp ? t("部分指数未更新", "Some indices haven’t updated") : t("暂时无法读取指数", "Indices are unavailable")}</span>
          <RetryIndices busy={query.isFetching} retry={() => void query.refetch()} /></>}
      </div>}
      {query.isPending && <Pending label={t("正在加载指数", "Loading indices")} compact />}
      {quotes.size > 0 && <div className="mx-global-benchmarks">
        {GLOBAL_GROUPS.map(({ name, ids }) => <section className="mx-global-benchmark" key={name[1]}>
          <h2>{t(name[0], name[1])}</h2>
          <div>{ids.map((id) => {
            const quote = quotes.get(id);
            return quote && card(quote);
          })}</div>
        </section>)}
        {[...quotes.values()].some(({ index }) => GLOBAL_PRICE_PROXIES.has(index.id)) && <details className="mx-global-benchmark mx-global-proxy">
          <summary>{t("ETF 市价代理", "ETF price proxies")}</summary>
          <div>{[...quotes.values()].filter(({ index }) => GLOBAL_PRICE_PROXIES.has(index.id)).map(card)}</div>
        </details>}
      </div>}
    </section>;
  }
  return (
    <section className="mx-index-strip" aria-label={t("市场指数", "Market indices")}>
      {marketName && <h2 className="mx-index-scope">{marketName}</h2>}
      {query.isPending ? <Pending label={t("正在加载指数", "Loading indices")} compact /> : null}
      {query.data && <details className="mx-index-directory" open={!marketName || undefined}>
        <summary>{t("全部指数", "All indices")}</summary>
        {(["official", "proxy"] as const).map((kind) => {
          const group = query.data.quotes.filter(({ index }) => (index.kind === "etf-price") === (kind === "proxy"));
          return group.length > 0 && <section key={kind} className="mx-index-group">
            <h3>{kind === "proxy" ? t("ETF 市价代理", "ETF price proxies") : t("官方指数", "Official indices")}</h3>
            <div className="mx-index-cards">{group.map(card)}</div>
          </section>;
        })}
      </details>}
      {(newest || error) && <div className="mx-index-stamp">
        {newest && <time dateTime={newest}>{t("指数截至 ", "Indices as of ")}{formatDateTime(newest, locale, timeZone)}</time>}
        {error && <>
          <span>{newest ? t("部分报价未更新", "Some quotes haven’t updated") : t("暂时无法读取指数", "Indices are unavailable")}</span>
          <RetryIndices busy={query.isFetching} retry={() => void query.refetch()} />
        </>}
      </div>}
    </section>
  );
}

function IndexCard({ quote, open, selected, nameOverride, primaryBenchmark, globalBenchmark = false }: {
  quote: IndexQuote;
  open: (event: MouseEvent<HTMLAnchorElement>, index: IndexIdentity) => void;
  selected: boolean;
  nameOverride?: string;
  primaryBenchmark?: boolean;
  globalBenchmark?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const { name, basis } = useNames();
  const { index } = quote;
  const points = quote.points ?? [];
  const start = points[0];
  const timeStart = start ? Date.parse(start.at) : 0;
  const timeEnd = points.length ? Date.parse(points[points.length - 1].at) : timeStart;
  const line = sparkline(
    points.map(({ value }) => start ? value / start.value - 1 : null),
    points.map(({ at }) => timeEnd === timeStart ? 0 : (Date.parse(at) - timeStart) / (timeEnd - timeStart)),
    200, 25, 2,
  );
  const move = index.kind === "volatility" ? pointsText(quote.change, locale, t("点", "pts"))
    : formatDeltaPercent(quote.change, locale, 2);
  const level = index.kind === "volatility" && quote.level != null
    ? `${formatNumber(quote.level, locale, { maximumFractionDigits: 2 })} ${t("点", "pts")}`
    : index.kind === "etf-price" ? quoteValue(quote.level, index.currency, { locale })
    : formatNumber(quote.level, locale, { maximumFractionDigits: 2, minimumFractionDigits: nameOverride ? 2 : undefined });
  const tone = index.kind === "volatility" || quote.change == null || quote.change === 0
    ? "neutral" : quote.change > 0 ? "up" : "down";
  const scheme = useComputedColorScheme();
  const freshness = quote.state === "stale" ? t("未更新", "Stale")
    : quote.index.rights === "licensed-source-required" ? t("暂无授权报价", "No licensed quote")
      : quote.state === "unavailable" ? t("无报价", "No quote") : null;
  const notice = quote.calendarKnown === false ? t("日历未知", "Calendar unknown") : freshness;
  const sparkTone = tone === "up" ? "text-gain" : tone === "down" ? "text-loss" : "text-muted-foreground";
  return (
    <Link
      href={indexHref(index)}
      prefetch={false}
      onClick={(event) => open(event, index)}
      id={`index-card-${index.id}`}
      className={cn(
        "mx-index-card tm-heat-surface relative grid min-w-0 rounded-[var(--radius-heat-tile)] border border-border text-foreground no-underline hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight] max-[767px]:snap-start",
        selected && "outline-2 -outline-offset-2 outline-link focus-visible:outline-offset-2 focus-visible:outline-ring",
        primaryBenchmark && "min-[768px]:border-border-strong",
        globalBenchmark
          ? "grid-rows-[auto_auto_25px] gap-2 px-3 pb-2 pt-2.5 max-[1179px]:min-[768px]:px-2 max-[959px]:min-[768px]:grid-rows-[18px_auto_21px] max-[767px]:min-h-11 max-[767px]:grid-rows-[auto_auto] max-[767px]:content-center max-[767px]:gap-px max-[767px]:rounded-none max-[767px]:border-0 max-[767px]:border-b max-[767px]:border-border max-[767px]:bg-transparent max-[767px]:px-[5px] max-[767px]:py-[3px]"
          : "grid-rows-[auto_auto_25px] gap-[7px] px-3 pb-[7px] pt-2.5",
      )}
      data-tone={tone}
      data-benchmark={primaryBenchmark ? "primary" : undefined}
      aria-current={selected ? "page" : undefined}
      style={{ "--mx-heat-mix": heatMix(tone === "neutral" ? null : quote.change, scheme) } as CSSProperties}
    >
      <span
        className={cn(
          "mx-index-name flex min-w-0 items-center justify-between gap-1.5 font-semibold",
          globalBenchmark
            ? "text-[14px] max-[1179px]:min-[768px]:block max-[1179px]:min-[768px]:truncate max-[1179px]:min-[768px]:text-[12px] max-[767px]:text-[12px] max-[767px]:leading-[1.25]"
            : "text-[13px]",
        )}
      >
        {nameOverride ?? (index.basis === "total-return" ? `${name(index)} · ${basis(index)}` : name(index))}
        {!globalBenchmark && <ChevronRight size={16} className="-mx-[1.5px] flex-none" aria-hidden="true" />}
      </span>
      <span
        className={cn(
          "mx-index-figures flex items-baseline justify-between gap-1.5",
          globalBenchmark
            ? "flex-wrap max-[1179px]:min-[768px]:flex-nowrap max-[1179px]:min-[768px]:gap-[3px] max-[959px]:min-[768px]:flex-col max-[959px]:min-[768px]:gap-px max-[767px]:flex-nowrap"
            : "flex-wrap",
        )}
      >
        <strong
          className={cn(
            "font-[650] leading-[1.1] tabular-nums max-[767px]:font-semibold",
            globalBenchmark
              ? "text-[22px] max-[1179px]:min-[768px]:text-[clamp(13px,1.65vw,19px)] max-[767px]:text-[15px]"
              : "text-[21px] max-[767px]:text-[20px]",
          )}
        >
          {level}
        </strong>
        <span
          className={cn(
            "tabular-nums",
            globalBenchmark ? "text-[13px] max-[1179px]:min-[768px]:text-[12px]" : "text-[13px]",
          )}
        >
          {move}
        </span>
      </span>
      <span className={cn("mx-index-spark relative", sparkTone, globalBenchmark && "max-[767px]:hidden")}>
        {points.length > 1 && (
          <svg
            className={cn("h-full stroke-current [stroke-width:1.5px]", globalBenchmark ? "w-[72%]" : "w-full")}
            aria-hidden="true"
            viewBox="0 0 200 25"
            preserveAspectRatio="none"
          >
            <path d={line.path} fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </span>
      {notice && (
        <small
          className={cn(
            "mx-index-freshness rounded bg-muted px-1 text-[12px] text-foreground",
            globalBenchmark ? "absolute bottom-[7px] right-2 max-[767px]:static max-[767px]:justify-self-start" : "absolute bottom-[7px] right-2",
          )}
        >
          {notice}
        </small>
      )}
    </Link>
  );
}

function pointsText(value: number | null | undefined, locale: ReturnType<typeof useLocale>["locale"], unit: string) {
  return value == null ? "—" : `${formatNumber(value, locale, { maximumFractionDigits: 2, signDisplay: "exceptZero" })} ${unit}`;
}

type PlotRow = { at: string; left?: number | null; right?: number | null };
type PlotLine = ReturnType<typeof buildIndexPlotLine>;
const indexLines = new WeakMap<readonly PlotRow[], Map<string, PlotLine>>();

function buildIndexPlotLine(rows: readonly PlotRow[], key: "left" | "right", width: number) {
  const data: Array<{ value: [number, number | null]; symbolSize: number }> = [];
  let observed = 0, missing = false;
  rows.forEach((row, i) => {
    const value = row[key];
    if (value === undefined) return;
    if (value == null) missing = true;
    else observed++;
    data.push({ value: [i, value], symbolSize: 6 });
  });
  return {
    visible: sampleLine(data, width, (point) => point.value[0], (point) => point.value[1]),
    gaps: missing ? historyGapSeries(data) : [],
    single: observed === 1,
  };
}

function indexPlotLine(rows: readonly PlotRow[], key: "left" | "right", width: number) {
  let set = indexLines.get(rows);
  if (!set) indexLines.set(rows, set = new Map());
  const id = key + width;
  let line = set.get(id);
  if (!line) set.set(id, line = buildIndexPlotLine(rows, key, width));
  return line;
}

export function IndexDetail({ id, market, period: requestedPeriod, gbp, comparison, update, phone }: {
  id: string;
  market: IndexScope;
  period: IndexRange;
  gbp: boolean;
  comparison: string | null;
  update: (changes: Record<string, string | null>) => void;
  phone: boolean;
}) {
  useChartRuntime();
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const colours = useChartColours();
  const { name, basis } = useNames();
  const title = useRef<HTMLHeadingElement>(null);
  const lastFocused = useRef<string | null>(null);
  const client = useQueryClient();
  const catalog = useIndexCatalog();
  const cachedHistory = client.getQueriesData<IndexHistory>({ queryKey: ["index-history", id] })
    .filter(([, value]) => value?.index.scope === market && value.points?.length)
    .sort(([a], [b]) => (client.getQueryState(b)?.dataUpdatedAt ?? 0) - (client.getQueryState(a)?.dataUpdatedAt ?? 0));
  const index = catalog.data?.find((item) => item.id === id && item.scope === market)
    ?? cachedHistory[0]?.[1]?.index
    ?? client.getQueryData<IndexMarket>(["market-indices", market])?.quotes.find((quote) => quote.index.id === id)?.index;
  const hasHistory = Boolean(index?.ranges.length && (index.symbol || index.source === "EODHD"));
  const targetPeriod = !index?.ranges.length || index.ranges.includes(requestedPeriod)
    ? requestedPeriod : index.ranges.at(-1)!;
  const peers = (catalog.data ?? []).filter((item) => index && comparable(index, item, gbp, targetPeriod));
  const peer = peers.find((item) => item.id === comparison);
  const incompatiblePeer = !peer && catalog.data?.find((item) => item.id === comparison);
  const historyQuery = (identifier?: string) => ({
    queryKey: ["index-history", identifier, targetPeriod, gbp],
    queryFn: ({ signal }: { signal: AbortSignal }) => readApi<IndexHistory>(
      `/indices/${identifier}/history?range=${targetPeriod}&currency=${gbp ? "GBP" : "local"}`, signal,
    ),
    enabled: Boolean(identifier && hasHistory),
    staleTime: 60_000,
    refetchInterval: targetPeriod === "1D" ? 60_000 : false as const,
    retry: 0,
  });
  const query = useQuery(historyQuery(index?.id));
  const peerQuery = useQuery(historyQuery(peer?.id));
  useLayoutEffect(() => {
    if (!index || (hasHistory && query.isPending) || lastFocused.current === id) return;
    const frame = requestAnimationFrame(() => {
      const heading = title.current;
      if (!heading?.getClientRects().length) return;
      if (!heading.closest(".mx-index-detail")?.contains(document.activeElement)) {
        heading.focus({ preventScroll: true });
      }
      lastFocused.current = id;
    });
    return () => cancelAnimationFrame(frame);
  }, [id, index, hasHistory, query.isPending]);
  if (!index) {
    if (catalog.isSuccess) return <Empty title={t("没有这个市场指数", "Index not found in this market")}
      description={t("从市场的全部指数中选择其他指数。", "Choose another index from the market’s index list.")} />;
    return <div className="mx-index-detail"><section className="mx-panel mx-index-history">
      <div className="mx-index-title"><h2 ref={title} tabIndex={-1}>{id}</h2></div>
      {catalog.isError ? <QueryError retry={catalog.refetch} error={catalog.error} showDataStatusLink={false} />
        : <Pending label={t("正在加载指数", "Loading index")} />}
    </section></div>;
  }
  // Keep the last reading for this index while the new basis loads. A chart
  // can only compare responses for the same range and currency.
  const requestedHistory = query.data?.points?.length ? query.data : undefined;
  const requestedPeer = peerQuery.data;
  const holdPreviousPair = Boolean(peer && (peerQuery.isPending || peerQuery.isError ||
    requestedPeer?.state === "unavailable"));
  const priorPair = peer && holdPreviousPair ? cachedHistory.find(([key, history]) => {
    const other = client.getQueryData<IndexHistory>(["index-history", peer.id, key[2], key[3]]);
    return other?.points?.length && other.currency === history?.currency;
  }) : undefined;
  const history = priorPair?.[1] ?? requestedHistory ?? cachedHistory[0]?.[1] ?? query.data;
  const historyKey = (priorPair ?? cachedHistory.find(([, value]) => value === history))?.[0];
  const peerHistory = peer && historyKey ? client.getQueryData<IndexHistory>(
    ["index-history", peer.id, historyKey[2], historyKey[3]],
  ) : requestedPeer;
  const period = history?.range ?? targetPeriod;
  const seriesCurrency = history?.currency ?? (gbp ? "GBP" : index.currency);
  const showingPrevious = Boolean(history?.points?.length && (history !== query.data || holdPreviousPair));
  const points = history?.points ?? [];
  const matched = history && peerHistory && history.range === peerHistory.range &&
    history.currency === peerHistory.currency ? alignIndices(history, peerHistory, period) : [];
  const lastPaired = matched.findLastIndex(({ left, right }) => left != null && right != null);
  const commonEnd = lastPaired > 0 ? matched[lastPaired] : undefined;
  const seriesReturn = (value: number | undefined | null) => formatDeltaPercent(value == null ? null : value / 100 - 1, locale, 2);
  const fundPrice = !matched.length && index.kind === "etf-price";
  const levelText = (value: number | null | undefined) => fundPrice
    ? quoteValue(value, seriesCurrency, { style: "figure" }) : fixed(value);
  const readingUnit = index.kind === "volatility" ? t("点", "pts")
    : fundPrice ? quoteUnit(seriesCurrency).currency : seriesCurrency;
  const error = query.error ?? peerQuery.error;
  const plotRows = matched.length ? matched : history ? indexHistoryRows(history) : [];
  const shortRange = period === "1W" || period === "1M";
  const intraday = period === "1D" || shortRange;
  const axisDateOptions: Intl.DateTimeFormatOptions = period === "MAX" ? { year: "numeric", timeZone: "UTC" }
    : period === "1D" ? { hour: "2-digit", minute: "2-digit", timeZone }
      : { month: "short", day: "numeric", ...(period.endsWith("Y") ? { year: "2-digit" } : {}), timeZone: intraday ? timeZone : "UTC" };
  const chartName = name(index);
  const peerName = peer ? name(peer) : "";
  // Select a small number of x-axis labels before formatting any dates.
  // A numeric slot axis keeps 50,000 category strings out of the renderer.
  const count = Math.min(plotRows.length, phone ? 4 : 8);
  const ticks = [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (plotRows.length - 1) / Math.max(1, count - 1))))];
  const axisLabels = new Map(ticks.map((position) => [position, formatDate(plotRows[position].at, locale, axisDateOptions)]));
  // Levels stay in ink without a unit (the axis names it); a comparison rebased to 100 says so once,
  // keys the index as the solid primary line and the peer as a grey dash, and ends with the difference.
  const readPoint = (position: number): Reading | null => {
    const row = plotRows[position];
    if (!row || (row.left == null && row.right == null)) return null;
    const time = formatReadingTime(row.at, locale, intraday ? timeZone : "UTC", period === "1D" ? "clock" : intraday ? "intraday" : "day");
    if (!matched.length) return { time, primary: { value: levelText(row.left) } };
    return {
      time: time + " · " + t("起点归 100", "Rebased to 100"),
      ...comparisonFigures([
        { item: { label: chartName, key: { colour: colours.brand }, value: fixed(row.left) }, change: row.left == null ? null : row.left / 100 - 1 },
        { item: { label: peerName, key: { colour: colours.comparison, dashed: true }, value: fixed(row.right) }, change: row.right == null ? null : row.right / 100 - 1 },
      ], t("相差", "Difference")),
    };
  };
  const chartLabel = matched.length
    ? locale === "zh" ? `${chartName} 与 ${peerName}，起点归 100` : `${chartName} and ${peerName}, rebased to 100`
    : chartName;
  const primaryPositions = plotRows.reduce<number[]>((positions, row, position) => {
    if (row.left != null || row.right != null) positions.push(position);
    return positions;
  }, []);
  const latestIndexRow = plotRows.findLast((row) => row.left != null);
  const indexReadout: ChartReadout = {
    positions: primaryPositions,
    latest: latestIndexRow?.left != null ? levelText(latestIndexRow.left) : "—",
    read: readPoint,
    marks: (position: number) => {
      const row = plotRows[position];
      return [
        ...(row?.left == null ? [] : [{ value: row.left, colour: colours.brand }]),
        ...(row?.right == null || !matched.length ? [] : [{ value: row.right, colour: colours.comparison }]),
      ];
    },
    records: (position: number) => {
      const row = plotRows[position];
      return ([["left", chartName, history], ["right", peerName, peerHistory]] as const).flatMap(([key, series, feed]) =>
        row?.[key] == null ? [] : [{
          time: row.at, zone: intraday ? timeZone : "UTC",
          currency: matched.length || index.kind === "volatility" ? "" : seriesCurrency ?? "",
          basis: matched.length ? "rebased to 100" : index.basis,
          source: feed?.index?.source ?? index.source ?? "Index provider",
          gapType: plotRows[position - 1]?.[key] === null ? "after-missing-observation" : "",
          series, value: row[key]!,
        }]);
    },
    gap: (position: number) => {
      const row = plotRows[Math.round(position)];
      return !row || (row.left == null && row.right == null);
    },
  };
  const retry = () => {
    void query.refetch();
    if (peer) void peerQuery.refetch();
  };
  return (
    <div className="mx-index-detail">
      <ChartRecords>
      <section className="mx-panel mx-index-history">
        <div className="mx-index-title">
          <h2 ref={title} tabIndex={-1}>{chartName}</h2>
          <Help label={t("指数数据与口径", "Index data and basis")}>
              <p>{index.symbol ?? index.compiler} · {index.kind === "volatility" ? t("波动率点数", "Volatility points") : seriesCurrency}</p>
              {index.kind === "etf-price" && <p>{t("这里显示基金上市价格。它可能偏离所跟踪的指数。", "This is the listed fund price. It can differ from its benchmark.")}</p>}
              {!hasHistory && index.rights === "licensed-source-required" && <p>{t("暂无获授权的指数报价。", "An authorised source is required for index prices.")}</p>}
              {period === "1D" && <p>{t("显示最近交易日的 5 分钟线。", "5-minute bars for the latest trading session.")}</p>}
              {shortRange && <p>{period === "1W"
                ? t("显示近 7 天的 30 分钟线。", "30-minute bars over the last seven days.")
                : t("显示近一个月的小时线。", "Hourly bars over the last calendar month.")} {t("回撤使用图中价格，年化波动率使用已结束工作日的最后一个价格。英镑换算使用同频率的汇率。", "Drawdown uses the plotted bars. Annualised volatility uses the last reading of each completed weekday. GBP conversion uses FX bars at the same interval.")}</p>}
              {period === "MAX" && history?.sourceInterval === "1d" && history.displayInterval === "1wk" &&
                <p>{t("从最早日线开始，每周保留最后一个交易日的读数。回撤和波动率按显示的读数计算。", "History starts at the earliest daily observation and displays each week’s last close. Risk figures use the plotted observations.")}</p>}
              {!intraday && history?.displayInterval === "1d" && <p>{history?.hourlyClose
                ? t("日线取自纽约时间 17:00 的小时线。", "Daily values come from the 17:00 New York hourly bar.")
                : null} {t("回撤和年化波动率使用完整日线。英镑换算使用此前已完成的汇率日线。", "Drawdown and annualised volatility use completed daily bars. GBP conversion uses the most recent prior daily FX close.")}</p>}
              {matched.length > 0 && (intraday || period === "MAX") && <p>{period === "MAX"
                ? t("对比使用同一日历周内的读数，周线的结束日可能不同。", "Comparison uses readings from the same calendar week; bar end dates can differ.")
                : t("对比使用同一时间段内的读数。", "Comparison uses readings within the same time slot.")}</p>}
              <DataBasis>{basis(index)}{index.source ? ` · ${index.source}` : ""} · {index.compiler}</DataBasis>
          </Help>
          <div className="mx-index-title-action">
            <TextLink href={researchIndexHref(index)}>
              <ChartColumnIncreasing size={16} aria-hidden="true" />
              {t("查看研究", "View research")}
            </TextLink>
          </div>
        </div>
        {hasHistory && <div className="mx-index-controls">
          {index.ranges.length > 1 && <Segments label={t("时间范围", "Range")} value={targetPeriod}
            options={index.ranges.map((value) => ({ value, label: value === "MAX" ? t("全部", "All") : value }))}
            onChange={(value) => update({ range: value === "1Y" ? null : value })} />}
          {index.currency && index.currency !== "GBP" && <Segments label={t("币种", "Currency")} value={gbp ? "GBP" : "local"}
            options={[{ value: "local", label: index.currency }, { value: "GBP", label: "GBP" }]}
            onChange={(value) => update({ currency: value === "GBP" ? "GBP" : null })} />}
          {peers.length > 0 && <SearchPicker
            className="mx-index-compare"
            aria-label={t("比较指数", "Compare with index")}
            placeholder={t("比较指数", "Compare with index")}
            options={peers.map((item) => ({ value: item.id, label: name(item) }))}
            value={peer?.id ?? null}
            onChange={(value) => update({ compare: value })}
            clearable
          />}
        </div>}
        {!points.length && !hasHistory && index.rights === "licensed-source-required"
          ? <Empty title={t("官方指数走势需要授权数据", "Official index history requires a licensed source")}
              description={t("当前工作区没有获授权的指数报价。可查看基金市价走势；它不同于基金净值或官方指数总回报。", "This workspace has no licensed index feed. The ETF’s listed price is available as a proxy and differs from its NAV and the official index total return.")}
              action={index.id === "ftse-all-world" && <Link className="mx-text-link" href="/sectors?market=global&index=ftse-all-world-etf">
                {t("查看富时全球 ETF 市价代理", "View FTSE All-World ETF price proxy")}
              </Link>} />
          : !points.length && hasHistory && query.isPending
            ? <Pending label={t("正在加载走势", "Loading index history")} />
            : !points.length && !query.isError
              ? <Empty title={t("此范围没有走势", "No history for this range")}
                  description={t("行情源未返回此范围的读数。选择其他时间范围，或稍后重试。", "The source returned no readings for this range. Choose another range or retry later.")} />
              : null}
        {history?.coverageReason === "source-interval-mismatch" &&
          <p className="mx-form-help">{t("数据源未返回日线。已保留原始频率：", "The provider did not return daily bars. Reported interval: ")}
            {history.sourceInterval ?? t("未知", "unknown")}</p>}
        {history?.coverageReason === "daily-coverage-incomplete" &&
          <p className="mx-form-help">{t("此区间的日线覆盖不完整。", "Daily history is incomplete for this range.")}</p>}
        {incompatiblePeer && <p className="mx-index-note">{name(incompatiblePeer)} · {t("当前币种或时段无法比较。切回共同口径可恢复对比。", "Unavailable for this currency or range. Switch back to a shared basis to restore the comparison.")}</p>}
        {points.length > 0 && <Plot fullscreen label={chartLabel} height={phone ? 235 : 300}
          inlineActions={<ChartRecordsTrigger label={t("查看精确读数", "View exact values")} placement="actions" />}
          readout={indexReadout}
          option={(colours) => {
            const lines = [{ key: "left" as const, label: chartName, colour: colours.brand, dashed: false }];
            const compared = matched.length ? [{ key: "right" as const, label: peerName, colour: colours.comparison, dashed: true }] : [];
            return {
              animation: false,
              grid: { top: 17, right: 18, bottom: 31, left: 58 },
              xAxis: {
                type: "value", min: 0, max: Math.max(1, plotRows.length - 1), minInterval: 1,
                axisLabel: { customValues: ticks, formatter: (position) => axisLabels.get(position) ?? "" },
                axisTick: { show: false },
                splitLine: { show: false },
              },
              yAxis: { type: "value", scale: true, splitNumber: phone ? 4 : 5,
                axisLabel: fundPrice ? { formatter: (v: number) => quoteValue(v, seriesCurrency, { style: "number" }) } : undefined,
                name: matched.length ? undefined : readingUnit ?? undefined, nameGap: 5 },
              series: [...lines, ...compared].flatMap(({ key, label, colour, dashed }): SeriesOption[] => {
                const { visible, gaps, single } = indexPlotLine(plotRows, key, phone ? 270 : 800);
                return [{
                  id: key, name: label, type: "line", data: [...visible], connectNulls: false,
                  showSymbol: single,
                  lineStyle: { width: 2, color: colour, type: dashed ? "dashed" : "solid" },
                  itemStyle: { color: colour },
                }, ...(gaps.length ? [{
                  id: `history-gap:${key}`, type: "line" as const, data: gaps,
                  silent: true, tooltip: { show: false }, showSymbol: false, connectNulls: false,
                  lineStyle: { color: colour, width: 1.5, type: "dotted" as const, opacity: 0.65 },
                  emphasis: { disabled: true },
                }] : [])];
              }),
            };
          }} />}
        {matched.length > 0 && peer && <div className="mx-index-legend">
          <span>{chartName} <strong>{seriesReturn(commonEnd?.left)}</strong></span>
          <span>{name(peer)} <strong>{seriesReturn(commonEnd?.right)}</strong></span>
          <span>{t("区间收益 · 起点归 100", "Period return · Rebased to 100")}</span>
        </div>}
        {peer && !matched.length && !peerQuery.isPending && !peerQuery.isError && <p className="mx-index-note">{t("没有可比较的共同日期。请选择其他时间范围。", "No common observations to compare. Choose another range.")}</p>}
        <div className="mx-index-stamp">
          {history?.asOf && <time dateTime={history.asOf}>{t("截至 ", "Through ")}{intraday
            ? formatDateTime(history.asOf, locale, timeZone)
            : formatDate(new Date(history.asOf), locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</time>}
          {(!!history?.gaps?.length || (matched.length > 0 && !!peerHistory?.gaps?.length)) && <span>{t("历史数据不完整", "Partial history")}</span>}
          {showingPrevious && (query.isFetching || peerQuery.isFetching) && <span role="status">{t("正在更新，显示上一次走势", "Updating · showing previous chart")} · {period}</span>}
          {(error || query.data?.state === "stale" || (index.symbol && query.data?.state === "unavailable") || requestedPeer?.state === "unavailable") &&
            <><span role="status">{isReadTimeout(error)
              ? t("走势请求超时", "History request timed out") : t("走势未能更新", "History did not update")}
              {showingPrevious && <> · {t("上一次走势", "Previous chart")} · {period}</>}</span><RetryIndices retry={retry} busy={query.isFetching || peerQuery.isFetching} /></>}
        </div>
        <dl className="mx-index-metrics">
          <div><dt>{t("最大回撤", "Max drawdown")}</dt><dd>{formatPercent(history?.maxDrawdown, locale, 2)}</dd></div>
          <div><dt>{t("年化波动率", "Annualised volatility")}</dt><dd>{formatPercent(history?.volatility, locale, 2)}</dd></div>
        </dl>
        {plotRows.length > 0 && <ChartRecordsPanel>
          <EvidenceTable chart key={period + chartLabel + seriesCurrency} label={chartLabel} rows={plotRows} columns={[
            { label: t("时间", "Time"), value: (row) => formatReadingTime(row.at, locale, intraday ? timeZone : "UTC", intraday ? "intraday" : "day") },
            { label: matched.length ? chartName : [chartName, readingUnit].filter(Boolean).join(" · "), numeric: true, value: (row) => levelText(row.left) },
            ...(matched.length ? [
              { label: peerName, numeric: true, value: (row: (typeof plotRows)[number]) => fixed(row.right) },
              { label: t("相差（百分点）", "Difference (percentage points)"), numeric: true, value: (row: (typeof plotRows)[number]) => row.left == null || row.right == null ? "—" : fixed(row.left - row.right) },
            ] : []),
          ]} />
        </ChartRecordsPanel>}
        {history && <IndexDrawdownChart history={history} />}
      </section>
      </ChartRecords>
      <IndexContextPanels id={index.id} phone={phone} />
    </div>
  );
}

function IndexContextPanels({ id, phone }: { id: string; phone: boolean }) {
  const query = useQuery({
    queryKey: ["index-context", id],
    queryFn: ({ signal }) => readApi<IndexContext>(`/indices/${id}/context`, signal),
    refetchInterval: 4 * 60_000,
    staleTime: 60_000,
    retry: 0,
  });
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (query.isPending) return <Pending compact />;
  if (query.isError) return <QueryError retry={query.refetch} error={query.error} showDataStatusLink={false} />;
  const context = query.data;
  const basket = context.basket;
  return (
    <>
      {basket && <section className="mx-panel mx-index-basket">
        <div className="mx-index-title">
          <h3>{t("成分篮子", "Constituent basket")} · {basket.fund}</h3>
          <span>{basket.proxyUniverse && `${basket.proxyUniverse} · `}
            {!basket.proxyUniverse && basket.asOf
              ? formatDateTime(basket.asOf, locale, timeZone) : formatCalendarDate(basket.holdingsDate, locale)}</span>
          <Help label={t("篮子口径", "Constituent basket basis")}>
            <p>{basket.proxyUniverse
              ? t("这是该市场板块使用的 MSCI 篮子，不是本指数的成分或权重。", "This is the MSCI basket used by the market’s sector board. Its holdings and weights are not the index’s own.")
              : basket.estimatedMove != null
                ? t("贡献是成分权重乘以当日涨跌，单位为百分点。缺少报价的权重保留为空；残差只比较同一时段的指数报价。", "Contributions are weights multiplied by session moves, in percentage points. Unpriced weights stay missing. The residual uses an index quote from the same session and time.")
                : t("仅显示发行商公布的成分篮子权重。", "Only weights from the issuer’s constituent basket are shown.")}</p>
            <p>{basket.sourceUrl
              ? <><a href={basket.sourceUrl} target="_blank" rel="noreferrer" className="mx-text-link">{basket.fund}</a> · </>
              : null}{t("持仓日期", "Holdings dated")} {formatCalendarDate(basket.holdingsDate, locale)}
              {basket.holdingsFetchedAt && <> · {t("抓取于", "Retrieved")} {formatDateTime(basket.holdingsFetchedAt, locale, timeZone)}</>}</p>
            {basket.estimatedMove != null && basket.fetchedAt && <p>{(basket.pricesSource ?? "Yahoo Finance").replace("IEX real-time / SIP", t("IEX 实时 / SIP", "IEX real-time / SIP"))} · {t("抓取于", "Retrieved")} {formatDateTime(basket.fetchedAt, locale, timeZone)}</p>}
          </Help>
        </div>
        {!basket.proxyUniverse && basket.estimatedMove != null && <><dl className="mx-index-metrics">
          <div><dt>{t("上涨", "Up")}</dt><dd>{basket.coverage > 0 ? basket.breadth.up : "—"}</dd></div>
          <div><dt>{t("持平", "Flat")}</dt><dd>{basket.coverage > 0 ? basket.breadth.flat : "—"}</dd></div>
          <div><dt>{t("下跌", "Down")}</dt><dd>{basket.coverage > 0 ? basket.breadth.down : "—"}</dd></div>
          <div><dt>{t("已报价权重", "Priced weight")}</dt><dd>{formatPercent(basket.coverage || null, locale, 1)}</dd></div>
          <div><dt>{t("篮子涨跌", "Basket move")}</dt><dd>{formatDeltaPercent(basket.estimatedMove, locale, 2)}</dd></div>
          <div><dt>{t("残差", "Residual")}</dt><dd>{pointsText(basket.residual == null ? null : basket.residual * 100, locale, t("百分点", "pp"))}</dd></div>
        </dl>
        <div className="mx-index-contributors">
          <ContributionList title={t("正贡献", "Top contributors")} items={basket.leaders} />
          <ContributionList title={t("负贡献", "Top detractors")} items={basket.laggards} />
        </div></>}
        <details className="mx-details"><summary>{basket.estimatedMove != null
          ? t("板块权重与贡献", "Sector weights and contribution") : t("板块权重", "Sector weights")}</summary>
          <ContributionList items={basket.sectors} showWeight showContribution={basket.estimatedMove != null} />
        </details>
        <details className="mx-details"><summary>{t("前十大成分", "Top ten constituents")}</summary>
          <ContributionList items={basket.topHoldings} showWeight showContribution={basket.estimatedMove != null} />
        </details>
      </section>}
      {context.breadthHistory && <IndexBreadthPanel history={context.breadthHistory} stale={!!context.breadthStale} phone={phone} />}
      {context.vix && <IndexVixPanel vix={context.vix} stale={!!context.vixStale} />}
      {context.valuationReference && <IndexValuationPanel snapshot={context.valuation} reference={context.valuationReference} />}
      <section className="mx-panel mx-index-holdings">
        <div className="mx-index-title">
          <h3>{t("我持有的跟踪 ETF", "Tracking ETFs I hold")}</h3>
          {context.portfolioAsOf && <span>{formatDateTime(context.portfolioAsOf, locale, timeZone)}</span>}
        </div>
        {context.funds?.length ? <>
          <dl className="mx-index-metrics"><div><dt>{t("合并敞口", "Combined exposure")}</dt><dd>{formatCurrency(context.exposureGbp, locale)}</dd></div></dl>
          <ul className="mx-index-funds">
            {context.funds.map((fund) => <li key={fund.isin}>
              <Link href={`/research?ticker=${encodeURIComponent(fund.ticker)}&view=tracking`} className="mx-text-link">{fund.ticker}</Link>
              <span>{fund.name}</span>
              <span>{fund.shares == null ? "—" : `${formatNumber(fund.shares, locale)} ${formatNumber(fund.shares, locale) === "1" ? t("份", "share") : t("份", "shares")}`}</span>
              <strong>{formatCurrency(fund.valueGbp, locale)}</strong>
              <Link href={`/research?ticker=${encodeURIComponent(fund.ticker)}&view=fundamentals`} className="mx-text-link">{t("穿透持仓", "Look through")}</Link>
            </li>)}
          </ul>
        </> : <p className="mx-index-note">{t("未找到基准已确认的持仓。", "No holdings with a confirmed benchmark.")}</p>}
      </section>
    </>
  );
}

function ContributionList({ title, items, showWeight = false, showContribution = true }: {
  title?: string; items: IndexContribution[]; showWeight?: boolean; showContribution?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  return (
    <div>
      {title && <h4>{title}</h4>}
      <ul className="mx-index-contribution-list">
        {items.length ? items.map((item) => <li key={item.key}>
          <span>{item.name}</span>
          {showWeight && <span>{formatPercent(item.weight, locale, 2)}</span>}
          {showContribution && <strong>{pointsText(item.contribution == null ? null : item.contribution * 100, locale, t("百分点", "pp"))}</strong>}
        </li>) : <li>—</li>}
      </ul>
    </div>
  );
}
