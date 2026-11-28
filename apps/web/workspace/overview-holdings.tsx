"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useLocale } from "@/components/locale-provider";
import type { DashboardLens, Holding } from "@/lib/types";
import { useAllocationChartColours } from "@/ui/charts/palette";
import { formatCalendarDate } from "@/ui/formatters";
import { currency, percent, tone } from "@/workspace/data";
import { holdingSignals, SIGNAL_LIMIT, THRESHOLD, type AttentionFact } from "./attention";
import { ClosedMarket } from "./closed-market";
import { useCurrentDay } from "./current-day";
import { Skeleton } from "@/components/ui/skeleton";
import { Help, Empty, Instrument, Panel, QueryError, Tag, TextLink, useCopy } from "./foundation";
import { etfPortfolioQuery, signedPoints, trackingDisplay, type Copy, type EvidenceTime } from "./etf-data";
import { useEvidenceTime } from "./etf-reading";
import Link from "./link";
import { holdingsLedger, overviewHoldingsState, readingColumns, type HoldingsLedger, type LedgerGroup, type LedgerRow } from "./overview-holdings-data";
import type { LedgerRows } from "@/lib/overview-layout-storage";
import { observeLedgerReservation } from "@/lib/overview-ledger-reservation";
import { SecurityPeek } from "./security-peek";

/**
 * What the donut's centre shows while something is pointed at. A row lights itself; a segment lights
 * the rows inside it.
 */
type Focus = { segment: string; label: string; weight: number };

const OUTER = 100;
const INNER = 63;
/** Seam between segments, in radians. */
const SEAM = 0.014;
const REST = "rest";

function point(angle: number, radius: number) {
  return (100 + radius * Math.sin(angle)).toFixed(2) + " " + (100 - radius * Math.cos(angle)).toFixed(2);
}

/** One ring segment from `start` to `end`, clockwise from twelve o'clock. */
function arc(start: number, end: number) {
  const large = end - start > Math.PI ? 1 : 0;
  return "M" + point(start, OUTER) + "A" + OUTER + " " + OUTER + " 0 " + large + " 1 " + point(end, OUTER)
    + "L" + point(end, INNER) + "A" + INNER + " " + INNER + " 0 " + large + " 0 " + point(start, INNER) + "Z";
}

/** Gain or loss colour for a change, none for one that rounds to zero at the digits shown. */
function changeClass(value: number | null, digits: number) {
  return value == null || Math.abs(value) < 0.5 * 10 ** -(digits + 2) ? undefined : "mx-" + tone(value);
}

function factText(fact: AttentionFact, zh: boolean) {
  if (fact.kind === "score") return zh ? `技术评分 ${fact.value}/100` : `Technical score ${fact.value}/100`;
  if (fact.kind === "rsi") {
    const stretched = fact.value >= THRESHOLD.rsiHigh ? (zh ? "超买" : "overbought") : zh ? "超卖" : "oversold";
    return `RSI ${fact.value} ${stretched}`;
  }
  if (fact.kind === "upside") return zh ? `模型空间 ${percent(fact.value, true, 0)}` : `Model upside ${percent(fact.value, true, 0)}`;
  if (fact.kind === "tracking") return zh ? `一年跟踪差 ${signedPoints(fact.value)} pp` : `1-year tracking difference ${signedPoints(fact.value)} pp`;
  return zh ? `浮亏 ${percent(Math.abs(fact.value), false, 0)}` : `${percent(fact.value, true, 0)} vs cost`;
}

function FlaggedReading({ facts, kinds, label, value, className, basis }: {
  facts: AttentionFact[];
  kinds: AttentionFact["kind"][];
  label: string;
  value: string;
  className?: string;
  basis?: string;
}) {
  const { locale } = useLocale();
  const matched = facts.filter(fact => kinds.includes(fact.kind));
  const flag = matched.length > 0 && <i className="mx-ledger-flag"
    data-tone={matched.some(fact => fact.kind === "loss") ? "down" : "warning"} aria-hidden="true" />;
  const result = <span className={className}>{value}</span>;
  if (!matched.length && !basis) return result;
  return <Help label={label} triggerLabel={label + " · " + value} triggerContent={<>{flag}{result}</>}>
    {matched.length > 0 && <p>{matched.map(fact => factText(fact, locale === "zh")).join(" · ")}</p>}
    {basis && <p>{basis}</p>}
  </Help>;
}

