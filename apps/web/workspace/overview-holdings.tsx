"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useLocale } from "@/components/locale-provider";
import type { DashboardLens, Holding } from "@/lib/types";
import { useAllocationChartColours } from "@/ui/charts/palette";
import { formatCalendarDate } from "@/ui/formatters";
import { currency, percent, tone } from "@/workspace/data";
import { holdingSignals, SIGNAL_LIMIT, THRESHOLD, type AttentionFact } from "./attention";
import { useCurrentDay } from "./current-day";
import { Empty, Instrument, Panel, Tag, TextLink, useCopy } from "./foundation";
import { etfPortfolioQuery, overlapDisplay, signedPoints, trackingDisplay, type Copy } from "./etf-data";
import Link from "./link";
import { holdingsLedger, type HoldingsLedger, type LedgerRow } from "./overview-holdings-data";
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
  if (fact.kind === "overlap") return zh ? `组合重叠 ${percent(fact.value, false, 0)}` : `Portfolio overlap ${percent(fact.value, false, 0)}`;
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

/** The four figures of a row, each with its flag; a stretched RSI shows its reading beside the score. */
function FundCell({ label, display, description, status, facts, kind }: {
  label: string; display: string; description: string; status?: string; facts: AttentionFact[]; kind: "tracking" | "overlap";
}) {
  return <span className="mx-ledger-etf" role="group" aria-label={description} title={description} data-stale={status ? "" : undefined}>
    <span aria-hidden="true">{label}</span>
    <strong><Flag facts={facts} kinds={[kind]} /><span aria-hidden="true">{display}{status && <sup>*</sup>}</span></strong>
  </span>;
}

function figures(row: LedgerRow, t: Copy, etfLoading: boolean) {
  const tracking = trackingDisplay(row.etf, t, true);
  const overlap = overlapDisplay(row.etf, t);
  const loading = etfLoading && !row.etf;
  const rsi = row.facts.find((fact) => fact.kind === "rsi");
  return {
    day: <span className={changeClass(row.day, 2)}>{percent(row.day, true, 2)}</span>,
    pnl: (
      <>
        <Flag facts={row.facts} kinds={["loss"]} />
        <span className={changeClass(row.pnl, 1)}>{percent(row.pnl, true, 1)}</span>
      </>
    ),
    score: row.fund ? <>
      <FundCell label={t("跟踪差", "Track")} facts={row.facts} kind="tracking" {...tracking} display={loading ? "—" : tracking.display} />
    </> : (
      <>
        <Flag facts={row.facts} kinds={["score", "rsi"]} />
        {row.score ?? "—"}
        {rsi && <span className="mx-ledger-note" aria-hidden="true">RSI {rsi.value}</span>}
      </>
    ),
    upside: row.fund ? <>
      <FundCell label={t("重叠", "Overlap")} facts={row.facts} kind="overlap" {...overlap} display={loading ? "—" : overlap.display} />
    </> : (
      <>
        <Flag facts={row.facts} kinds={["upside"]} />
        {percent(row.upside, true, 0)}
      </>
    ),
  };
}

