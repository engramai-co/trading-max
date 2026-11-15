"use client";

import { Select } from "@mantine/core";
import { ArrowClockwise, CaretRight } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import type { SeriesOption } from "echarts";
import type { CSSProperties, MouseEvent } from "react";
import { useLayoutEffect, useRef } from "react";
import { useLocale } from "@/components/locale-provider";
import { historyGapSeries } from "@/lib/portfolio/series";
import { formatCalendarDate, formatCurrency, formatDate, formatDateTime, formatDeltaPercent, formatNumber, formatPercent } from "@/ui/formatters";
import { api, isReadTimeout, readApi } from "@/workspace/data";
import { Empty, Help, Pending, QueryError, Segments, useCopy } from "./foundation";
import { useGlobalContribution, type GlobalMarketContribution } from "./global-markets-data";
import Link from "./link";
import { IndexBreadthPanel, IndexValuationPanel, IndexVixPanel } from "./market-index-depth";
import {
  alignIndices, comparable, indexHistoryRows, indexHref, researchIndexHref, useIndexCatalog,
  type IndexContext, type IndexContribution, type IndexHistory, type IndexIdentity, type IndexMarket,
  type IndexQuote, type IndexRange, type IndexScope,
} from "./market-indices-data";
import { sparkline } from "./sectors-data";

const Plot = dynamic(() => import("./charts").then((module) => module.Plot));