function figures(row: LedgerRow, t: Copy, when: EvidenceTime) {
  const tracking = row.fund ? trackingDisplay(row.etf, t, when, true) : undefined;
  const hasTracking = row.etf?.tracking.differencePp != null && row.etf.tracking.state !== "incomparable";
  return {
    day: row.dayClosed ? <ClosedMarket /> : <span className={changeClass(row.day, 2)}>{percent(row.day, true, 2)}</span>,
    pnl: <FlaggedReading facts={row.facts} kinds={["loss"]} label={t("浮动盈亏", "Unrealised P&L")}
      value={percent(row.pnl, true, 1)} className={changeClass(row.pnl, 1)} />,
    score: <FlaggedReading facts={row.facts} kinds={["score", "rsi"]} label={t("技术评分", "Technical score")}
      value={String(row.score ?? "—")} />,
    tracking: tracking && <span className="mx-ledger-etf" data-stale={tracking.status ? "" : undefined}>
      <FlaggedReading facts={row.facts} kinds={["tracking"]} label={t("一年跟踪差", "1-year tracking difference")}
        value={hasTracking ? tracking.display : "—"} basis={tracking.description} />
    </span>,
    upside: <FlaggedReading facts={row.facts} kinds={["upside"]} label={t("模型空间", "Model upside")}
      value={percent(row.upside, true, 0)}
      basis={row.baselineId ? t("已保存基准 · 五年中性估值", "Saved baseline · five-year base value") : undefined} />,
  };
}

