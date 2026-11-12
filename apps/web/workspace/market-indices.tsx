"use client";

import { Select } from "@mantine/core";
import { ArrowClockwise, CaretRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import type { SeriesOption } from "echarts";
import type { CSSProperties, MouseEvent } from "react";
import { useLayoutEffect, useRef } from "react";
import { useLocale } from "@/components/locale-provider";
import { historyGapSeries } from "@/lib/portfolio/series";
import { formatCurrency, formatDate, formatDateTime, formatDeltaPercent, formatNumber, formatPercent } from "@/ui/formatters";
import { api } from "@/workspace/data";
import { Empty, Help, Pending, QueryError, Segments, useCopy } from "./foundation";
import Link from "./link";
import {
  alignIndices, comparable, indexHistoryRows, indexHref, useIndexCatalog,
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

function RetryIndices({ retry, busy }: { retry: () => void; busy?: boolean }) {
  const t = useCopy();
  return (
    <button type="button" className="mx-index-retry" disabled={busy} onClick={retry}>
      <ArrowClockwise size={14} aria-hidden="true" />{t("重试", "Retry")}
    </button>
  );
}

export function IndexStrip({ market, open, selected, marketName }: {
  market: IndexScope;
  open: (event: MouseEvent<HTMLAnchorElement>, index: IndexIdentity) => void;
  selected?: string | null;
  marketName?: string;
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
  const newest = (query.data?.quotes ?? []).map((quote) => quote.asOf ?? "").sort().at(-1);
  const error = query.isError || query.data?.refreshFailed;
  return (
    <section className="mx-index-strip" aria-label={t("市场指数", "Market indices")}>
      {marketName && <h2 className="mx-index-scope">{marketName}</h2>}
      {query.isPending ? <Pending label={t("正在加载指数", "Loading indices")} compact /> : null}
      {query.data && <div className="mx-index-cards">
        {query.data.quotes.map((quote) => <IndexCard key={quote.index.id} quote={quote} selected={selected === quote.index.id} open={open} />)}
      </div>}
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

function IndexCard({ quote, open, selected }: {
  quote: IndexQuote;
  open: (event: MouseEvent<HTMLAnchorElement>, index: IndexIdentity) => void;
  selected: boolean;
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
    : formatNumber(quote.level, locale, { maximumFractionDigits: 2 });
  const tone = index.kind === "volatility" || quote.change == null || quote.change === 0
    ? "neutral" : quote.change > 0 ? "up" : "down";
  const heat = Math.min(1, Math.abs(quote.change ?? 0) / 0.03);
  const freshness = quote.state === "stale" ? t("未更新", "Stale")
    : quote.index.rights === "licensed-source-required" ? t("暂无授权报价", "No licensed quote") : null;
  return (
    <Link
      href={indexHref(index)}
      prefetch={false}
      onClick={(event) => open(event, index)}
      id={`index-card-${index.id}`}
      className="mx-index-card"
      data-tone={tone}
      aria-current={selected ? "page" : undefined}
      style={{ "--mx-index-heat": `${Math.round(heat * 22 + (heat > 0 ? 5 : 0))}%` } as CSSProperties}
    >
      <span className="mx-index-name">
        {index.basis === "total-return" ? `${name(index)} · ${basis(index)}` : name(index)}
        <CaretRight size={13} aria-hidden="true" />
      </span>
      <span className="mx-index-figures"><strong>{level}</strong><span>{move}</span></span>
      <span className="mx-index-spark">
        {points.length > 1 && <svg aria-hidden="true" viewBox="0 0 200 25" preserveAspectRatio="none">
          <path d={line.path} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>}
        {freshness && <small>{freshness}</small>}
      </span>
    </Link>
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
  const catalog = useIndexCatalog();
  const index = catalog.data?.find((item) => item.id === id && item.scope === market);
  const period = !index?.ranges.length || index.ranges.includes(requestedPeriod)
    ? requestedPeriod : index.ranges.at(-1)!;
  const peers = (catalog.data ?? []).filter((item) => index && comparable(index, item, gbp, period));
  const peer = peers.find((item) => item.id === comparison);
  const historyQuery = (identifier?: string) => ({
    queryKey: ["index-history", identifier, period, gbp],
    queryFn: ({ signal }: { signal: AbortSignal }) => api<IndexHistory>(
      `/indices/${identifier}/history?range=${period}&currency=${gbp ? "GBP" : "local"}`, { signal },
    ),
    enabled: Boolean(identifier && index?.symbol),
    staleTime: 60_000,
    refetchInterval: period === "1D" ? 60_000 : false as const,
    retry: 0,
  });
  const query = useQuery(historyQuery(index?.id));
  const peerQuery = useQuery(historyQuery(peer?.id));
  const context = useQuery({
    queryKey: ["index-context", index?.id],
    queryFn: ({ signal }) => api<IndexContext>(`/indices/${index?.id}/context`, { signal }),
    enabled: !!index,
    refetchInterval: 4 * 60_000,
    staleTime: 60_000,
    retry: 0,
  });
  useLayoutEffect(() => {
    if (!index || (index.symbol && query.isPending) || lastFocused.current === index.id) return;
    const frame = requestAnimationFrame(() => {
      const heading = title.current;
      if (!heading?.getClientRects().length) return;
      if (!heading.closest(".mx-index-detail")?.contains(document.activeElement)) {
        heading.focus({ preventScroll: true });
      }
      lastFocused.current = index.id;
    });
    return () => cancelAnimationFrame(frame);
  }, [index, query.isPending]);
  if (catalog.isPending) return <Pending />;
  if (catalog.isError) return <QueryError retry={catalog.refetch} showDataStatusLink={false} />;
  if (!index) return <Empty title={t("没有这个市场指数", "Index not found in this market")} />;
  const history = query.data;
  const peerHistory = peerQuery.data;
  const points = history?.points ?? [];
  const matched = history && peerHistory ? alignIndices(history, peerHistory, period) : [];
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
    const reading = (label: string, value: number) => `${label}: ${formatNumber(value, locale, { maximumFractionDigits: 2 })}`;
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
            <span>{index.kind === "volatility" ? t("波动率点数", "Volatility points") : index.currency} · {index.symbol ?? index.compiler}</span>
            <Help label={t("指数数据与口径", "Index data and basis")}>
              <p>{basis(index)}{index.source ? ` · ${index.source}` : ""} · {index.compiler}</p>
              {index.kind === "etf-price" && <p>{t("这里显示基金上市价格。它可能偏离所跟踪的指数。", "This is the listed fund price. It can differ from its benchmark.")}</p>}
              {index.rights === "licensed-source-required" && <p>{t("暂无获授权的指数报价。", "An authorised source is required for index prices.")}</p>}
              {shortRange && <p>{period === "1W"
                ? t("显示近 7 天的 30 分钟线。", "30-minute bars over the last seven days.")
                : t("显示近一个月的小时线。", "Hourly bars over the last calendar month.")} {t("回撤使用图中价格，年化波动率使用已结束工作日的最后一个价格。英镑换算使用同频率的汇率。", "Drawdown uses the plotted bars. Annualised volatility uses the last reading of each completed weekday. GBP conversion uses FX bars at the same interval.")}</p>}
              {period === "MAX" && <p>{t("图中显示已结束周线的期末日期。回撤和年化波动率按周线计算；英镑换算使用此前已完成的汇率周线。", "Dates mark the end of completed weekly bars. Drawdown and annualised volatility use weekly bars. GBP conversion uses the most recent prior weekly FX close.")}</p>}
              {!intraday && period !== "MAX" && <p>{history?.hourlyClose
                ? t("日线取自纽约时间 17:00 的小时线。", "Daily values come from the 17:00 New York hourly bar.")
                : null} {t("回撤和年化波动率使用完整日线。英镑换算使用此前已完成的汇率日线。", "Drawdown and annualised volatility use completed daily bars. GBP conversion uses the most recent prior daily FX close.")}</p>}
              {matched.length > 0 && (intraday || period === "MAX") && <p>{period === "MAX"
                ? t("对比使用同一日历周内的读数，周线的结束日可能不同。", "Comparison uses readings from the same calendar week; bar end dates can differ.")
                : t("对比使用同一时间段内的读数。", "Comparison uses readings within the same time slot.")}</p>}
            </Help>
          </div>
        </div>
        {index.symbol && <div className="mx-index-controls">
          {index.ranges.length > 1 && <Segments label={t("时间范围", "Range")} value={period}
            options={index.ranges.map((value) => ({ value, label: value === "MAX" ? t("全部", "All") : value }))}
            onChange={(value) => update({ range: value === "1Y" ? null : value })} />}
          {index.currency && index.currency !== "GBP" && <Segments label={t("币种", "Currency")} value={gbp ? "GBP" : "local"}
            options={[{ value: "local", label: index.currency }, { value: "GBP", label: "GBP" }]}
            onChange={(value) => update({ currency: value === "GBP" ? "GBP" : null, compare: null })} />}
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
        {query.isPending && index.symbol ? <Pending label={t("正在加载走势", "Loading index history")} /> : null}
        {!points.length && (!query.isPending || !index.symbol) &&
          <Empty title={t("暂无此范围的走势", "No history for this range")} />}
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
              yAxis: { type: "value", scale: true, splitNumber: phone ? 4 : 5 },
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
          <span>{chartName}</span><span>{name(peer)}</span><span>{t("起点归 100", "Rebased to 100")}</span>
        </div>}
        {peer && !matched.length && !peerQuery.isPending && <p className="mx-index-note">{t("没有可比较的共同日期。", "No common observations to compare.")}</p>}
        <div className="mx-index-stamp">
          {history?.asOf && <time dateTime={history.asOf}>{t("截至 ", "Through ")}{intraday
            ? formatDateTime(history.asOf, locale, timeZone)
            : formatDate(new Date(history.asOf), locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</time>}
          {(!!history?.gaps?.length || (matched.length > 0 && !!peerHistory?.gaps?.length)) && <span>{t("历史数据不完整", "Partial history")}</span>}
          {(query.isError || peerQuery.isError || history?.state === "stale" || (index.symbol && history?.state === "unavailable")) &&
            <><span>{t("走势未能更新", "History did not update")}</span><RetryIndices retry={retry} busy={query.isFetching || peerQuery.isFetching} /></>}
        </div>
        <dl className="mx-index-metrics">
          <div><dt>{t("最大回撤", "Max drawdown")}</dt><dd>{formatPercent(history?.maxDrawdown, locale, 2)}</dd></div>
          <div><dt>{t("年化波动率", "Annualised volatility")}</dt><dd>{formatPercent(history?.volatility, locale, 2)}</dd></div>
        </dl>
      </section>
      {context.isPending ? <Pending compact /> : context.isError ? <QueryError retry={context.refetch} showDataStatusLink={false} /> :
        context.data && <IndexContextPanels context={context.data} />}
    </div>
  );
}

function IndexContextPanels({ context }: { context: IndexContext }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const basket = context.basket;
  return (
    <>
      {basket && <section className="mx-panel mx-index-basket">
        <div className="mx-index-title">
          <h3>{t("成分篮子", "Constituent basket")} · {basket.fund}</h3>
          <span>{basket.asOf ? formatDateTime(basket.asOf, locale, timeZone) : basket.sessionDate}</span>
          <Help label={t("篮子贡献口径", "How basket contributions are measured")}>
            <p>{t("贡献是成分权重乘以当日涨跌，单位为百分点。缺少报价的权重保留为空；残差只比较同一时段的指数报价。", "Contributions are weights multiplied by session moves, in percentage points. Unpriced weights stay missing. The residual uses an index quote from the same session and time.")}</p>
            <p>{t("持仓日期 ", "Holdings dated ")}{basket.holdingsDate}</p>
          </Help>
        </div>
        <dl className="mx-index-metrics">
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
        </div>
        <details className="mx-details"><summary>{t("行业权重与贡献", "Sector weights and contribution")}</summary>
          <ContributionList items={basket.sectors} showWeight />
        </details>
        <details className="mx-details"><summary>{t("前十大成分", "Top ten constituents")}</summary>
          <ContributionList items={basket.topHoldings} showWeight />
        </details>
      </section>}
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

function ContributionList({ title, items, showWeight = false }: { title?: string; items: IndexContribution[]; showWeight?: boolean }) {
  const t = useCopy();
  const { locale } = useLocale();
  return (
    <div>
      {title && <h4>{title}</h4>}
      <ul className="mx-index-contribution-list">
        {items.length ? items.map((item) => <li key={item.key}>
          <span>{item.name}</span>
          {showWeight && <span>{formatPercent(item.weight, locale, 2)}</span>}
          <strong>{pointsText(item.contribution == null ? null : item.contribution * 100, locale, t("百分点", "pp"))}</strong>
        </li>) : <li>—</li>}
      </ul>
    </div>
  );
}
