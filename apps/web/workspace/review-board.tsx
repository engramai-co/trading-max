"use client";

import { ArrowUpRight, CaretDown } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import type { AccountCode, DashboardLens } from "@/lib/types";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { currency, percent, tone } from "./data";
import { Instrument, Metric, Panel, Segments, Tag, useCopy } from "./foundation";
import Link from "./link";
import { accountName, useWorkspaceProfile } from "./profile";
import {
  type AccountDecisions,
  type Horizon,
  type TradeDecision,
  decisionAction,
  decisionEffect,
  decisionExtremes,
  decisionKeys,
  decisionParam,
  effectTone,
  favourableCount,
  observing,
  roundTripVerdict,
  sideVerdict,
  signedMoney,
  verdictWord,
} from "./review-decisions";
import { toolHorizon, type Habit } from "./review-patterns";
type Evidence = components["schemas"]["InvestmentReviewEvidence"];
type FillEffect = components["schemas"]["FillEffect"];
type HoldingMove = components["schemas"]["HoldingMove"];
type CashSpan = components["schemas"]["CashSpan"];
type WeightDrift = components["schemas"]["WeightDrift"];
type Copy = (zh: string, en: string) => string;

/** The accounts a decision review covers; CFD history has realised results but no decisions. */
export type DecisionAccount = "A" | "B";
export type ReviewScope = "all" | AccountCode;
export type ScopedDecision = TradeDecision & { account: DecisionAccount };

type DecisionLinkContext = { snapshot: string; horizon: Horizon; habit: Habit | null };

export type DecisionExpansion = DecisionLinkContext & {
  selected: ScopedDecision | null;
  location: "extremes" | "recent" | null;
  reading: ReactNode;
  id: string;
  toggle: (row: ScopedDecision, location: "extremes" | "recent", trigger: HTMLElement) => void;
};

/** More of a list, opened in place. */
export function ReviewDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="mx-review-disclosure">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

/** The review's scope from its address: every account, or one of them. */
export function reviewScope(value: string | null | undefined, fallback: ReviewScope = "all"): ReviewScope {
  return value === "A" || value === "B" || value === "C" || value === "all" ? value : fallback;
}

/** Where a decision opens: its account's review, led by that decision. */
export function decisionHref(
  account: DecisionAccount,
  row: Pick<TradeDecision, "date" | "side" | "ticker" | "reviewOrdinal" | "unpriced">,
  context?: DecisionLinkContext,
) {
  const query = new URLSearchParams({ account, decision: decisionParam(row) });
  if (row.reviewOrdinal != null) query.set("reviewOrdinal", String(row.reviewOrdinal));
  if (context) {
    query.set("snapshotId", context.snapshot);
    query.set("reviewWindow", toolHorizon(context.horizon));
    if (context.habit) query.set("habit", context.habit);
  }
  if (row.unpriced) query.set("habit", "basket_buy");
  return "/review?" + query;
}

/** One account's decisions, each knowing its account. */
export function scopedDecisions(account: DecisionAccount, review: AccountDecisions | null | undefined): ScopedDecision[] {
  if (review?.status !== "available") return [];
  // Match the account order used by the decision timing tool, before filtering or ranking.
  const rows = [...(review.decisions ?? []), ...(review.unpricedBasketBuys ?? [])];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = decisionParam(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return rows.map(row => {
    const key = decisionParam(row);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ...row, account, ...((counts.get(key) ?? 0) > 1 ? { reviewOrdinal: ordinal } : {}) };
  });
}