function useNames() {
  const t = useCopy();
  return {
    name: (index: IndexIdentity) => t(index.nameZh, index.name),
    basis: (index: IndexIdentity) => ({
      "price": index.kind === "etf-price" ? t("ETF 价格", "ETF price") : t("价格指数", "Price index"),
      "total-return": t("全收益指数", "Total return index"),
      "net-return": t("净回报指数", "Net return index"),
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
      <ArrowClockwise size={14} aria-hidden="true" />{t("重试", "Retry")}
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
  const card = (quote: IndexQuote) => <IndexCard key={quote.index.id} quote={quote} selected={selected === quote.index.id} open={open}
    nameOverride={market === "global" ? GLOBAL_CARD_NAMES[quote.index.id] : undefined}
    primaryBenchmark={market === "global" && !selected && quote.index.id === "msci-acwi"} />;
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

function IndexCard({ quote, open, selected, nameOverride, primaryBenchmark }: {
  quote: IndexQuote;
  open: (event: MouseEvent<HTMLAnchorElement>, index: IndexIdentity) => void;
  selected: boolean;
  nameOverride?: string;
  primaryBenchmark?: boolean;
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
    : index.kind === "etf-price" && index.currency ? formatCurrency(quote.level, locale, index.currency)
    : formatNumber(quote.level, locale, { maximumFractionDigits: 2, minimumFractionDigits: nameOverride ? 2 : undefined });
  const tone = index.kind === "volatility" || quote.change == null || quote.change === 0
    ? "neutral" : quote.change > 0 ? "up" : "down";
  const heat = Math.min(1, Math.abs(quote.change ?? 0) / 0.03);
  const freshness = quote.state === "stale" ? t("未更新", "Stale")
    : quote.index.rights === "licensed-source-required" ? t("暂无授权报价", "No licensed quote")
      : quote.state === "unavailable" ? t("无报价", "No quote") : null;
  const notice = quote.calendarKnown === false ? t("日历未知", "Calendar unknown") : freshness;
  return (
    <div className="mx-index-card-stack">
    <Link
      href={indexHref(index)}
      prefetch={false}
      onClick={(event) => open(event, index)}
      id={`index-card-${index.id}`}
      className="mx-index-card"
      data-tone={tone}
      data-benchmark={primaryBenchmark ? "primary" : undefined}
      aria-current={selected ? "page" : undefined}
      style={{ "--mx-index-heat": `${Math.round(heat * 22 + (heat > 0 ? 5 : 0))}%` } as CSSProperties}
    >
      <span className="mx-index-name">
        {nameOverride ?? (index.basis === "total-return" ? `${name(index)} · ${basis(index)}` : name(index))}
        <CaretRight size={13} aria-hidden="true" />
      </span>
      <span className="mx-index-figures"><strong>{level}</strong><span>{move}</span></span>
      <span className="mx-index-spark">
        {points.length > 1 && <svg aria-hidden="true" viewBox="0 0 200 25" preserveAspectRatio="none">
          <path d={line.path} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>}
      </span>
      {notice && <small className="mx-index-freshness">{notice}</small>}
    </Link>
    <Link className="mx-text-link mx-index-to-research" href={researchIndexHref(index)} prefetch={false}
      aria-label={name(index) + " · " + t("在研究台打开", "Open in research")}>
      {t("在研究台打开", "Open in research")}
    </Link>
    </div>
  );
}

function pointsText(value: number | null | undefined, locale: ReturnType<typeof useLocale>["locale"], unit: string) {
  return value == null ? "—" : `${formatNumber(value, locale, { maximumFractionDigits: 2, signDisplay: "exceptZero" })} ${unit}`;
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
  const t = useCopy();
  const { locale, timeZone } = useLocale();
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
  const context = useQuery({
    queryKey: ["index-context", index?.id],
    queryFn: ({ signal }) => readApi<IndexContext>(`/indices/${index?.id}/context`, signal),
    enabled: !!index,
    refetchInterval: 4 * 60_000,
    staleTime: 60_000,
    retry: 0,
  });
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
  const pairedEnds = matched.filter(({ left, right }) => left != null && right != null);
  const commonEnd = pairedEnds.length > 1 ? pairedEnds.at(-1) : undefined;
  const seriesReturn = (value: number | undefined | null) => formatDeltaPercent(value == null ? null : value / 100 - 1, locale, 2);
  const readingUnit = index.kind === "volatility" ? t("点", "pts") : seriesCurrency;
  const error = query.error ?? peerQuery.error;
  const plotRows = matched.length ? matched : history ? indexHistoryRows(history) : [];
  const shortRange = period === "1W" || period === "1M";
  const intraday = period === "1D" || shortRange;
  const axisDateOptions: Intl.DateTimeFormatOptions = period === "MAX" ? { year: "numeric", timeZone: "UTC" }
    : period === "1D" ? { hour: "2-digit", minute: "2-digit", timeZone }
      : { month: "short", day: "numeric", ...(period.endsWith("Y") ? { year: "2-digit" } : {}), timeZone: intraday ? timeZone : "UTC" };
  const dateOptions: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "short", day: "numeric",
    ...(intraday ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone } : { timeZone: "UTC" }),
  };
  const chartName = name(index);
  const peerName = peer ? name(peer) : "";
  const sparseAxis = shortRange || period === "MAX";
  const axisLabels = plotRows.map(({ at }) => formatDate(new Date(at), locale, axisDateOptions));
  const firstInPeriod = axisLabels.flatMap((label, i) => i === 0 || label !== axisLabels[i - 1] ? [i] : []);
  const labelStep = Math.ceil(firstInPeriod.length / (phone ? 5 : 8));
  const ticks = new Set(firstInPeriod.filter((_, i) => i % labelStep === 0));
  if (sparseAxis && firstInPeriod.length > 1) {
    // Pin the final date to the end without printing that date twice.
    ticks.delete(firstInPeriod.at(-1)!);
    ticks.add(plotRows.length - 1);
  }
  const readPoint = (position: number) => {
    const row = plotRows[position];
    if (!row || (row.left == null && row.right == null)) return "";
    const reading = (label: string, value: number) =>
      `${label}: ${formatNumber(value, locale, { maximumFractionDigits: 2 })}${matched.length || !readingUnit ? "" : " " + readingUnit}`;
    return [
      formatDate(new Date(row.at), locale, dateOptions),
      ...(row.left == null ? [] : [reading(chartName, row.left)]),
      ...(row.right == null ? [] : [reading(peerName, row.right)]),
    ].join("\n");
  };
  const chartLabel = matched.length
    ? locale === "zh" ? `${chartName} 与 ${peerName}，起点归 100` : `${chartName} and ${peerName}, rebased to 100`
    : chartName;
  const primaryPositions = plotRows.flatMap((row, position) => row.left === undefined ? [] : [position]);
  const retry = () => {
    void query.refetch();
    if (peer) void peerQuery.refetch();
  };
  return (
    <div className="mx-index-detail">
      <section className="mx-panel mx-index-history">
        <div className="mx-index-title">
          <h2 ref={title} tabIndex={-1}>{chartName}</h2>
          <div className="mx-index-provenance">
            <Link className="mx-text-link" href={researchIndexHref(index)}>
              {t("在研究台打开", "Open in research")}
            </Link>
            <span>{index.kind === "volatility" ? t("波动率点数", "Volatility points") : seriesCurrency} · {index.symbol ?? index.compiler}</span>
            <Help label={t("指数数据与口径", "Index data and basis")}>
              <p>{basis(index)}{index.source ? ` · ${index.source}` : ""} · {index.compiler}</p>
              {index.kind === "etf-price" && <p>{t("这里显示基金上市价格。它可能偏离所跟踪的指数。", "This is the listed fund price. It can differ from its benchmark.")}</p>}
              {!hasHistory && index.rights === "licensed-source-required" && <p>{t("暂无获授权的指数报价。", "An authorised source is required for index prices.")}</p>}
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
            </Help>
          </div>
        </div>
        {hasHistory && <div className="mx-index-controls">
          {index.ranges.length > 1 && <Segments label={t("时间范围", "Range")} value={targetPeriod}
            options={index.ranges.map((value) => ({ value, label: value === "MAX" ? t("全部", "All") : value }))}
            onChange={(value) => update({ range: value === "1Y" ? null : value })} />}
          {index.currency && index.currency !== "GBP" && <Segments label={t("币种", "Currency")} value={gbp ? "GBP" : "local"}
            options={[{ value: "local", label: index.currency }, { value: "GBP", label: "GBP" }]}
            onChange={(value) => update({ currency: value === "GBP" ? "GBP" : null })} />}
          {peers.length > 0 && <Select
            size="xs"
            className="mx-index-compare"
            aria-label={t("比较指数", "Compare index")}
            placeholder={t("比较指数", "Compare index")}
            data={peers.map((item) => ({ value: item.id, label: name(item) }))}
            value={peer?.id ?? null}
            onChange={(value) => update({ compare: value })}
            clearable
            searchable
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
              ? <Empty title={t("此范围没有可用的走势", "No history for this range")}
                  description={t("行情源未返回此范围的读数。选择其他时间范围，或稍后重试。", "The source returned no readings for this range. Choose another range or retry later.")} />
              : null}
        {history?.coverageReason === "source-interval-mismatch" &&
          <p className="mx-form-help">{t("数据源未返回日线。已保留原始频率：", "The provider did not return daily bars. Reported interval: ")}
            {history.sourceInterval ?? t("未知", "unknown")}</p>}
        {history?.coverageReason === "daily-coverage-incomplete" &&
          <p className="mx-form-help">{t("此区间的日线覆盖不完整。", "Daily history is incomplete for this range.")}</p>}
        {incompatiblePeer && <p className="mx-index-note">{name(incompatiblePeer)} · {t("当前币种或时段无法比较。切回共同口径可恢复对比。", "Unavailable for this currency or range. Switch back to a shared basis to restore the comparison.")}</p>}
        {points.length > 0 && <Plot label={chartLabel} height={phone ? 235 : 300}
          readPoint={(position) => readPoint(primaryPositions[position])}
          option={(colours) => {
            const lines = [{ key: "left" as const, label: chartName, colour: colours.text, dashed: false }];
            const compared = matched.length ? [{ key: "right" as const, label: peerName, colour: colours.axis, dashed: true }] : [];
            return {
              animation: false,
              grid: { top: 17, right: 18, bottom: 31, left: 58 },
              xAxis: {
                type: "category", boundaryGap: false, data: plotRows.map(({ at }) => at),
                axisLabel: {
                  formatter: (_at, position) => !sparseAxis || ticks.has(position) ? axisLabels[position] : "",
                  ...(sparseAxis ? { interval: (position: number) => ticks.has(position) } : {}),
                },
              },
              yAxis: { type: "value", scale: true, splitNumber: phone ? 4 : 5,
                name: matched.length ? undefined : readingUnit ?? undefined, nameGap: 5 },
              tooltip: { trigger: "axis", formatter: (input) => {
                const rows = Array.isArray(input) ? input : [input];
                const row = rows.find((entry) => !String(entry.seriesId).startsWith("history-gap:"));
                const position = Array.isArray(row?.value) ? row.value[0] : undefined;
                return typeof position === "number" ? readPoint(position) : "";
              } },
              series: [...lines, ...compared].flatMap(({ key, label, colour, dashed }): SeriesOption[] => {
                const data = plotRows.flatMap((row, position) => row[key] === undefined
                  ? [] : [{ value: [position, row[key]], symbolSize: 4 }]);
                const gaps = historyGapSeries(data);
                return [{
                  id: key, name: label, type: "line", data, connectNulls: false,
                  showSymbol: data.filter(({ value }) => value[1] != null).length === 1,
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
          <span>{t("区间回报 · 起点归 100", "Period return · Rebased to 100")}</span>
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
      </section>
      {context.isPending ? <Pending compact /> : context.isError ? <QueryError retry={context.refetch} error={context.error} showDataStatusLink={false} /> :
        context.data && <IndexContextPanels context={context.data} phone={phone} />}
    </div>
  );
}

function IndexContextPanels({ context, phone }: { context: IndexContext; phone: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
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
          ? t("行业权重与贡献", "Sector weights and contribution") : t("行业权重", "Sector weights")}</summary>
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
              <span>{fund.shares == null ? "—" : `${formatNumber(fund.shares, locale)} ${t("份", "shares")}`}</span>
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