export function OverviewHoldings({ holdings, technical, valuations, runId, brokerAsOf, account, pendingRows, pendingHeight, waiting = false, failed = false, error, retry }: {
  holdings?: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  runId?: string;
  brokerAsOf?: string | null;
  account: string;
  pendingRows?: LedgerRows;
  pendingHeight?: number;
  waiting?: boolean;
  failed?: boolean;
  error?: unknown;
  retry?: () => unknown;
}) {
  const t = useCopy();
  const when = useEvidenceTime();
  const { locale } = useLocale();
  const { today, now } = useCurrentDay();
  const palette = useAllocationChartColours();
  const ledgerId = useId();
  const [focus, setFocus] = useState<Focus | null>(null);
  const items = useMemo(() => holdings ?? [], [holdings]);
  const portfolio = useQuery({ ...etfPortfolioQuery(runId ?? "", account), enabled: Boolean(runId && items.some((row) => row.isFund)) });
  const etfs = runId && portfolio.data?.runId === runId ? portfolio.data?.funds : undefined;
  const ledger = useMemo(
    () => holdingsLedger({ holdings: items, technical, valuations, etfs, signals: holdingSignals({ holdings: items, technical, valuations, etfs }) }),
    [items, technical, valuations, etfs],
  );
  const state = overviewHoldingsState({
    waiting,
    hasData: holdings !== undefined,
    isError: failed,
    count: ledger.count,
  });
  const dayLabel = (date: string | null) => (!date || date === today ? t("今日", "Today") : formatCalendarDate(date, locale, now));
  const weightLabel = t("占比", "Weight");
  const holdingsLabel = t("持仓", "Holdings");
  const day = dayLabel(ledger.columnDay);
  const groupLabel = (kind: LedgerGroup["kind"]) => kind === "funds" ? t("基金", "Funds") : t("股票", "Stocks");
  const restLabel = locale === "zh" ? `其余 ${ledger.rest.count} 只` : `${ledger.rest.count} more`;
  const countLabel = locale === "zh" ? `${ledger.count} 只` : `${ledger.count} ${ledger.count === 1 ? "holding" : "holdings"}`;
  // A neutral row lights the shared segment; the centre still names the row and its own weight.
  const segmentOf = (row: LedgerRow) => (row.colour === null ? REST : row.ticker);
  const rowFocus = (row: LedgerRow): Focus => ({ segment: segmentOf(row), label: row.ticker, weight: row.weight });
  const lit = (row: LedgerRow) => (focus?.segment === segmentOf(row) ? "" : undefined);
  const dot = (row: LedgerRow) => (
    <i className="mx-ledger-dot" aria-hidden="true" data-rest={row.colour === null ? "" : undefined}
      style={row.colour === null ? undefined : ({ "--mx-dot": palette[row.colour] } as CSSProperties)} />
  );
  const pointer = (next: Focus) => ({ onPointerEnter: () => setFocus(next), onPointerLeave: () => setFocus(null) });
  const keys = (next: Focus) => ({ onFocus: () => setFocus(next), onBlur: () => setFocus(null) });
  // A row opens what its holding's link opens; the link stays the one control for keys and new tabs. Portalled
  // content such as the security preview bubbles through the row in React without being inside it.
  const open = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).closest("a, button") || window.getSelection()?.toString()) return;
    event.currentTarget.querySelector<HTMLAnchorElement>("a.mx-ledger-link")?.click();
  };
  return (
    <Panel
      className="mx-overview-holdings"
      title={holdingsLabel}
      help={locale === "zh"
        ? `占比按已投资市值计算，不含现金。最多标记 ${SIGNAL_LIMIT} 只持仓；每只显示所有触及阈值的读数。红色：浮亏 ≥ ${percent(-THRESHOLD.loss, false, 0)}。黄色：技术评分 ≤ ${THRESHOLD.score}、RSI ≥ ${THRESHOLD.rsiHigh} 或 ≤ ${THRESHOLD.rsiLow}、模型空间 ≤ ${percent(THRESHOLD.upside, true, 0)}。基金的一年跟踪差可比且在有效期内，≤ ${signedPoints(THRESHOLD.trackingPp)} 个百分点时标记。黄色跟踪差数字表示已过期或日期未验证。`
        : `Weights exclude cash. Up to ${SIGNAL_LIMIT} holdings are flagged. Each shows every reading that crossed a threshold. Red: a loss of ${percent(-THRESHOLD.loss, false, 0)} or more against cost. Amber: technical score ≤ ${THRESHOLD.score}, RSI ≥ ${THRESHOLD.rsiHigh} or ≤ ${THRESHOLD.rsiLow}, model upside ≤ ${percent(THRESHOLD.upside, true, 0)}. Amber also marks a fresh, comparable 1-year fund tracking difference ≤ ${signedPoints(THRESHOLD.trackingPp)} pp. An amber tracking figure indicates stale data or unverified dates.`}
      action={<TextLink href="/holdings?view=lookthrough" className={state === "pending" ? "invisible" : undefined}>{t("穿透", "Look-through")}</TextLink>}
    >
      {state === "pending" ? (
        <LedgerPlaceholder rows={pendingRows} height={pendingHeight} />
      ) : state === "error" ? (
        <QueryError error={error} retry={retry} />
      ) : state === "empty" ? (
        <Empty title={t("还没有持仓", "No holdings yet")} />
      ) : (
        <div className="mx-ledger">
          <Donut ledger={ledger} palette={palette} focus={focus} setFocus={setFocus} restLabel={restLabel}
            countLabel={countLabel}
            title={locale === "zh" ? countLabel : <>{ledger.count}<small>{ledger.count === 1 ? "holding" : "holdings"}</small></>} />
          <table className="mx-ledger-table">
            {ledger.groups.map(({ kind, rows }) => {
              const groupId = ledgerId + "-" + kind;
              const columns = readingColumns(kind, t, day);
              return <tbody key={kind} data-asset-class={kind}>
                <tr className="mx-ledger-head">
                  <th scope="col" id={groupId}>{groupLabel(kind)}</th>
                  <th scope="col" id={groupId + "-weight"}>{weightLabel}</th>
                  {columns.map((column) => <th scope="col" key={column.key} id={groupId + "-" + column.key}>{column.label}</th>)}
                </tr>
                {rows.map((row, index) => {
                  const cells = figures(row, t, when);
                  const rowId = groupId + "-row-" + index;
                  const headers = (column: string) => rowId + " " + groupId + "-" + column;
                  return (
                    <tr className="mx-ledger-row" key={row.ticker} {...pointer(rowFocus(row))} onClick={open} data-focus={lit(row)}>
                      <th scope="row" id={rowId} headers={groupId}>
                        <Link className="mx-ledger-link" href={row.href} {...keys(rowFocus(row))}>
                          {dot(row)}
                          <SecurityPeek ticker={row.ticker} position={{ valueGbp: row.value, weightPct: row.weight }}
                            session={{
                              label: !ledger.columnDay || (row.dayDate ?? ledger.columnDay) === today
                                ? t("今日涨跌", "Today’s move") : dayLabel(row.dayDate ?? ledger.columnDay),
                              share: row.day, closed: row.dayClosed, price: row.quotePrice, currency: row.quoteCurrency, asOf: brokerAsOf,
                            }}>
                            <Instrument ticker={row.ticker} name={row.name} isin={row.isin} small />
                          </SecurityPeek>
                        </Link>
                      </th>
                      <td headers={headers("weight")}>{percent(row.weight)}</td>
                      {columns.map(({ key }) => <td key={key} headers={headers(key)}>
                        {key === "day" && row.dayDate && <Tag tone="warn">{dayLabel(row.dayDate)}</Tag>}
                        {cells[key]}
                      </td>)}
                    </tr>
                  );
                })}
              </tbody>;
            })}
          </table>
          {/* Phones keep name and weight above the figures; each group introduces its own columns. */}
          <div className="mx-ledger-list">
            {ledger.groups.map(({ kind, rows }) => {
              const headingId = ledgerId + "-phone-" + kind;
              const columns = readingColumns(kind, t, day);
              return <section key={kind} className="mx-ledger-phone-group" aria-labelledby={headingId} data-asset-class={kind}>
                <div className="mx-ledger-list-heading">
                  <h3 id={headingId}>{groupLabel(kind)}</h3>
                  <span aria-hidden="true">{weightLabel}</span>
                </div>
                <div className="mx-ledger-list-head" aria-hidden="true">
                  {columns.map((column) => <span key={column.key}>{column.short}</span>)}
                </div>
                <ol>
                  {rows.map((row) => {
                    const cells = figures(row, t, when);
                    return (
                      <li className="mx-ledger-item" key={row.ticker}>
                          <Link className="mx-ledger-item-head" href={row.href} {...keys(rowFocus(row))}>
                            {dot(row)}
                            <Instrument ticker={row.ticker} name={row.name} isin={row.isin} small />
                            <strong><span className="sr-only">{weightLabel} </span>{percent(row.weight)}</strong>
                          </Link>
                          <dl>
                            {columns.map(({ key, label }) => <div key={key}>
                              <dt className="sr-only">{key === "day" ? dayLabel(row.dayDate ?? ledger.columnDay) : label}</dt>
                              <dd>
                                {key === "day" && row.dayDate && <Tag tone="warn">{dayLabel(row.dayDate)}</Tag>}
                                {cells[key]}
                              </dd>
                            </div>)}
                          </dl>
                      </li>
                    );
                  })}
                </ol>
              </section>;
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

function LedgerPlaceholder({ rows, height }: { rows?: LedgerRows; height?: number }) {
  const { locale } = useLocale();
  const placeholder = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const stocks = rows?.stocks;
  const funds = rows?.funds;
  const dateTagged = rows?.dateTagged;
  useLayoutEffect(() => {
    const node = placeholder.current;
    if (!node || !probe.current || typeof ResizeObserver !== "function") return;
    if (height === undefined) {
      return observeLedgerReservation(probe.current, node.style, "--mx-ledger-fallback",
        { stocks: stocks ?? 5, funds: funds ?? 0, dateTagged }, locale);
    }
  }, [stocks, funds, dateTagged, height, locale]);
  const count = rows && rows.stocks + rows.funds;
  const groups = rows && Number(rows.stocks > 0) + Number(rows.funds > 0);
  if (count === 0) return <Skeleton className="mx-ledger-rows-placeholder" style={{ height }} />;
  return <div ref={placeholder} className="mx-ledger mx-ledger-pending" aria-hidden="true" data-measured={height !== undefined || undefined}
    style={{ height, "--mx-ledger-rows": count, "--mx-ledger-groups": groups } as CSSProperties}>
    <div className="mx-ledger-chart"><Skeleton className="mx-ledger-donut mx-ledger-donut-placeholder" /></div>
    <Skeleton className="mx-ledger-rows-placeholder" />
    {height === undefined && <div ref={probe} className="mx-ledger-probe">
      <LedgerSizingSample />
      <span data-ledger-probe-ready="" hidden />
    </div>}
  </div>;
}

// The middle row measures the date badge without a group-end border.
function LedgerSizingSample() {
  const kinds = ["stocks", "funds"] as const;
  const samples = [false, true, false];
  const instrument = <span className="mx-instrument mx-instrument-small">
    <span className="mx-monogram" /><span><strong>0</strong><span className="mx-instrument-name">0</span></span>
  </span>;
  return <>
    {["single", "both"].map(sample => <table key={sample} className="mx-ledger-table" data-probe-table={sample}>
      {kinds.slice(0, sample === "both" ? 2 : 1).map(kind => <tbody key={kind}>
        <tr className="mx-ledger-head">{Array.from({ length: 6 }, (_, index) => <th key={index}>0</th>)}</tr>
        {samples.map((tagged, index) => <tr key={index} className="mx-ledger-row" data-probe-tagged={tagged || undefined}>
          <th><span className="mx-ledger-link"><i className="mx-ledger-dot" />{instrument}</span></th>
          <td>0</td>
          <td>{tagged && <Tag tone="warn">19 Nov</Tag>}<span>+1.00%</span></td>
          {Array.from({ length: 3 }, (_, cell) => <td key={cell}>0</td>)}
        </tr>)}
      </tbody>)}
    </table>)}
    {(["en", "zh"] as const).map(locale => {
      const t = (zh: string, en: string) => locale === "zh" ? zh : en;
      return <div key={locale} className="mx-ledger-list" data-probe-phone={locale} lang={locale}>
        {kinds.map(kind => <div key={kind} className="mx-ledger-phone-group" data-asset-class={kind}>
          <div className="mx-ledger-list-heading">
            <span className="mx-ledger-group-name">{kind === "funds" ? t("基金", "Funds") : t("股票", "Stocks")}</span>
            <span>{t("占比", "Weight")}</span>
          </div>
          <div className="mx-ledger-list-head">
            {readingColumns(kind, t, t("今日", "Today")).map(column => <span key={column.key}>{column.short}</span>)}
          </div>
          <ol>{samples.map((tagged, index) => <li key={index} className="mx-ledger-item" data-probe-tagged={tagged || undefined}>
            <span className="mx-ledger-item-head"><i className="mx-ledger-dot" />{instrument}<strong>0</strong></span>
            <dl>
              <div><dt className="sr-only">0</dt><dd>
                {tagged && <Tag tone="warn">{t("11月19日", "19 Nov")}</Tag>}<span>+1.00%</span>
              </dd></div>
              {Array.from({ length: 3 }, (_, cell) => <div key={cell}><dt className="sr-only">0</dt><dd>0</dd></div>)}
            </dl>
          </li>)}</ol>
        </div>)}
      </div>;
    })}
  </>;
}

function Donut({ ledger, palette, focus, setFocus, title, countLabel, restLabel }: {
  ledger: HoldingsLedger;
  palette: readonly string[];
  focus: Focus | null;
  setFocus: (focus: Focus | null) => void;
  title: ReactNode;
  countLabel: string;
  restLabel: string;
}) {
  const t = useCopy();
  const segments = [
    ...ledger.rows.flatMap((row) => row.colour === null ? [] : [{ key: row.ticker, label: row.ticker, weight: row.weight, colour: palette[row.colour] }]),
    ...(ledger.rest.weight > 0 ? [{ key: REST, label: restLabel, weight: ledger.rest.weight, colour: undefined }] : []),
  ].filter((segment) => segment.weight > 0);
  const total = segments.reduce((sum, segment) => sum + segment.weight, 0);
  let angle = 0;
  const paths = segments.map((segment) => {
    const size = total > 0 ? (segment.weight / total) * Math.PI * 2 : 0;
    const start = angle;
    angle += size;
    // A lone segment closes the ring in two halves; otherwise each segment gives up half a seam at both ends.
    const seam = segments.length > 1 && size > SEAM * 2 ? SEAM / 2 : 0;
    const d = segments.length === 1 ? arc(0, Math.PI) + arc(Math.PI, Math.PI * 2) : arc(start + seam, start + size - seam);
    return { ...segment, d };
  });
  const spoken = countLabel + t("，", ", ") + currency(ledger.total) + t("：", ": ")
    + segments.map((segment) => segment.label + " " + percent(segment.weight)).join(t("，", ", "));
  return (
    <div className="mx-ledger-chart">
      <div className="mx-ledger-donut" role="img" aria-label={t("持仓分布，", "Allocation, ") + spoken}>
        <svg viewBox="0 0 200 200" data-focus={focus ? "" : undefined} aria-hidden="true">
          {paths.map((segment) => (
            <path key={segment.key} d={segment.d}
              data-rest={segment.colour ? undefined : ""}
              data-current={focus?.segment === segment.key ? "" : undefined}
              style={segment.colour ? ({ "--mx-dot": segment.colour } as CSSProperties) : undefined}
              onPointerEnter={() => setFocus({ segment: segment.key, label: segment.label, weight: segment.weight })}
              onPointerLeave={() => setFocus(null)} />
          ))}
        </svg>
        <div className="mx-ledger-centre" aria-hidden="true">
          <strong>{focus ? focus.label : title}</strong>
          <span>{focus ? percent(focus.weight) : currency(ledger.total)}</span>
        </div>
      </div>
    </div>
  );
}