/** Both accounts' decisions by date, as the review across accounts plots them. */
export function allDecisions(reviews: DashboardLens["decisionReviews"]) {
  return (["A", "B"] as const)
    .flatMap((account) => scopedDecisions(account, reviews?.[account]))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Round trips across accounts, in the shape one account reports them. */
export function combinedRoundTrips(reviews: Array<AccountDecisions | null | undefined>) {
  return reviews.reduce((total, review) => {
    const one = roundTripVerdict(review?.status === "available" ? review.roundTripSummary : undefined);
    return { count: total.count + one.count, favourable: total.favourable + one.favourable, result: total.result + one.result };
  }, { count: 0, favourable: 0, result: 0 });
}

type Shares = FillEffect["before"];
type ShareKey = keyof Shares & ("largestHolding" | "cash" | "usdExposure");
export type ShareShift = { key: ShareKey; before: number; after: number };

/** A day's decisions in one account, the side effects of their fills, and what was left alone. */
export type JournalEntry =
  | { kind: "trade"; key: string; date: string; account: DecisionAccount; rows: ScopedDecision[]; shifts: ShareShift[] }
  | { kind: "moves"; key: string; date: string; account: DecisionAccount; rows: HoldingMove[] }
  | { kind: "cash"; key: string; date: string; account: DecisionAccount; row: CashSpan }
  | { kind: "drift"; key: string; date: string; account: DecisionAccount; row: WeightDrift };

const SHARE_KEYS: ShareKey[] = ["largestHolding", "cash", "usdExposure"];
/** A side effect worth a line: a share that moved at least a percentage point. */
const NOTABLE_SHIFT = 0.01;
const DAY = 86_400_000;

/**
 * How a day's fills moved the account's shares: the first fill's before and the last fill's after,
 * for each share that moved at least a percentage point, largest first, at most two.
 */
export function shareShifts(fills: FillEffect[]): ShareShift[] {
  if (!fills.length) return [];
  const ordered = [...fills].sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  const first = ordered[0].before;
  const last = ordered[ordered.length - 1].after;
  return SHARE_KEYS
    .map((key) => ({ key, before: first[key], after: last[key] }))
    .filter((shift) => Math.abs(shift.after - shift.before) >= NOTABLE_SHIFT)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 2);
}

const ORDER = { trade: 0, moves: 1, drift: 2, cash: 3 } as const;

/**
 * The review's recent record, newest first: each day's decisions in an account as one entry with
 * the side effects of their fills, the holdings that moved with nothing done, weights that drifted
 * and cash that sat. A fill belongs to the decision for its ticker and side nearest its own day.
 */
export function journalEntries(
  decisions: ScopedDecision[],
  evidence: Evidence | null | undefined,
  accounts: DecisionAccount[],
): JournalEntry[] {
  const trades = new Map<string, Extract<JournalEntry, { kind: "trade" }> & { fills: FillEffect[] }>();
  for (const row of decisions) {
    if (!accounts.includes(row.account)) continue;
    const key = "trade:" + row.account + ":" + row.date;
    const entry = trades.get(key) ?? { kind: "trade" as const, key, date: row.date, account: row.account, rows: [], shifts: [], fills: [] };
    entry.rows.push(row);
    trades.set(key, entry);
  }
  const entries: JournalEntry[] = [];
  for (const account of accounts) {
    const record = evidence?.accounts?.[account];
    if (!record) continue;
    for (const fill of record.fillEffects ?? []) {
      const at = Date.parse(fill.filledAt);
      let best: { entry: (typeof trades extends Map<string, infer V> ? V : never); gap: number } | null = null;
      for (const entry of trades.values()) {
        if (entry.account !== account || !entry.rows.some((row) => row.ticker === fill.ticker && row.side === fill.side)) continue;
        const gap = Math.abs(at - Date.parse(entry.date + "T12:00:00Z"));
        if (gap <= 2 * DAY && (!best || gap < best.gap)) best = { entry, gap };
      }
      best?.entry.fills.push(fill);
    }
    const moves = new Map<string, HoldingMove[]>();
    for (const row of record.holdingMoves ?? []) moves.set(row.date, [...(moves.get(row.date) ?? []), row]);
    for (const [date, rows] of moves) {
      entries.push({ kind: "moves", key: "moves:" + account + ":" + date, date, account, rows: rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)) });
    }
    for (const row of record.weightDrifts ?? []) {
      entries.push({ kind: "drift", key: "drift:" + account + ":" + row.ticker + ":" + row.end, date: row.end, account, row });
    }
    for (const row of record.cashSpans ?? []) {
      entries.push({ kind: "cash", key: "cash:" + account + ":" + row.end, date: row.end, account, row });
    }
  }
  for (const { fills, ...entry } of trades.values()) {
    entries.push({ ...entry, rows: entry.rows.sort((a, b) => b.amountGbp - a.amountGbp), shifts: shareShifts(fills) });
  }
  return entries.sort((a, b) =>
    b.date.localeCompare(a.date) || ORDER[a.kind] - ORDER[b.kind] || a.account.localeCompare(b.account) || a.key.localeCompare(b.key));
}