export function OverviewHoldings({ holdings, technical, valuations, runId, account }: {
  holdings: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  runId?: string;
  account: string;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const { today, now } = useCurrentDay();
  const palette = useAllocationChartColours();
  const [focus, setFocus] = useState<Focus | null>(null);
  const portfolio = useQuery({ ...etfPortfolioQuery(runId ?? "", account), enabled: Boolean(runId && holdings.some((row) => row.isFund)) });
  const etfs = runId && portfolio.data?.runId === runId ? portfolio.data?.funds : undefined;
  const ledger = useMemo(
    () => holdingsLedger({ holdings, technical, valuations, etfs, signals: holdingSignals({ holdings, technical, valuations, etfs }) }),
    [holdings, technical, valuations, etfs],
  );
  const dayLabel = (date: string | null) => (!date || date === today ? t("今日", "Today") : formatCalendarDate(date, locale, now));
  const columns = [dayLabel(ledger.columnDay), t("浮动盈亏", "Unrealized"), t("技术", "Technical"), t("模型空间", "Model upside")];
  // Phones name the columns once over every row, in words that fit a quarter of 320px.
  const phoneColumns = [columns[0], t("浮动盈亏", "P&L"), columns[2], t("模型空间", "Upside")];
  const restLabel = locale === "zh" ? `其余 ${ledger.rest.count} 只` : `${ledger.rest.count} more`;
  const countLabel = locale === "zh" ? `${ledger.count} 只` : `${ledger.count} ${ledger.count === 1 ? "holding" : "holdings"}`;
  const rowFocus = (row: LedgerRow): Focus => ({ segment: row.ticker, label: row.ticker, weight: row.weight });
  const restFocus: Focus = { segment: REST, label: restLabel, weight: ledger.rest.weight };
  const lit = (segment: string) => (focus?.segment === segment ? "" : undefined);
  const dot = (row: LedgerRow | null) => (
    <i className="mx-ledger-dot" aria-hidden="true" data-rest={row ? undefined : ""}
      style={row ? ({ "--mx-dot": palette[row.colour] } as CSSProperties) : undefined} />
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
        ? `占比按已投资市值计算，不含现金。圆点最多 ${SIGNAL_LIMIT} 个。红色：浮亏 ≥ ${percent(-THRESHOLD.loss, false, 0)}。黄色：技术分 ≤ ${THRESHOLD.score}、RSI ≥ ${THRESHOLD.rsiHigh} 或 ≤ ${THRESHOLD.rsiLow}、模型空间 ≤ ${percent(THRESHOLD.upside, true, 0)}。ETF 显示一年跟踪差和组合重叠。跟踪差可比且在有效期内，≤ ${signedPoints(THRESHOLD.trackingPp)} 个百分点时标记；重叠 ≥ ${percent(THRESHOLD.overlap, false, 0)}、双方覆盖率 ≥ ${percent(THRESHOLD.coverage, false, 0)} 且日期有效时标记。星号表示已过期或日期未验证。`
        : `Weights exclude cash. Up to ${SIGNAL_LIMIT} dots. Red: a loss of ${percent(-THRESHOLD.loss, false, 0)} or more against cost. Amber: technical score ≤ ${THRESHOLD.score}, RSI ≥ ${THRESHOLD.rsiHigh} or ≤ ${THRESHOLD.rsiLow}, model upside ≤ ${percent(THRESHOLD.upside, true, 0)}. ETFs show 1-year tracking difference and portfolio overlap. Amber marks a fresh, comparable tracking difference ≤ ${signedPoints(THRESHOLD.trackingPp)} pp, or overlap ≥ ${percent(THRESHOLD.overlap, false, 0)} when both sides have ≥ ${percent(THRESHOLD.coverage, false, 0)} coverage and valid dates. An asterisk marks stale or unverified dates.`}
      action={<TextLink href="/holdings?view=lookthrough">{t("穿透", "Look-through")}</TextLink>}
    >
      {ledger.count === 0 ? (
        <Empty title={t("还没有持仓", "No positions yet")} />
      ) : (
        <div className="mx-ledger">
          <Donut ledger={ledger} palette={palette} focus={focus} setFocus={setFocus} restLabel={restLabel}
            countLabel={countLabel}
            title={locale === "zh" ? countLabel : <>{ledger.count}<small>{ledger.count === 1 ? "holding" : "holdings"}</small></>} />
          <table className="mx-ledger-table" data-etfs={holdings.some((row) => row.isFund) ? "" : undefined}>
            <thead>
              <tr>
                <th scope="col">{t("持仓", "Holding")}</th>
                <th scope="col">{t("占比", "Weight")}</th>
                {columns.map((column) => <th scope="col" key={column}>{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {ledger.rows.map((row) => {
                const cells = figures(row, t, !runId || portfolio.isPending);
                return (
                  <tr key={row.ticker} {...pointer(rowFocus(row))} onClick={open} data-focus={lit(row.ticker)}>
                    <th scope="row">
                      <Link className="mx-ledger-link" href={row.href} {...keys(rowFocus(row))}>
                        {dot(row)}
                        <SecurityPeek ticker={row.ticker} position={{ valueGbp: row.value, weightPct: row.weight }}>
                          <Instrument ticker={row.ticker} name={row.name} small />
                        </SecurityPeek>
                      </Link>
                    </th>
                    <td>{percent(row.weight)}</td>
                    <td>
                      {row.dayDate && <Tag tone="warn">{dayLabel(row.dayDate)}</Tag>}
                      {cells.day}
                    </td>
                    <td>{cells.pnl}</td>
                    <td>{cells.score}</td>
                    <td>{cells.upside}</td>
                  </tr>
                );
              })}
              {ledger.rest.count > 0 && (
                <tr className="mx-ledger-rest" {...pointer(restFocus)} onClick={open} data-focus={lit(REST)}>
                  <th scope="row">
                    <Link className="mx-ledger-link" href="/holdings" {...keys(restFocus)}>
                      {dot(null)}
                      <span>{restLabel}</span>
                    </Link>
                  </th>
                  <td>{percent(ledger.rest.weight)}</td>
                  <td colSpan={4} />
                </tr>
              )}
            </tbody>
          </table>
          {/* Phones: each holding over one row of its figures; the columns are named once above them. */}
          <div className="mx-ledger-list" data-etfs={holdings.some((row) => row.isFund) ? "" : undefined}>
            <div className="mx-ledger-list-head" aria-hidden="true">
              {phoneColumns.map((column) => <span key={column}>{column}</span>)}
            </div>
            <ol>
              {ledger.rows.map((row) => {
                const cells = figures(row, t, !runId || portfolio.isPending);
                return (
                  <li key={row.ticker}>
                    <Link className="mx-ledger-item" href={row.href}>
                      <span className="mx-ledger-item-head">
                        {dot(row)}
                        <Instrument ticker={row.ticker} name={row.name} small />
                        <strong>{percent(row.weight)}</strong>
                      </span>
                      <dl>
                        <div>
                          <dt className="sr-only">{dayLabel(row.dayDate ?? ledger.columnDay)}</dt>
                          <dd>
                            {row.dayDate && <Tag tone="warn">{dayLabel(row.dayDate)}</Tag>}
                            {cells.day}
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">{columns[1]}</dt>
                          <dd>{cells.pnl}</dd>
                        </div>
                        <div>
                          <dt className="sr-only">{row.fund ? t("一年跟踪差", "1-year tracking difference") : columns[2]}</dt>
                          <dd>{cells.score}</dd>
                        </div>
                        <div>
                          <dt className="sr-only">{row.fund ? t("组合重叠", "Portfolio overlap") : columns[3]}</dt>
                          <dd>{cells.upside}</dd>
                        </div>
                      </dl>
                    </Link>
                  </li>
                );
              })}
              {ledger.rest.count > 0 && (
                <li>
                  <Link className="mx-ledger-item mx-ledger-item-rest" href="/holdings">
                    <span className="mx-ledger-item-head">
                      {dot(null)}
                      <span>{restLabel}</span>
                      <strong>{percent(ledger.rest.weight)}</strong>
                    </span>
                  </Link>
                </li>
              )}
            </ol>
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
    ...ledger.rows.map((row) => ({ key: row.ticker, label: row.ticker, weight: row.weight, colour: palette[row.colour] })),
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
