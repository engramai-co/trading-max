"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useLocale } from "@/components/locale-provider";
import type { DashboardLens, Holding } from "@/lib/types";
import { useAllocationChartColours } from "@/ui/charts/palette";
import { formatCalendarDate } from "@/ui/formatters";
import { currency, percent, tone } from "@/workspace/data";
import { holdingSignals, SIGNAL_LIMIT, THRESHOLD, type AttentionFact } from "./attention";
import { ClosedMarket } from "./closed-market";
import { useCurrentDay } from "./current-day";
import { Empty, Instrument, Panel, Tag, TextLink, useCopy } from "./foundation";
import { etfPortfolioQuery, signedPoints, trackingDisplay, type Copy } from "./etf-data";
import Link from "./link";
import { holdingsLedger, readingColumns, type HoldingsLedger, type LedgerGroup, type LedgerRow } from "./overview-holdings-data";
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
  if (fact.kind === "score") return zh ? `技术 ${fact.value}/100` : `Technical ${fact.value}/100`;
  if (fact.kind === "rsi") {
    const stretched = fact.value >= THRESHOLD.rsiHigh ? (zh ? "超买" : "overbought") : zh ? "超卖" : "oversold";
    return `RSI ${fact.value} ${stretched}`;
  }
  if (fact.kind === "upside") return zh ? `模型空间 ${percent(fact.value, true, 0)}` : `Model upside ${percent(fact.value, true, 0)}`;
  if (fact.kind === "tracking") return zh ? `一年跟踪差 ${signedPoints(fact.value)} pp` : `1-year tracking difference ${signedPoints(fact.value)} pp`;
  return zh ? `浮亏 ${percent(Math.abs(fact.value), false, 0)}` : `${percent(fact.value, true, 0)} vs cost`;
}

/**
 * The readings past their thresholds for one column: a dot before the figure, every reading spelled out
 * for assistive technology. Red keeps its meaning for a loss; research readings take the warning tint.
 */
function Flag({ facts, kinds }: { facts: AttentionFact[]; kinds: AttentionFact["kind"][] }) {
  const { locale } = useLocale();
  const matched = facts.filter((fact) => kinds.includes(fact.kind));
  if (!matched.length) return null;
  const text = matched.map((fact) => factText(fact, locale === "zh")).join(" · ");
  return (
    <>
      <i className="mx-ledger-flag" data-tone={matched.some((fact) => fact.kind === "loss") ? "down" : "warning"}
        title={text} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </>
  );
}

function TrackingCell({ display, description, status, facts }: {
  display: string; description: string; status?: string; facts: AttentionFact[];
}) {
  return <span className="mx-ledger-etf" role="group" aria-label={description} title={description} data-stale={status ? "" : undefined}>
    <Flag facts={facts} kinds={["tracking"]} /><span aria-hidden="true">{display}</span>
  </span>;
}

function figures(row: LedgerRow, t: Copy) {
  const tracking = row.fund ? trackingDisplay(row.etf, t, true) : undefined;
  const hasTracking = row.etf?.tracking.differencePp != null && row.etf.tracking.state !== "incomparable";
  return {
    day: row.dayClosed ? <ClosedMarket /> : <span className={changeClass(row.day, 2)}>{percent(row.day, true, 2)}</span>,
    pnl: (
      <>
        <Flag facts={row.facts} kinds={["loss"]} />
        <span className={changeClass(row.pnl, 1)}>{percent(row.pnl, true, 1)}</span>
      </>
    ),
    score: (
      <>
        <Flag facts={row.facts} kinds={["score", "rsi"]} />
        {row.score ?? "—"}
      </>
    ),
    tracking: tracking && (
      <TrackingCell facts={row.facts} {...tracking} display={hasTracking ? tracking.display : "—"} />
    ),
    upside: (
      <>
        <Flag facts={row.facts} kinds={["upside"]} />
        {percent(row.upside, true, 0)}
      </>
    ),
  };
}

export function OverviewHoldings({ holdings, technical, valuations, runId, brokerAsOf, account }: {
  holdings: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  runId?: string;
  brokerAsOf?: string | null;
  account: string;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const { today, now } = useCurrentDay();
  const palette = useAllocationChartColours();
  const ledgerId = useId();
  const [focus, setFocus] = useState<Focus | null>(null);
  const portfolio = useQuery({ ...etfPortfolioQuery(runId ?? "", account), enabled: Boolean(runId && holdings.some((row) => row.isFund)) });
  const etfs = runId && portfolio.data?.runId === runId ? portfolio.data?.funds : undefined;
  const ledger = useMemo(
    () => holdingsLedger({ holdings, technical, valuations, etfs, signals: holdingSignals({ holdings, technical, valuations, etfs }) }),
    [holdings, technical, valuations, etfs],
  );
  const dayLabel = (date: string | null) => (!date || date === today ? t("今日", "Today") : formatCalendarDate(date, locale, now));
  const weightLabel = t("占比", "Weight");
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
      title={t("持仓", "Holdings")}
      help={locale === "zh"
        ? `占比按已投资市值计算，不含现金。最多标记 ${SIGNAL_LIMIT} 只持仓；每只显示所有触及阈值的读数。红色：浮亏 ≥ ${percent(-THRESHOLD.loss, false, 0)}。黄色：技术分 ≤ ${THRESHOLD.score}、RSI ≥ ${THRESHOLD.rsiHigh} 或 ≤ ${THRESHOLD.rsiLow}、模型空间 ≤ ${percent(THRESHOLD.upside, true, 0)}。基金的一年跟踪差可比且在有效期内，≤ ${signedPoints(THRESHOLD.trackingPp)} 个百分点时标记。黄色跟踪差数字表示已过期或日期未验证。`
        : `Weights exclude cash. Up to ${SIGNAL_LIMIT} holdings are flagged. Each shows every reading that crossed a threshold. Red: a loss of ${percent(-THRESHOLD.loss, false, 0)} or more against cost. Amber: technical score ≤ ${THRESHOLD.score}, RSI ≥ ${THRESHOLD.rsiHigh} or ≤ ${THRESHOLD.rsiLow}, model upside ≤ ${percent(THRESHOLD.upside, true, 0)}. Amber also marks a fresh, comparable 1-year fund tracking difference ≤ ${signedPoints(THRESHOLD.trackingPp)} pp. An amber tracking figure indicates stale data or unverified dates.`}
      action={<TextLink href="/holdings?view=lookthrough">{t("穿透", "Look-through")}</TextLink>}
    >
      {ledger.count === 0 ? (
        <Empty title={t("还没有持仓", "No positions yet")} />
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
                  const cells = figures(row, t);
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
                            <Instrument ticker={row.ticker} name={row.name} small />
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
                    const cells = figures(row, t);
                    return (
                      <li key={row.ticker}>
                        <Link className="mx-ledger-item" href={row.href} {...keys(rowFocus(row))}>
                          <span className="mx-ledger-item-head">
                            {dot(row)}
                            <Instrument ticker={row.ticker} name={row.name} small />
                            <strong><span className="sr-only">{weightLabel} </span>{percent(row.weight)}</strong>
                          </span>
                          <dl>
                            {columns.map(({ key, label }) => <div key={key}>
                              <dt className="sr-only">{key === "day" ? dayLabel(row.dayDate ?? ledger.columnDay) : label}</dt>
                              <dd>
                                {key === "day" && row.dayDate && <Tag tone="warn">{dayLabel(row.dayDate)}</Tag>}
                                {cells[key]}
                              </dd>
                            </div>)}
                          </dl>
                        </Link>
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
