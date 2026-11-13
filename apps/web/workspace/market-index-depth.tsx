"use client";

import dynamic from "next/dynamic";
import type { SeriesOption } from "echarts";
import { useLocale } from "@/components/locale-provider";
import { historyGapSeries } from "@/lib/portfolio/series";
import { formatCalendarDate, formatDateTime, formatDateSpan, formatNumber, formatPercent } from "@/ui/formatters";
import { Help, useCopy } from "./foundation";
import type { IndexContext } from "./market-indices-data";

const Plot = dynamic(() => import("./charts").then((module) => module.Plot));

export function IndexBreadthPanel({ history, stale, phone }: {
  history: NonNullable<IndexContext["breadthHistory"]>;
  stale: boolean;
  phone: boolean;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const title = t("成分篮子宽度历史", "Constituent basket breadth");
  const lines = [
    { value: "above50", count: "eligible50", label: t("站上 50 日线", "Above 50-day average") },
    { value: "above200", count: "eligible200", label: t("站上 200 日线", "Above 200-day average") },
  ] as const;
  const rows = history.points;
  const latest = rows.find((row) => row.date === history.asOf);
  const readPoint = (position: number) => {
    const row = rows[position];
    if (!row) return "";
    return [
      formatCalendarDate(row.date, locale),
      ...lines.map(({ label, value, count }) => `${label}: ${formatPercent(row[value], locale, 1)} (${row[count]}/${history.members})`),
    ].join("\n");
  };
  const step = Math.max(1, Math.ceil((rows.length - 1) / (phone ? 3 : 6)));
  return (
    <section className="mx-panel mx-index-depth">
      <div className="mx-index-title">
        <h3>{title} · {history.fund}</h3>
        <span><time dateTime={history.asOf}>{formatCalendarDate(history.asOf, locale)}</time>
          {stale ? ` · ${t("未更新", "Stale")}` : ""}</span>
        <Help label={t("宽度计算与来源", "Breadth method and sources")}>
          <p>{t("以这期 ETF 成分篮子回算，不代表历史指数成分。成分等权；用最近 50 或 200 个实际日收盘价（含当日）算均线。历史不足、缺失过多或无当日收盘价的成分不计入；覆盖不足 80% 留空。", "Back-calculated with this ETF basket. It does not reconstruct historical index membership. Each holding counts once. Its average uses the latest 50 or 200 observed closes, including that day. Holdings with too little history, too many gaps or no close that day are excluded; coverage below 80% leaves a gap.")}</p>
          <p><a href={history.holdingsUrl} target="_blank" rel="noreferrer" className="mx-text-link">{history.fund}</a>
            {` · ${t("持仓日期", "Holdings dated")} ${formatCalendarDate(history.holdingsAsOf, locale)} · ${t("抓取于", "Retrieved")} ${formatDateTime(history.holdingsFetchedAt, locale, timeZone)}`}</p>
          <p>{history.pricesSource} · {t("本地币种日收盘价", "Daily closes in listing currency")} · {t("最近抓取于", "Last retrieved")} {formatDateTime(history.pricesFetchedAt, locale, timeZone)}</p>
        </Help>
      </div>
      <dl className="mx-index-depth-metrics">
        {lines.map(({ label, value, count }, i) => <div key={value}>
          <dt><i aria-hidden="true" data-dashed={i === 1} />{label}</dt>
          <dd>{formatPercent(latest?.[value], locale, 1)} {latest && <small>{latest[count]}/{history.members}</small>}</dd>
        </div>)}
      </dl>
      <Plot label={title} height={phone ? 172 : 222} readPoint={readPoint} option={(colours) => ({
        animation: false,
        grid: { top: 10, right: 8, bottom: 27, left: 48 },
        xAxis: { type: "category", boundaryGap: false, data: rows.map((row) => row.date),
          axisLabel: {
            interval: (position) => position === rows.length - 1 || (position % step === 0 && rows.length - 1 - position >= step / 2),
            formatter: (day: string) => formatCalendarDate(day, locale),
          } },
        yAxis: { type: "value", min: 0, max: 1, interval: 0.25,
          axisLabel: { formatter: (value: number) => formatPercent(value, locale, 0) } },
        tooltip: { trigger: "axis", formatter: (input) => {
          const entries = Array.isArray(input) ? input : [input];
          const row = entries.find((entry) => !String(entry.seriesId).startsWith("history-gap:"));
          const position = Array.isArray(row?.value) ? row.value[0] : undefined;
          return typeof position === "number" ? readPoint(position) : "";
        } },
        series: lines.flatMap(({ label, value }, i): SeriesOption[] => {
          const colour = i === 0 ? colours.text : colours.axis;
          const data = rows.map((row, position) => ({ value: [position, row[value]], symbolSize: 4 }));
          const gaps = historyGapSeries(data);
          return [{
            id: value, name: label, type: "line", data, connectNulls: false,
            showSymbol: data.filter(({ value }) => value[1] != null).length === 1,
            lineStyle: { color: colour, type: i === 0 ? "solid" : "dashed", width: 2 },
            itemStyle: { color: colour },
          }, ...(gaps.length ? [{
            id: `history-gap:${value}`, type: "line" as const, data: gaps,
            silent: true, tooltip: { show: false }, showSymbol: false, connectNulls: false,
            lineStyle: { color: colour, width: 1.5, type: "dotted" as const, opacity: 0.65 },
          }] : [])];
        }),
      })} />
    </section>
  );
}

export function IndexVixPanel({ vix, stale }: { vix: NonNullable<IndexContext["vix"]>; stale: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const number = (value: number) => formatNumber(value, locale, { maximumFractionDigits: 2 });
  return (
    <section className="mx-panel mx-index-depth">
      <div className="mx-index-title">
        <h3>{t("VIX 背景", "VIX context")}</h3>
        <span><time dateTime={vix.asOf}>{formatCalendarDate(vix.asOf, locale)}</time>
          {stale ? ` · ${t("未更新", "Stale")}` : ""}</span>
        <Help label={t("VIX 历史参照口径", "How VIX context is measured")}>
          <p>{t("VIX 衡量标普 500 期权隐含的近 30 日波动率，单位为点。将最近一个已完成的收盘值与此前约 5 年的日收盘比较。常见区间取第 10 至第 90 百分位。", "VIX measures near-term (30-day) volatility implied by S&P 500 options, in points. The latest completed close is compared with about five years of earlier daily closes. The typical range runs from the 10th to the 90th percentile.")}</p>
          <p>{formatDateSpan(vix.sampleStart, vix.sampleEnd, locale)} · {formatNumber(vix.sampleSize, locale)} {t("个交易日", "sessions")}</p>
          <p>{vix.source} · {t("抓取于", "Retrieved")} {formatDateTime(vix.fetchedAt, locale, timeZone)}</p>
        </Help>
      </div>
      <dl className="mx-index-depth-metrics">
        <div><dt>{t("收盘", "Close")}</dt><dd>{number(vix.close)} <small>{t("点", "pts")}</small></dd></div>
        <div><dt>{t("历史分位", "Historical percentile")}</dt><dd>{formatPercent(vix.percentile, locale, 0)}</dd></div>
        <div><dt>{t("常见区间", "Typical range")}</dt><dd>{number(vix.p10)}–{number(vix.p90)} <small>{t("点", "pts")}</small></dd></div>
      </dl>
    </section>
  );
}

export function IndexValuationPanel({ snapshot, reference }: {
  snapshot: IndexContext["valuation"];
  reference: NonNullable<IndexContext["valuationReference"]>;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const multiple = (value: number | null | undefined) => value == null ? "—"
    : `${formatNumber(value, locale, { maximumFractionDigits: 2 })}×`;
  return (
    <section className="mx-panel mx-index-depth">
      <div className="mx-index-title">
        <h3>{reference.basis === "etf" ? t("跟踪 ETF 估值", "Tracking ETF valuation") : t("指数估值", "Index valuation")}</h3>
        {snapshot && <span><time dateTime={snapshot.asOf}>{formatCalendarDate(snapshot.asOf, locale)}</time></span>}
        {snapshot && <Help label={t("估值来源", "Valuation source")}>
          <p>{snapshot.basis === "etf"
            ? t("发行商公布的是基金组合估值，可能与指数不同。", "The issuer reports valuation for the fund portfolio, which can differ from the index.")
            : t("编制商公布的估值快照。", "A valuation snapshot published by the index provider.")}</p>
          <p>{t("抓取于", "Retrieved")} {formatDateTime(snapshot.fetchedAt, locale, timeZone)}</p>
        </Help>}
      </div>
      {snapshot ? <dl className="mx-index-depth-metrics">
        <div><dt>{t("市盈率", "P/E")}</dt><dd>{multiple(snapshot.pe)}</dd></div>
        <div><dt>{t("预期市盈率", "Forward P/E")}</dt><dd>{multiple(snapshot.forwardPe)}</dd></div>
      </dl> : null}
      <p className="mx-index-note">{!snapshot && <>{t("暂无快照", "No snapshot")} · </>}
        <a href={reference.sourceUrl} target="_blank" rel="noreferrer" className="mx-text-link">{reference.source}</a>
      </p>
    </section>
  );
}