/** A day's decisions as one figure: the effects to date of those with an outcome, or none yet. */
export function tradeEffect(rows: TradeDecision[]) {
  const scored = rows.filter((row) => decisionEffect(row, "date") != null);
  return scored.length ? scored.reduce((total, row) => total + (decisionEffect(row, "date") ?? 0), 0) : null;
}

function shareLabel(key: ShareKey, t: Copy) {
  return key === "cash" ? t("现金", "Cash") : key === "usdExposure" ? t("美元敞口", "USD exposure") : t("最大持仓", "Largest holding");
}

/** A verdict as the review leads with it: the word, then the amount, coloured by what it did. */
function Verdict({ label, side, summary }: {
  label: string;
  side: "buy" | "sell" | "trip";
  summary: { evaluated?: number; count: number; favourable: number; effect: number };
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const evaluated = summary.evaluated ?? summary.count;
  const rounded = Math.round(summary.effect);
  const word = side === "trip" ? (rounded ? (rounded > 0 ? t("赚", "Gained") : t("亏", "Lost")) : "") : evaluated ? verdictWord(side, summary.effect, t) : "";
  return (
    <Metric
      label={label}
      value={evaluated ? (word ? word + " " : "") + currency(Math.abs(summary.effect)) : "—"}
      tone={word ? (rounded < 0 ? "down" : "up") : undefined}
      note={!evaluated ? undefined : side === "trip"
        ? (locale === "zh" ? `${summary.favourable} / ${summary.count} 次盈利` : `${summary.favourable} of ${summary.count} gained`)
        : favourableCount(side, summary.favourable, evaluated, locale)}
    />
  );
}

/** The review's lead: what buying, selling and round trips did, then where they happened. */
export function ReviewLead({ rows, horizon, trips, children }: {
  rows: TradeDecision[];
  horizon: Horizon;
  trips: { count: number; favourable: number; result: number };
  children?: ReactNode;
}) {
  const t = useCopy();
  return (
    <section className="mx-panel mx-review-lead" aria-label={t("复盘结论", "Review summary")}>
      <div className="mx-metric-grid mx-metric-grid-three mx-review-verdicts">
        <Verdict label={t("买入后", "Buys")} side="buy" summary={sideVerdict(rows, "buy", horizon)} />
        <Verdict label={t("卖出后", "Sells")} side="sell" summary={sideVerdict(rows, "sell", horizon)} />
        {trips.count > 0 && (
          <Verdict label={t("日内往返", "Round trips")} side="trip" summary={{ ...trips, effect: trips.result }} />
        )}
      </div>
      {children}
    </section>
  );
}

/** Each account's verdicts in one row; a row opens that account's review. */
export function ReviewAccounts({ accounts, horizon, onOpen }: {
  accounts: Array<{ code: DecisionAccount; rows: TradeDecision[]; review: AccountDecisions | null | undefined; twr?: number | null }>;
  horizon: Horizon;
  onOpen: (code: DecisionAccount) => void;
}) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const verdict = (rows: TradeDecision[], side: "buy" | "sell") => {
    const summary = sideVerdict(rows, side, horizon);
    if (!summary.evaluated) return <span className="mx-muted">—</span>;
    const word = verdictWord(side, summary.effect, t);
    return <span className={"mx-" + effectTone(summary.effect)}>{(word ? word + " " : "") + currency(Math.abs(summary.effect))}</span>;
  };
  const trips = (review: AccountDecisions | null | undefined) => {
    const one = roundTripVerdict(review?.status === "available" ? review.roundTripSummary : undefined);
    if (!one.count) return <span className="mx-muted">—</span>;
    const rounded = Math.round(one.result);
    return <span className={"mx-" + effectTone(one.result)}>{(rounded ? (rounded > 0 ? t("赚", "Gained") : t("亏", "Lost")) + " " : "") + currency(Math.abs(one.result))}</span>;
  };
  const columns = [t("买入后", "Buys"), t("卖出后", "Sells"), t("日内往返", "Round trips"), "TWR"];
  return (
    <div className="mx-review-accounts">
      <div className="mx-review-accounts-row mx-review-accounts-head" aria-hidden="true">
        <span>{t("账户", "Account")}</span>
        {columns.map((label) => <span key={label}>{label}</span>)}
        <span />
      </div>
      <ul>
        {accounts.map(({ code, rows, review, twr }) => (
          <li key={code}>
            <Link
              className="mx-review-accounts-row"
              href={"/review?account=" + code}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                onOpen(code);
              }}
            >
              <strong>{accountName(profile, code)}</strong>
              <span><span className="sr-only">{columns[0]} </span>{verdict(rows, "buy")}</span>
              <span><span className="sr-only">{columns[1]} </span>{verdict(rows, "sell")}</span>
              <span><span className="sr-only">{columns[2]} </span>{trips(review)}</span>
              <span><span className="sr-only">TWR </span><span className={twr == null ? "mx-muted" : "mx-" + tone(twr)}>{percent(twr, true)}</span></span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One decision in a short list: the security, what was done and when, and what it did since. */
function DecisionLine({ row, horizon, account, href, expansion }: { row: ScopedDecision; horizon: Horizon; account?: string; href: string; expansion?: DecisionExpansion }) {
  const t = useCopy();
  const { locale } = useLocale();
  const effect = decisionEffect(row, horizon);
  const change = horizon === "horizon" ? row.returnHorizon : row.returnToDate;
  const detail = [decisionAction(row, t).trim(), formatCalendarDate(row.date, locale), currency(row.amountGbp), account].filter(Boolean).join(" · ");
  const contents = <>
      <Instrument ticker={row.ticker} name={detail} small />
      <span className={"mx-row-value mx-" + effectTone(effect)}>
        <span>{signedMoney(effect)}</span>
        {change != null && <small>{t("之后 ", "then ") + percent(change, true, 1)}</small>}
      </span>
    </>;
  if (!expansion) return <Link className="mx-row-link mx-review-line" href={href}>{contents}<ArrowUpRight size={15} aria-hidden="true" /></Link>;
  const open = expansion.location === "extremes" && expansion.selected === row;
  return <div className="mx-review-expandable" data-open={open || undefined}>
    <div className="mx-review-expand-head">
      <button type="button" className="mx-row-link mx-review-line" aria-expanded={open} aria-controls={open ? expansion.id : undefined}
        onClick={event => expansion.toggle(row,"extremes",event.currentTarget)}>{contents}<CaretDown size={15} aria-hidden="true"/></button>
      <Link href={href} aria-label={t("查看这笔决定", "View this decision") + " · " + row.ticker}><ArrowUpRight size={15} aria-hidden="true"/></Link>
    </div>{open && expansion.reading}</div>;
}

/** The decisions that helped and cost the most at the review's horizon, buys and sells together. */
export function DecisionExtremes({ rows, horizon, showAccount, expansion }: { rows: ScopedDecision[]; horizon: Horizon; showAccount: boolean; expansion?: DecisionExpansion }) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { helped, cost } = decisionExtremes(rows, horizon);
  // Keys never depend on a security's display name, so a name correction keeps the row and its focus.
  const list = (items: ScopedDecision[], empty: string) => {
    const keys = decisionKeys(items);
    return items.length ? items.map((row, index) => (
      <DecisionLine key={keys[index]} row={row} horizon={horizon} expansion={expansion}
        account={showAccount ? accountName(profile, row.account) : undefined} href={decisionHref(row.account, row, expansion)} />
    )) : <p className="mx-review-empty">{empty}</p>;
  };
  return (
    <div className="mx-grid mx-review-extremes">
      <Panel title={t("帮你最多", "Helped most")}>{list(helped, t("还没有帮到你的决定", "No decision has helped yet"))}</Panel>
      <Panel title={t("代价最大", "Cost most")}>{list(cost, t("还没有代价明显的决定", "No decision has cost you yet"))}</Panel>
    </div>
  );
}

const VISIBLE_ENTRIES = 6;
const MORE_ENTRIES = 40;

function JournalItem({ entry, showAccount, expansion }: { entry: JournalEntry; showAccount: boolean; expansion?: DecisionExpansion }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  const account = showAccount ? accountName(profile, entry.account) : null;
  const share = (value: number) => percent(value, false, 1);
  const when = entry.kind === "trade" || entry.kind === "moves"
    ? <time dateTime={entry.date}>{formatCalendarDate(entry.date, locale)}</time>
    : <time dateTime={entry.row.end}>{formatDateSpan(entry.row.start, entry.row.end, locale)}</time>;
  let mark = "none";
  let body: ReactNode;
  let figure: ReactNode = null;
  if (entry.kind === "trade") {
    const sides = new Set(entry.rows.map((row) => row.side));
    mark = sides.size > 1 ? "mixed" : entry.rows[0].side;
    const effect = tradeEffect(entry.rows);
    const single = entry.rows.length === 1 ? entry.rows[0] : null;
    const chipKeys = decisionKeys(entry.rows);
    const label = single
      ? decisionAction(single, t) + single.ticker
      : sides.size > 1
        ? (locale === "zh" ? `调仓 ${entry.rows.length} 笔` : `Rebalanced ${entry.rows.length}`)
        : (entry.rows[0].side === "buy" ? t("买入", "Bought") : t("卖出", "Sold")) + (locale === "zh" ? ` ${entry.rows.length} 笔` : ` ${entry.rows.length}`);
    function tradeTrigger(row: ScopedDecision, content: ReactNode, className?: string) {
      if (!expansion) return <Link className={className} href={decisionHref(row.account,row)}>{content}</Link>;
      const open = expansion.selected === row && expansion.location === "recent";
      return <button type="button" className={className} aria-expanded={open} aria-controls={open ? expansion.id : undefined}
        onClick={event => expansion.toggle(row,"recent",event.currentTarget)}>{content} <CaretDown size={12} aria-hidden="true"/></button>;
    }
    body = (
      <>
        <p className="mx-journal-line">
          {single
            ? tradeTrigger(single, label, "mx-journal-act")
            : <strong className="mx-journal-act">{label}</strong>}
          {single && (
            <span className="mx-muted">
              {[single.quantity != null ? (locale === "zh" ? `${single.quantity.toLocaleString("zh-CN", { maximumFractionDigits: 4 })} 股` : `${single.quantity.toLocaleString("en-GB", { maximumFractionDigits: 4 })} shares`) : null,
                currency(single.amountGbp), single.unpriced ? t("行情缺失，未计入", "Unmeasured · price unavailable") : null, account].filter(Boolean).join(" · ")}
            </span>
          )}
          {!single && account && <span className="mx-muted">{account}</span>}
        </p>
        {!single && (
          <ul className="mx-journal-chips">
            {entry.rows.map((row, index) => (
              <li key={chipKeys[index]}>
                {tradeTrigger(row, <>
                  {sides.size > 1 && <span className={"mx-journal-mark mx-journal-mark-" + row.side} aria-hidden="true" />}
                  <span className="sr-only">{decisionAction(row, t)}</span>
                  {row.ticker} <span className="mx-muted">{currency(row.amountGbp)}{row.unpriced && " · " + t("行情缺失，未计入", "Unmeasured · price unavailable")}</span>
                </>)}
              </li>
            ))}
          </ul>
        )}
        {entry.shifts.length > 0 && (
          <p className="mx-journal-shift">
            {entry.shifts.map((shift) => (
              <span key={shift.key}>
                {shareLabel(shift.key, t)} {share(shift.before)} <span aria-label={t("至", "to")}>→</span> <strong>{share(shift.after)}</strong>
              </span>
            ))}
          </p>
        )}
      </>
    );
    const change = single?.returnToDate;
    figure = effect == null
      ? <span className="mx-muted">{entry.rows.every(row => !row.unpriced && observing(row)) ? t("观察中", "Observing") : "—"}</span>
      : (
        <>
          <span className={"mx-" + effectTone(effect)}>{signedMoney(effect)}</span>
          {single && change != null && <small>{t("之后 ", "then ") + percent(change, true, 1)}</small>}
        </>
      );
  } else if (entry.kind === "moves") {
    body = (
      <>
        <p className="mx-journal-line">
          <strong className="mx-journal-act">{t("没操作", "No trade")}</strong>
          {account && <span className="mx-muted">{account}</span>}
        </p>
        <ul className="mx-journal-chips">
          {entry.rows.map((row) => (
            <li key={row.ticker}>
              <Link href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}>
                {row.ticker} <span className={"mx-" + tone(row.change)}>{percent(row.change, true, 1)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (entry.kind === "drift") {
    body = (
      <p className="mx-journal-line">
        <strong className="mx-journal-act">{t("占比漂移 ", "Weight drift ") + entry.row.ticker}</strong>
        <span>{share(entry.row.before)} <span aria-label={t("至", "to")}>→</span> <strong>{share(entry.row.after)}</strong></span>
        {account && <span className="mx-muted">{account}</span>}
      </p>
    );
  } else {
    body = (
      <p className="mx-journal-line">
        <strong className="mx-journal-act">{t("现金偏多", "Cash held")}</strong>
        <span>{t("高点 ", "peak ") + share(entry.row.peakShare)}</span>
        <span className="mx-muted">{[locale === "zh" ? `${entry.row.sessions} 个交易日` : `${entry.row.sessions} trading days`, account].filter(Boolean).join(" · ")}</span>
      </p>
    );
  }
  return (
    <li className="mx-journal-item">
      <span className="mx-journal-date">{when}</span>
      <span className={"mx-journal-mark mx-journal-mark-" + mark} aria-hidden="true" />
      <div className="mx-journal-body">{body}</div>
      <span className="mx-journal-figure">{figure}</span>
      {expansion?.location === "recent" && entry.kind === "trade" && expansion.selected && entry.rows.includes(expansion.selected) &&
        <div className="mx-journal-reading">{expansion.reading}</div>}
    </li>
  );
}

/**
 * What happened lately, as one record: decisions with the side effects of their fills, holdings
 * that moved with nothing done, weights that drifted and cash that sat.
 */
export function RecentJournal({ decisions, evidence, accounts, showAccount, expansion, filter }: {
  expansion?: DecisionExpansion;
  filter?: "trades" | "falls" | null;
  decisions: ScopedDecision[];
  evidence: Evidence | null | undefined;
  accounts: DecisionAccount[];
  showAccount: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const all = journalEntries(decisions, filter === "trades" ? null : evidence, accounts);
  const entries = filter === "falls" ? all.flatMap((entry): JournalEntry[] => {
    if (entry.kind !== "moves") return [];
    const rows = entry.rows.filter(move => move.change < 0);
    return rows.length ? [{...entry, rows}] : [];
  }) : all;
  const rules = evidence?.rules;
  const partial = accounts.some((code) => evidence?.accounts?.[code]?.coverage === "partial");
  const percentage = (value: number) => Number((value * 100).toFixed(4));
  const volatility = rules?.sessionMoveVolatility;
  return (
    <Panel
      className="mx-review-journal-panel"
      title={t("最近", "Recently")}
      action={partial ? <Tag>{t("覆盖不全", "Partial coverage")}</Tag> : undefined}
      helpLabel={t("最近的记录", "Recent record")}
      help={rules && <>
        <p>{locale === "zh"
          ? "每天在同一账户里的买卖合成一条，金额是至今的结果；成交让最大持仓、现金或美元计价敞口的占比变动至少 1 个百分点时，标出变动前后。"
          : "Each day's trades in an account form one entry with their result to date. When the fills moved the largest holding, cash or USD-denominated exposure by at least a percentage point, the shares before and after are shown."}</p>
        <p>{volatility
          ? (locale === "zh"
            ? `没操作：当天没有买卖，且收盘涨跌幅达到 ${percentage(rules.sessionMoveShare)}% 与该持仓近期波动 ${volatility.multiple} 倍中的较高者。占比漂移：${rules.weightDriftDays} 个自然日内变动至少 ${percentage(rules.weightDriftShare)} 个百分点且没有买卖。现金偏多：连续至少 ${rules.cashMinSessions} 个交易日达到 ${percentage(rules.cashShare)}%。`
            : `No trade: no trade that day and a close-to-close move of at least the higher of ${percentage(rules.sessionMoveShare)}% and ${volatility.multiple} × the holding's recent volatility. Weight drift: a change of at least ${percentage(rules.weightDriftShare)} percentage points within ${rules.weightDriftDays} calendar days with no trades. Cash held: at least ${percentage(rules.cashShare)}% for ${rules.cashMinSessions} consecutive trading days.`)
          : (locale === "zh"
            ? `没操作：当天没有买卖，且收盘涨跌至少 ${percentage(rules.sessionMoveShare)}%。`
            : `No trade: a move of at least ${percentage(rules.sessionMoveShare)}% between closes with no trade that day.`)}</p>
      </>}
      helpBasis={rules && (locale === "zh"
        ? `最近 ${rules.evidenceDays} 天，每个账户最多 ${rules.recentFillLimit} 笔成交。占比以账户价值（含现金）为分母，按成交时已完成的收盘价和日汇率重算；美元敞口只计入以 USD 报价的持仓，不穿透基金。缺少价格、汇率或可核对的记录时不显示。`
        : `The last ${rules.evidenceDays} days, up to ${rules.recentFillLimit} fills per account. Shares use account value including cash, repriced at the latest completed closes and daily FX at each fill; USD exposure counts USD-quoted holdings without looking through funds. Rows without prices, FX or reconciled records are omitted.`)}
    >
      {entries.length ? (
        <>
          <ol className="mx-review-journal">
            {entries.slice(0, VISIBLE_ENTRIES).map((entry) => <JournalItem key={entry.key} entry={entry} showAccount={showAccount} expansion={expansion} />)}
          </ol>
          {entries.length > VISIBLE_ENTRIES && (
            <ReviewDisclosure label={t("更多记录", "More")}>
              <ol className="mx-review-journal">
                {entries.slice(VISIBLE_ENTRIES, VISIBLE_ENTRIES + MORE_ENTRIES).map((entry) => <JournalItem key={entry.key} entry={entry} showAccount={showAccount} expansion={expansion} />)}
              </ol>
            </ReviewDisclosure>
          )}
        </>
      ) : (
        <p className="mx-review-empty">{t("最近没有买卖或需要留意的变化", "Nothing traded or worth a note lately")}</p>
      )}
    </Panel>
  );
}

/** Every account, or one of them: the review's scope, as a switch beside its title. */
export function ScopeSwitch({ value, onChange }: { value: ReviewScope; onChange: (value: ReviewScope) => void }) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  return (
    <Segments
      label={t("复盘范围", "Review scope")}
      value={value}
      onChange={onChange}
      options={[
        { value: "all" as const, label: t("全部", "All") },
        ...(["A", "B", "C"] as const).map((code) => ({ value: code, label: accountName(profile, code) })),
      ]}
    />
  );
}

