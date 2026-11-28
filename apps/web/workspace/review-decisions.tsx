"use client";

import { quoteValue } from "./financial-values";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button, CloseButton } from "@/components/ui/button";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EChartsType as ECharts } from "echarts/core";
import type { ECElementEvent } from "echarts";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import type { AccountCode, DashboardLens } from "@/lib/types";
import { formatCalendarDate, formatDateSpan, formatReadingTime } from "@/ui/formatters";
import { api, currency, percent, tone } from "@/workspace/data";
import { Plot } from "./charts";
import { readingText, type Reading } from "./chart-readout";
import { ChartRecords, ChartRecordsPanel, ChartRecordsTrigger } from "./chart-records";
import { EvidenceTable } from "./evidence-table";
import { Help, Instrument, Metric, Panel, Segments, useCopy, useEscapeLayer } from "./foundation";
import Link from "./link";
import { filingLabel, ratingLabel } from "./market-terms";
import { ReadingCard } from "./reading-card";
import { minus } from "./reading-figures";
import { readingTone } from "./reading-format";
import { isImeComposing } from "./shortcut-platform";
import { SecurityPeek } from "./security-peek";
import type { ChartColours } from "@/ui/charts/palette";

export type AccountDecisions = NonNullable<DashboardLens["selectedAccountDecisions"]>;
export type TradeDecision = NonNullable<AccountDecisions["decisions"]>[number] & { reviewOrdinal?: number };
/** The optional ordinal distinguishes listings sharing a ticker, side and day. */
export type DecisionRef = Pick<TradeDecision, "date" | "side" | "ticker" | "reviewOrdinal">;
type ClosedTrade = NonNullable<AccountDecisions["closedTrades"]>[number];
type RoundTrip = NonNullable<AccountDecisions["roundTrips"]>[number];
type DecisionEvent = NonNullable<TradeDecision["events"]>[number];
export type Horizon = "horizon" | "date";
type ModelVersionAt = components["schemas"]["ModelVersionAt"];
type Copy = (zh: string, en: string) => string;

export function signedMoney(value: number | null | undefined, digits = 0) {
  if (value == null) return "—";
  const text = currency(value, "GBP", digits);
  return value > 0 && text !== currency(0, "GBP", digits) ? "+" + text : text;
}

/** An effect that rounds to £0, such as a decision made today, has no direction to colour. */
export function effectTone(value: number | null | undefined) {
  return value == null || Math.round(value) === 0 ? "flat" : tone(value);
}

/**
 * A decision with no close after its own yet, so nothing to judge it by. An
 * unchanged price after a few days is an outcome; only the count of later closes
 * tells them apart. Artifacts from before decisions-v3 do not carry the count and
 * read as observed unless they have no to-date return at all.
 */
export function observing(row: TradeDecision) {
  return row.observedDays != null ? row.observedDays < 1 : row.returnToDate == null;
}

/** Whether the chosen window has closes to judge the decision by. */
export function windowObserved(row: TradeDecision, horizon: Horizon) {
  if (horizon === "date") return !observing(row);
  return row.horizonComplete ?? row.effectHorizonGbp != null;
}

export function decisionEffect(row: TradeDecision, horizon: Horizon) {
  if (!windowObserved(row, horizon)) return null;
  return horizon === "horizon" ? row.effectHorizonGbp ?? null : row.effectToDateGbp ?? null;
}

/**
 * The horizon a review opens on. The review index shows a recent decision's effect to date, and most
 * recent ones are inside their first trading days: such a decision opens to date, so it has an outcome.
 */
export function openingHorizon(row?: TradeDecision): Horizon {
  return row && !windowObserved(row, "horizon") ? "date" : "horizon";
}

/** Horizon choices on one account review page, kept above the decisions panel so they outlive it. */
export type HorizonChoices = Partial<Record<string, Horizon>>;

/** Where a horizon choice is kept: one entry per account and decision, and one for each account's review without one. */
export function horizonScope(account: AccountCode | undefined, row?: DecisionRef) {
  const decision = row ? decisionParam(row) : "";
  const ordinal = row?.reviewOrdinal;
  return (account ?? "") + "\u0000" + decision + (ordinal == null ? "" : "/" + ordinal);
}

/**
 * The decision a link opens, as "date.side.ticker", such as 2026-10-14.sell.SEMI.AS.
 * The ticker comes last because tickers can carry dots: all after the second dot is the ticker.
 */
export function decisionParam(row: DecisionRef) {
  return row.date + "." + row.side + "." + row.ticker;
}

/** The decision a link names, or null when the value is not a real day, a side and a ticker. */
export function parseDecisionParam(value: string | null | undefined): DecisionRef | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.(buy|sell)\.(.+)$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const [, date, side, ticker] = match;
  if (ticker !== ticker.trim() || ticker.length > 64) return null;
  // The day must exist: 2026-02-30 is not one.
  const day = new Date(date + "T00:00:00Z");
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return null;
  return { date, side: side === "buy" ? "buy" : "sell", ticker };
}

export function sameDecision(row: DecisionRef, other: DecisionRef) {
  return row.date === other.date && row.side === other.side && row.ticker === other.ticker;
}

/**
 * The row a pinned decision is in after its rows are fetched again: the same object, else the same
 * decision in the same account, matched by the account's code (never its editable display name)
 * and, for two securities sharing a ticker, by the published ordinal.
 */
export function followDecision<T extends TradeDecision>(rows: readonly T[], pinned: T): T | undefined {
  const account = (row: TradeDecision) => (row as TradeDecision & { account?: string }).account;
  return rows.find((row) => row === pinned)
    ?? rows.find((row) => sameDecision(row, pinned)
      && (row.reviewOrdinal ?? null) === (pinned.reviewOrdinal ?? null)
      && account(row) === account(pinned));
}

/**
 * React keys for a list of decisions: the day, side and ticker, and the account where a list spans two.
 * A lone decision's key never depends on its display name, context line or place in the list, so a
 * name correction or a refetch keeps its row and focus. Only when that repeats, as for two securities
 * sharing a ticker, does the key include its published ordinal. Older callers fall back to name and occurrence.
 */
export function decisionKeys(rows: Array<DecisionRef & { name: string; account?: string }>) {
  const tuple = (row: DecisionRef & { account?: string }) => [row.account ?? "", row.date, row.side, row.ticker].join("\u0000");
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(tuple(row), (counts.get(tuple(row)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = tuple(row);
    if (row.reviewOrdinal != null) return key + "\u0000" + row.reviewOrdinal;
    if (counts.get(key) === 1) return key;
    const named = key + "\u0000" + row.name;
    const repeat = seen.get(named) ?? 0;
    seen.set(named, repeat + 1);
    return repeat ? named + "\u0000" + repeat : named;
  });
}

/**
 * The decision a link names, when exactly one fits. A link names a day, a side and a ticker, and two
 * securities can share a ticker: when more than one fits, it opens none, so the review never leads
 * with a decision that may not be the one meant.
 */
export function linkedDecision(rows: TradeDecision[] | null | undefined, ref: DecisionRef | null | undefined) {
  if (!ref) return undefined;
  const matches = (rows ?? []).filter((row) => sameDecision(row, ref));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * What a decision says in place of an effect while the chosen window has none, alike on its row and
 * on its timeline point: observing until a close follows it; then, while the window is still short,
 * how many of its trading days have passed; once its closes are there but the result is not, as when
 * an exchange rate is late, that the data is pending. Null once the window has an outcome, even £0.
 */
export function pendingOutcome(row: TradeDecision, horizon: Horizon, days: number, t: Copy, locale: "zh" | "en") {
  if (decisionEffect(row, horizon) != null) return null;
  if (row.unpriced) return t("行情缺失，未计入", "Unmeasured · price unavailable");
  if (observing(row)) return t("观察中", "Observing");
  const observed = row.observedDays;
  if (horizon === "horizon" && !row.horizonComplete && observed != null && observed < days)
    return locale === "zh" ? `${observed} / ${days} 个交易日` : `${observed} of ${days} trading days`;
  return t("等待数据", "Awaiting data");
}

/**
 * The review index's decisions across both investing accounts: how many still wait
 * for a close, counted by the lens before it keeps the latest few, the securities
 * of those it kept, and the latest decisions with an outcome.
 */
export function latestDecisions(reviews: DashboardLens["decisionReviews"], limit = 8) {
  const accounts = (["A", "B"] as const).map((code) => [code, reviews?.[code]] as const);
  const rows = accounts
    .flatMap(([code, review]) => (review?.decisions ?? []).map((row) => ({ ...row, account: code })))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.amountGbp ?? 0) - (a.amountGbp ?? 0));
  const kept = rows.filter(observing);
  // Payloads from before the count fall back to the rows they carry.
  const count = accounts.reduce(
    (sum, [, review]) => sum + (review?.observingCount ?? (review?.decisions ?? []).filter(observing).length),
    0,
  );
  return {
    watchingCount: count,
    watching: [...new Set(kept.map((row) => row.ticker))],
    // The lens kept only the latest; earlier ones may be in other securities.
    watchingMore: count > kept.length,
    recent: rows.filter((row) => !observing(row)).slice(0, limit),
  };
}

/**
 * What a side's effect means in words, so the reader never decodes a sign:
 * buys gained or lost; sells gave up gains or avoided losses against holding.
 */
export function verdictWord(side: "buy" | "sell", effect: number, t: Copy) {
  const rounded = Math.round(effect);
  if (!rounded) return "";
  if (side === "buy") return rounded > 0 ? t("赚", "gained") : t("亏", "lost");
  return rounded > 0 ? t("少亏", "avoided") : t("少赚", "gave up");
}

/**
 * How many of a side's decisions came out favourable, in the words their effect takes: buys that
 * gained and sales that avoided a loss, dividends included, as the help defines them. It counts
 * outcomes, not verdicts, and not price moves: a flat close that paid a dividend is a gain.
 */
export function favourableCount(side: "buy" | "sell", favourable: number, evaluated: number, locale: "zh" | "en") {
  if (side === "buy") return locale === "zh" ? `赚 ${favourable} / ${evaluated} 次` : `Gained after ${favourable} of ${evaluated} ${evaluated === 1 ? "buy" : "buys"}`;
  return locale === "zh" ? `少亏 ${favourable} / ${evaluated} 次` : `Avoided losses after ${favourable} of ${evaluated} ${evaluated === 1 ? "sell" : "sells"}`;
}

/** What a decision did, for a list that mixes sides: a T day names the side of the shares beyond its round trip. */
export function decisionAction(row: Pick<TradeDecision, "kind" | "side">, t: Copy) {
  if (row.kind === "T") return row.side === "buy" ? t("日内往返后净买入 ", "Net bought after a round trip ") : t("日内往返后净卖出 ", "Net sold after a round trip ");
  return row.side === "buy" ? t("买入 ", "Bought ") : t("卖出 ", "Sold ");
}

/** One dated company event in a few words, beside the decision it may explain. */
export function eventLabel(event: DecisionEvent, t: Copy) {
  const firm = event.firm ?? "";
  const to = event.toGrade ? ratingLabel(event.toGrade, t) : "";
  if (event.kind === "earnings") {
    if (event.surprisePct == null) return t("财报", "Results");
    const surprise = (event.surprisePct >= 0 ? "+" : "") + event.surprisePct.toFixed(1) + "%";
    return event.surprisePct >= 0 ? t("财报超预期 ", "Results beat ") + surprise : t("财报不及预期 ", "Results missed ") + surprise;
  }
  if (event.kind === "downgrade") return (firm + t(" 下调", " downgrade") + (to ? t("至", " to ") + to : "")).trim();
  if (event.kind === "upgrade") return (firm + t(" 上调", " upgrade") + (to ? t("至", " to ") + to : "")).trim();
  if (event.kind === "initiate") return (firm + t(" 首次覆盖", " initiates") + (to ? t("：", " ") + to : "")).trim();
  if (event.kind === "filing") return event.form ? filingLabel(event.form, t) : t("监管披露", "Filing");
  return event.title ?? "";
}

/** What the market did over the same window, and the company events within it. */
export function decisionContext(row: TradeDecision, horizon: Horizon, t: Copy, locale: "zh" | "en") {
  const market = horizon === "horizon" ? row.marketReturnHorizon : row.marketReturnToDate;
  return [
    // Only the window being read decides: a complete 20-day benchmark stays even
    // when the price later came back to where it started.
    ...(market == null || !windowObserved(row, horizon) ? [] : [t("标普 500 同期 ", "S&P 500 over the same days ") + percent(market, true, 1)]),
    ...(row.events ?? []).map((event) => formatCalendarDate(event.date, locale) + " " + eventLabel(event, t)),
  ];
}

/**
 * How many context items fit on a line of the given width, and where the "+N"
 * button starts after them: the first item always shows, shrinking with an
 * ellipsis if it must, and while any stay hidden the button keeps its room.
 */
export function contextFit(widths: number[], room: number, gap: number, more: number) {
  let used = 0;
  let shown = 0;
  for (const [index, width] of widths.entries()) {
    const next = used + (index ? gap : 0) + width;
    const reserve = index < widths.length - 1 ? gap + more : 0;
    if (shown && next + reserve > room) break;
    used = next;
    shown = index + 1;
  }
  return { shown, at: Math.max(0, Math.min(used + gap, room - more)) };
}

type Placement = { items: string; shown: number; clipped?: boolean; left?: number; top?: number; room?: number };

/**
 * One decision as a link over its whole row: the security, its effect and a line of
 * context beneath, so any of it opens the security's research and its text selects
 * like any link's. Context that does not fit collapses into a "+N" button beside the
 * link, placed where the shown items end, that opens the whole line the same way for
 * pointer, touch, keyboard and screen reader.
 */
function DecisionEntry({
  href,
  context,
  label,
  children,
}: {
  href: string;
  context: string[];
  label: string;
  children: ReactNode;
}) {
  const t = useCopy();
  const entry = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const heading = useId();
  const items = context.join("\u0000");
  const [measured, setMeasured] = useState<Placement>({ items, shown: context.length });
  // A placement holds for the items it was measured with. New items, as when a refetch
  // updates the benchmark, lay out in full to be measured again, while the row, its link
  // and any focus on them stay.
  const place = measured.items === items ? measured : { items, shown: context.length };
  const [opened, setOpened] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const row = entry.current;
    const element = line.current;
    const more = button.current;
    if (!row || !element || !more) return;
    // Measured while every item is laid out, once for each set of items; later fits reuse the
    // widths. The first item may be shrunk with an ellipsis, so then its full width is its scroll width.
    const widths = Array.from(element.querySelectorAll<HTMLElement>("[data-item]"), (item) => {
      const width = item.getBoundingClientRect().width;
      return item.scrollWidth > item.clientWidth ? Math.max(width, item.scrollWidth) : width;
    });
    // The button's padding reaches into its margins, so its room on the line is its width less them.
    const margins = getComputedStyle(more);
    const width = more.getBoundingClientRect().width + parseFloat(margins.marginLeft) + parseFloat(margins.marginRight);
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    const fit = () => {
      const available = element.clientWidth;
      const { shown, at } = contextFit(widths, available, gap, width);
      const clipped = widths[0] > available;
      const origin = row.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const left = box.left - origin.left + at;
      const top = box.top - origin.top;
      setMeasured((current) =>
        current.items === items && current.shown === shown && current.clipped === clipped && current.left === left && current.top === top
          ? current
          : { items, shown, clipped, left, top, room: gap + width },
      );
      if (shown < widths.length || clipped) return;
      // Everything fits, so the button hides: focus on it or in its list moves to the
      // row's link rather than falling to the page, and the list closes.
      const active = document.activeElement;
      if (active === more || list.current?.contains(active)) link.current?.focus();
      setOpened(false);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    // The line also moves when the row above it changes height, as when its details wrap.
    observer.observe(row);
    return () => observer.disconnect();
  }, [items]);
  const hidden = context.length - place.shown;
  const hasMore = hidden > 0 || place.clipped;
  return (
    <div ref={entry} className="mx-decision-entry">
      <Link ref={link} className="mx-row-link mx-decision-row" href={href}>
        {children}
        {context.length > 0 && (
          <span ref={line} className="mx-decision-context" style={hasMore ? { paddingInlineEnd: place.room } : undefined}>
            {context.map((item, index) => (
              <span key={index} data-item="" hidden={index >= place.shown}>
                {item}
              </span>
            ))}
          </span>
        )}
      </Link>
      {context.length > 0 && (
        <Popover open={opened} onOpenChange={setOpened} modal="trap-focus">
          <PopoverTrigger render={
            <Button
              ref={button}
              variant="ghost"
              size={null}
              className="mx-decision-more absolute border-0 text-xs leading-[inherit]"
              data-idle={hasMore ? undefined : ""}
              aria-haspopup="dialog"
              aria-expanded={opened}
              style={{ left: place.left, top: place.top }}
            >
              +{hidden || (hasMore ? 1 : context.length)}
              <span className="sr-only">{t(" 项", " more")}</span>
            </Button>
          } />
          <PopoverContent ref={list} className="mx-help-popover" aria-labelledby={heading}
            align="end" sideOffset={8} initialFocus={close} finalFocus={button}>
            <div className="mx-help-heading">
              <strong id={heading}>{label}</strong>
              <CloseButton ref={close} aria-label={t("关闭", "Close")} onClick={() => setOpened(false)} />
            </div>
            <ul className="mx-help-body mx-decision-more-list [overflow-wrap:anywhere]">
              {context.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** Totals for one side at a horizon; a decision counts once its horizon has passed. */
export function sideVerdict(rows: TradeDecision[], side: "buy" | "sell", horizon: Horizon) {
  const scored = rows.filter((row) => row.side === side && decisionEffect(row, horizon) != null);
  return {
    count: rows.filter((row) => row.side === side).length,
    evaluated: scored.length,
    favourable: scored.filter((row) => (decisionEffect(row, horizon) ?? 0) > 0).length,
    effect: scored.reduce((total, row) => total + (decisionEffect(row, horizon) ?? 0), 0),
  };
}

/** The decisions that mattered most, in each direction, for one side. */
export function notableDecisions(rows: TradeDecision[], side: "buy" | "sell", horizon: Horizon, limit = 5) {
  const scored = rows.filter((row) => row.side === side && decisionEffect(row, horizon) != null);
  const by = (sign: 1 | -1) =>
    scored
      .filter((row) => sign * (decisionEffect(row, horizon) ?? 0) > 0)
      .sort((a, b) => sign * ((decisionEffect(b, horizon) ?? 0) - (decisionEffect(a, horizon) ?? 0)))
      .slice(0, limit);
  return { worst: by(-1), best: by(1) };
}

/**
 * The decisions that helped and cost the most at a horizon, buys and sells together: an effect is
 * always measured against not trading, so a sale that avoided a fall helps like a buy that rose.
 */
export function decisionExtremes<T extends TradeDecision>(rows: T[], horizon: Horizon, limit = 4) {
  const scored = rows.filter((row) => Math.round(decisionEffect(row, horizon) ?? 0) !== 0);
  const by = (sign: 1 | -1) =>
    scored
      .filter((row) => sign * (decisionEffect(row, horizon) ?? 0) > 0)
      .sort((a, b) => sign * ((decisionEffect(b, horizon) ?? 0) - (decisionEffect(a, horizon) ?? 0)))
      .slice(0, limit);
  return { helped: by(1), cost: by(-1) };
}

/**
 * One decision: the security, its effect over "date · amount · then", and the arrow to its research.
 * A decision shown on its own also names its side. Until its window has closes to judge it by, it
 * says where it stands in place of an effect: observing, or how many of the trading days have passed.
 */
export function DecisionRow({ row, horizon, days = 20, sided = false }: { row: TradeDecision; horizon: Horizon; days?: number; sided?: boolean }) {
  const t = useCopy();
  const { locale } = useLocale();
  const effect = decisionEffect(row, horizon);
  const change = effect == null ? null : horizon === "horizon" ? row.returnHorizon : row.returnToDate;
  const context = decisionContext(row, horizon, t, locale);
  const state = pendingOutcome(row, horizon, days, t, locale);
  // A list titled by its side names only a T; a decision on its own says what it did.
  const action = sided ? decisionAction(row, t) : row.kind === "T" ? t("日内往返后净额 ", "Net after a round trip ") : "";
  return (
    <DecisionEntry
      href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}
      context={context}
      label={row.ticker + " · " + formatCalendarDate(row.date, locale)}
    >
      <SecurityPeek ticker={row.ticker}>
        <Instrument ticker={row.ticker} name={row.name} small />
      </SecurityPeek>
      <span className={"mx-row-value mx-" + effectTone(effect)}>
        <span className={state ? "mx-muted" : undefined}>{state ?? signedMoney(effect)}</span>
        <small>
          {formatCalendarDate(row.date, locale)} · {action}
          {currency(row.amountGbp)}
          {change != null && " · " + t("之后 ", "then ") + percent(change, true, 1)}
        </small>
      </span>
      <ArrowUpRight size={16} aria-hidden="true" />
    </DecisionEntry>
  );
}

/** How a decision names itself in a reading: "AMD 买入" in Chinese, "Bought AMD" in English. */
function decisionName(row: TradeDecision, t: Copy, locale: "zh" | "en") {
  const action = decisionAction(row, t).trim();
  return locale === "zh" ? row.ticker + " " + action : action + " " + row.ticker;
}

/**
 * A timeline point's reading: the day, ticker, side and amount on top; the outcome as the one
 * figure, in gain or loss colour, or what it still waits for; then at most two dated events.
 */
export function decisionReading(row: TradeDecision, horizon: Horizon, days: number, t: Copy, locale: "zh" | "en", account?: string): Reading {
  const effect = decisionEffect(row, horizon);
  const change = horizon === "horizon" ? row.returnHorizon : row.returnToDate;
  const events = row.events ?? [];
  return {
    time: [formatCalendarDate(row.date, locale), account, decisionName(row, t, locale) + " " + currency(row.amountGbp)]
      .filter(Boolean).join(" · "),
    primary: effect != null
      ? {
          label: t("之后", "Then"),
          value: minus(signedMoney(effect)),
          detail: change == null ? undefined : minus(percent(change, true, 1)),
          tone: readingTone(effect, 0),
        }
      : { value: pendingOutcome(row, horizon, days, t, locale) ?? "—" },
    groups: events.length
      ? [events.slice(0, 2).map((event) => ({ label: formatCalendarDate(event.date, locale), value: minus(eventLabel(event, t)) }))]
      : undefined,
    more: events.length > 2 ? events.length - 2 : undefined,
  };
}

/**
 * The timeline's points by side, buys then sells: one for each decision, so decisions made on the
 * same day keep their own outcome and reading. The decision the page opened on is drawn last, over
 * the others. The keyboard steps through every point by date.
 */
export function timelinePoints(rows: TradeDecision[], focus?: TradeDecision) {
  const sides = (["buy", "sell"] as const).map((side) =>
    rows.filter((row) => row.side === side && row !== focus).concat(focus?.side === side ? [focus] : []));
  const marks = sides
    .flatMap((points, seriesIndex) => points.map((row, dataIndex) => ({ row, seriesIndex, dataIndex })))
    .sort((a, b) => a.row.date.localeCompare(b.row.date));
  return { sides, marks };
}

/**
 * Every decision by date and effect; the one the page opened on is larger, ringed and drawn on top.
 * Picking a point, by pointer or with Enter, opens that decision; across accounts, each reading names
 * its account.
 */
export function DecisionTimeline({ rows, horizon, days, focus, onPick, accountOf, recordsAccountOf, decisionUrl }: {
  rows: TradeDecision[];
  horizon: Horizon;
  days: number;
  focus?: TradeDecision;
  onPick?: (row: TradeDecision) => void;
  accountOf?: (row: TradeDecision) => string | undefined;
  recordsAccountOf?: (row: TradeDecision) => string | undefined;
  decisionUrl?: (row: TradeDecision) => string;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  // The chart's option only changes with its data: a new option resets ECharts, which would
  // drop a tooltip the keyboard just opened.
  const chart = useRef<ECharts | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const { sides, marks } = useMemo(() => timelinePoints(rows, focus), [rows, focus]);
  const largest = useMemo(() => Math.max(1, ...rows.map((row) => row.amountGbp ?? 0)), [rows]);
  const point = useCallback((row: TradeDecision, colours: ChartColours) => {
    const effect = decisionEffect(row, horizon);
    const colour = effect == null || effect === 0 ? colours.axis : effect > 0 ? colours.positive : colours.negative;
    const size = 6 + 16 * Math.sqrt(Math.max(0, row.amountGbp ?? 0) / largest);
    const ring = row === focus ? { borderColor: colours.text, borderWidth: 2 } : null;
    return {
      value: [Date.parse(row.date), effect ?? 0],
      symbolSize: ring ? Math.max(16, size + 8) : size,
      itemStyle: effect == null
        ? { color: "transparent", borderColor: colour, borderWidth: 1.5, ...ring }
        : { color: colour, opacity: ring ? 1 : 0.85, ...ring },
      row,
    };
  }, [focus, horizon, largest]);
  const reading = useCallback(
    (row: TradeDecision) => decisionReading(row, horizon, days, t, locale, accountOf?.(row)),
    [accountOf, days, horizon, locale, t],
  );
  const option = useCallback((colours: ChartColours) => ({
    grid: { top: 40, right: 18, bottom: 30, left: 64 },
    // Readings render as a React ReadingCard overlay rather than an ECharts HTML tooltip sink.
    tooltip: { show: false },
    xAxis: { type: "time" as const, axisLabel: { formatter: (value: number) => formatCalendarDate(new Date(value).toISOString().slice(0, 10), locale) } },
    yAxis: {
      type: "value" as const,
      axisLabel: { formatter: (value: number) => minus(signedMoney(value)) },
    },
    series: (["buy", "sell"] as const).map((side, index) => ({
      type: "scatter" as const,
      name: side === "buy" ? t("买入", "Buys") : t("卖出", "Sells"),
      symbol: side === "buy" ? "circle" : "diamond",
      itemStyle: { color: colours.axis },
      // Later points draw over earlier ones, and the opened decision's series over the other.
      z: focus?.side === side ? 3 : 2,
      data: sides[index].map((row) => point(row, colours)),
      markLine: side === "buy"
        ? { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: colours.axis, type: "solid" as const, width: 1 }, label: { show: false } }
        : undefined,
    })),
    legend: { top: 0, right: 0, data: [t("买入", "Buys"), t("卖出", "Sells")] },
  }), [focus, locale, point, sides, t]);
  const [hovered, setHovered] = useState<DecisionPoint | null>(null);
  // A tap pins its reading in the phone strip until it is closed, another point is tapped or the
  // reader taps outside; hover events do not clear it.
  const [tapped, setTapped] = useState<DecisionPoint | null>(null);
  const [tapSpoken, setTapSpoken] = useState("");
  const [step, setStep] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const pointer = useRef<string>("mouse");
  const seriesNames = [t("买入", "Buys"), t("卖出", "Sells")];
  const names = useRef(seriesNames);
  // The series a reader has hidden from the legend, read from the chart so a reset option or a
  // scheme switch (which restores the legend) can never disagree with it.
  const visibleSeries = () => {
    const selected = (chart.current?.getOption() as { legend?: Array<{ selected?: Record<string, boolean> }> } | undefined)
      ?.legend?.[0]?.selected ?? {};
    return new Set([0, 1].filter((index) => selected[names.current[index]] !== false));
  };
  const pointOf = (event: ECElementEvent | null): DecisionPoint | null => {
    const row = event?.componentType === "series"
      ? (event.data as { row?: TradeDecision } | undefined)?.row : undefined;
    // ECharts clones the option data. Track the input rows separately to expire a reading on refresh.
    return row ? { row, seriesIndex: event?.seriesIndex ?? 0, source: rows } : null;
  };
  const readPoint = (event: ECElementEvent | null) => {
    const next = pointOf(event);
    setHovered(next);
    if (next) setStep(null);
    return next?.row;
  };
  const clearTap = () => {
    setTapped(null);
    setTapSpoken("");
  };
  const stepped = step != null && marks[step] ? marks[step] : null;
  const shownHover = hovered?.source === rows ? hovered : null;
  // A tap opens its decision, which can refetch the rows: the pinned reading follows the same
  // decision into the new rows and closes once it is gone.
  const shownTap = useMemo(() => {
    if (!tapped) return null;
    const row = followDecision(rows, tapped.row);
    return row ? { ...tapped, row, source: rows } : null;
  }, [rows, tapped]);
  if (tapped && !shownTap) {
    setTapped(null);
    setTapSpoken("");
  }
  const active = stepped ?? shownTap ?? shownHover;
  const activeReading = active ? reading(active.row) : null;
  const activeSeries = useRef<number | null>(null);
  useLayoutEffect(() => {
    names.current = seriesNames;
    activeSeries.current = active?.seriesIndex ?? null;
  });
  // Hiding a series in the legend closes a reading of one of its decisions.
  const bound = useRef<WeakSet<ECharts>>(new WeakSet());
  useEffect(() => {
    const instance = chart.current;
    if (!instance || instance.isDisposed() || bound.current.has(instance)) return;
    bound.current.add(instance);
    instance.on("legendselectchanged", (event) => {
      const selected = (event as { selected?: Record<string, boolean> }).selected ?? {};
      const series = activeSeries.current;
      if (series == null || selected[names.current[series]] !== false) return;
      setHovered(null);
      setStep(null);
      clearTap();
    });
  });
  useLayoutEffect(() => {
    const card = tipRef.current;
    const instance = chart.current;
    if (!card || !active || !instance || instance.isDisposed()) return;
    const position = () => {
      if (instance.isDisposed()) return;
      const point = instance.convertToPixel(
        { seriesIndex: active.seriesIndex },
        [Date.parse(active.row.date), decisionEffect(active.row, horizon) ?? 0],
      );
      if (!Array.isArray(point) || !point.every(Number.isFinite)) return;
      const offset = 20;
      const place = (value: number, size: number, limit: number) => {
        const after = value + offset;
        return Math.max(0, Math.min(after + size <= limit ? after : value - offset - size, limit - size));
      };
      const left = place(point[0], card.offsetWidth, instance.getWidth());
      const top = place(point[1], card.offsetHeight, instance.getHeight());
      card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      card.style.visibility = "visible";
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(instance.getDom());
    resize.observe(card);
    return () => resize.disconnect();
  }, [active, horizon]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance || instance.isDisposed()) return;
    instance.dispatchAction({ type: "downplay" });
    if (stepped) {
      instance.dispatchAction({ type: "highlight", seriesIndex: stepped.seriesIndex, dataIndex: stepped.dataIndex });
    }
  }, [stepped]);
  // A pinned tap closes from outside the timeline, like the other charts' pinned readings.
  useEffect(() => {
    if (!shownTap) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) clearTap();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [shownTap]);
  useEscapeLayer(active != null, host, () => {
    setHovered(null);
    setStep(null);
    clearTap();
  });
  // Hover never speaks; keyboard steps and taps update the live region once each.
  const spoken = stepped ? readingText(reading(stepped.row), locale) : shownTap ? tapSpoken : "";
  return (
    <div ref={host} className="mx-decision-timeline min-w-0" onPointerDownCapture={(event) => {
      pointer.current = event.pointerType;
    }} onKeyDownCapture={(event) => {
      // The chart's own keys step through its first series only; these reach every visible decision.
      if (isImeComposing(event) || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key) || !marks.length || !chart.current) return;
      if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "group") return;
      event.preventDefault();
      event.stopPropagation();
      const visible = visibleSeries();
      if (event.key === "Enter") {
        if (stepped && visible.has(stepped.seriesIndex)) onPick?.(stepped.row);
        return;
      }
      const next = stepVisibleMark(marks, visible, step, event.key as "ArrowLeft" | "ArrowRight" | "Home" | "End");
      setHovered(null);
      clearTap();
      setStep(next);
    }} onBlur={(event) => {
      if (step == null || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setStep(null);
    }}>
      <Plot
        research
        controller={chart}
        label={t("买卖决定的时间线", "Timeline of buy and sell decisions")}
        height={340}
        option={option}
        pin={shownTap && activeReading && active === shownTap ? { reading: activeReading, onClose: clearTap } : null}
        onPointHover={readPoint}
        pointInstructions={t(
          "左右方向键查看相邻决定，Home 和 End 到首尾，Enter 打开决定，Escape 关闭读数。轻点标记可查看读数并打开该决定。",
          "Use the left and right arrows to read adjacent decisions, Home and End for the first and last, Enter to open a decision, and Escape to dismiss a reading. Tap a mark to read and open its decision.",
        )}
        onPointClick={(event) => {
          const picked = pointOf(event);
          if (!picked) return;
          if (pointer.current === "touch") {
            setHovered(null);
            setStep(null);
            setTapped(picked);
            setTapSpoken(readingText(reading(picked.row), locale));
          } else {
            readPoint(event);
          }
          onPick?.(picked.row);
        }}
        overlay={activeReading && active !== shownTap && (
          <div ref={tipRef} className="mx-chart-popup mx-reading-tooltip" aria-hidden="true">
            <ReadingCard reading={activeReading} />
          </div>
        )}
      />
      <span className="sr-only" aria-live="polite" aria-atomic="true">{spoken}</span>
      {marks.length > 0 && <ChartRecordsPanel>
        <EvidenceTable chart label={t("买卖决定的时间线", "Timeline of buy and sell decisions")} rows={marks} columns={[
          { label: t("日期", "Date"), value: ({ row }) => formatCalendarDate(row.date, locale) },
          { label: t("决定", "Decision"), value: ({ row }) => {
            const name = decisionName(row, t, locale);
            return decisionUrl ? <Link className="mx-text-link" href={decisionUrl(row)}>{name}</Link> : name;
          } },
          ...(recordsAccountOf ? [{ label: t("账户", "Account"), value: ({ row }: (typeof marks)[number]) => recordsAccountOf(row) }] : []),
          { label: t("结果 · GBP", "Outcome · GBP"), numeric: true, value: ({ row }) => signedMoney(decisionEffect(row, horizon), 2) },
        ]} />
      </ChartRecordsPanel>}
    </div>
  );
}

type DecisionPoint = { row: TradeDecision; seriesIndex: number; source: TradeDecision[] };

/** The next decision for the timeline's keys, skipping series hidden from the legend. */
export function stepVisibleMark(
  marks: ReadonlyArray<{ seriesIndex: number }>,
  visible: ReadonlySet<number>,
  step: number | null,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): number | null {
  const order = marks.flatMap((mark, index) => (visible.has(mark.seriesIndex) ? [index] : []));
  if (!order.length) return null;
  if (key === "Home") return order[0];
  if (key === "End") return order[order.length - 1];
  const at = step == null ? -1 : order.indexOf(step);
  if (at < 0) return key === "ArrowLeft" ? order[order.length - 1] : order[0];
  return order[Math.max(0, Math.min(order.length - 1, at + (key === "ArrowRight" ? 1 : -1)))];
}

/** How the same-day round trips did, and how much of each day's range they took. */
export function roundTripVerdict(summary: AccountDecisions["roundTripSummary"] | undefined) {
  const ranged = summary?.ranged ?? 0;
  const range = summary?.rangeGbp ?? 0;
  return {
    count: summary?.count ?? 0,
    favourable: summary?.favourable ?? 0,
    result: summary?.resultGbp ?? 0,
    range: ranged ? range : null,
    captured: ranged && range > 0 ? (summary?.rangedResultGbp ?? 0) / range : null,
  };
}

export function RoundTrips({ data }: { data: AccountDecisions }) {
  const t = useCopy();
  const { locale } = useLocale();
  const verdict = roundTripVerdict(data.roundTripSummary);
  if (!verdict.count) return null;
  const rows = (data.roundTrips ?? []).toReversed();
  const largest = rows.toSorted((a, b) => Math.abs(b.resultGbp) - Math.abs(a.resultGbp)).slice(0, 5);
  const columns = [
    { label: t("日期", "Date"), value: (row: RoundTrip) => formatCalendarDate(row.date, locale) },
    {
      label: t("名称", "Name"),
      value: (row: RoundTrip) => (
        <Link href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}>{row.ticker}</Link>
      ),
    },
    { label: t("股数", "Shares"), value: (row: RoundTrip) => row.matchedQuantity.toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", { maximumFractionDigits: 4 }), numeric: true },
    { label: t("买入均价", "Average buy"), value: (row: RoundTrip) => quoteValue(row.buyAverageGbp, "GBP"), numeric: true },
    { label: t("卖出均价", "Average sell"), value: (row: RoundTrip) => quoteValue(row.sellAverageGbp, "GBP"), numeric: true },
    { label: t("结果", "Result"), value: (row: RoundTrip) => <span className={"mx-" + tone(row.resultGbp)}>{signedMoney(row.resultGbp, 2)}</span>, numeric: true },
    { label: t("当日价差上限", "Day's range"), value: (row: RoundTrip) => (row.rangeGbp == null ? "—" : currency(row.rangeGbp, "GBP", 2)), numeric: true },
  ];
  return (
    <Panel
      className="mx-decision-table"
      title={t("日内往返", "Same-day round trips")}
      help={t(
        "同一天买入又卖出同一代码时，配对的股数算一次往返：结果是（卖出均价 − 买入均价）× 股数，已扣除费用。当日价差上限是同样股数在当天最高价与最低价之间能赚到的最多金额，用来对照，不是事先可以做到的策略。多买或多卖的部分仍作为买卖决定计算。",
        "When the same ticker is bought and sold on the same day, the matched shares are a round trip: (average sell − average buy) × shares, after costs. The day's range is the most the same shares could have taken between that day's high and low; it is a yardstick, not a strategy available in advance. Shares bought or sold beyond the round trip still count as buy or sell decisions.",
      )}
    >
      <div className="mx-metric-grid mx-metric-grid-three">
        <Metric label={t("当日价差上限", "Day's range on those shares")} value={verdict.range == null ? "—" : currency(verdict.range)} />
        <Metric label={t("抓住的价差", "Share of the range taken")} value={verdict.captured == null ? "—" : percent(verdict.captured, false, 0)} />
      </div>
      <EvidenceTable label={t("结果最大的日内往返", "Largest round trips")} rows={largest} columns={columns} />
      {rows.length > largest.length && (
        <details className="mx-chart-data">
          <summary>{locale === "zh" ? `全部 ${rows.length} 次` : `All ${rows.length} round trips`}</summary>
          <EvidenceTable label={t("日内往返记录", "Same-day round trips")} rows={rows} pageSize={20} showCount={false} columns={columns} />
        </details>
      )}
    </Panel>
  );
}

/** Closed trades beside the best close while they were held: what selling then would have made. */
export function BestCloses({ rows }: { rows: ClosedTrade[] }) {
  const t = useCopy();
  const { locale } = useLocale();
  if (!rows.length) return null;
  const givenBack = rows.reduce((total, row) => total + (row.givenBackGbp ?? 0), 0);
  const largest = rows.slice(0, 5);
  const columns = [
    {
      label: t("名称", "Name"),
      value: (row: ClosedTrade) => (
        <Link href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}>
          {row.ticker}
        </Link>
      ),
    },
    { label: t("持有", "Held"), value: (row: ClosedTrade) => formatDateSpan(row.start, row.end, locale) },
    { label: t("实际结果", "Actual"), value: (row: ClosedTrade) => <span className={"mx-" + tone(row.actualGbp)}>{signedMoney(row.actualGbp)}</span>, numeric: true },
    { label: t("最高收盘卖出", "At the best close"), value: (row: ClosedTrade) => signedMoney(row.bestExitGbp), numeric: true },
    { label: t("最低收盘卖出", "At the worst close"), value: (row: ClosedTrade) => signedMoney(row.worstCloseGbp), numeric: true },
    { label: t("少赚", "Left behind"), value: (row: ClosedTrade) => currency(row.givenBackGbp), numeric: true },
  ];
  return (
    <Panel
      className="mx-decision-table"
      title={t("与持有期最高收盘对照", "Against the best close while held")}
      help={t(
        "按建仓日收盘价估算：若在持有期内最高或最低收盘价全部卖出，结果会是多少。用于看清每笔交易错过了多少，而不是可以事先做到的策略。",
        "Estimated from the close on the opening day: the result of selling everything at the highest or lowest close while held. It shows what each trade left behind, not a strategy available in advance.",
      )}
    >
      <div className="mx-metric-grid mx-metric-grid-three">
        <Metric
          label={t("比持有期最高收盘少赚", "Below the best close while held")}
          value={currency(givenBack)}
          note={locale === "zh" ? `${rows.length} 笔已结束交易` : `${rows.length} closed trades`}
        />
      </div>
      <EvidenceTable label={t("少赚最多的已结束交易", "Closed trades that left the most behind")} rows={largest} columns={columns} />
      {rows.length > largest.length && (
        <details className="mx-chart-data">
          <summary>{locale === "zh" ? `全部 ${rows.length} 笔` : `All ${rows.length} closed trades`}</summary>
          <EvidenceTable label={t("已结束交易与持有期最高收盘对照", "Closed trades against the best close while held")} rows={rows} pageSize={20} showCount={false} columns={columns} />
        </details>
      )}
    </Panel>
  );
}

/**
 * The horizon a review reads at, kept per account and decision so it outlives the panels that show
 * it. A decision keeps the horizon it opened on until the reader chooses another; letting go of a
 * decision leaves the review beneath on the horizon that decision showed, so the figures stay put.
 */
export function useDecisionHorizon(
  account: AccountCode | undefined,
  focused: TradeDecision | undefined,
  horizons: HorizonChoices,
  onHorizons: Dispatch<SetStateAction<HorizonChoices>>,
) {
  const scope = horizonScope(account, focused);
  const ordinary = horizonScope(account);
  const horizon = horizons[scope] ?? openingHorizon(focused);
  // A decision's opening horizon is kept the first time it is shown, so a refetch that completes its
  // window leaves the figures the reader is looking at; only the reader's own choice changes it.
  // React runs this before any later update, such as a refetch, is drawn.
  const keep = useEffectEvent(() => {
    if (!focused) return;
    const opening = openingHorizon(focused);
    onHorizons((current) => (current[scope] ? current : { ...current, [scope]: opening }));
  });
  useEffect(() => {
    keep();
  }, [scope]);
  return {
    horizon,
    choose: (value: Horizon) => onHorizons((current) => ({ ...current, [scope]: value })),
    release: (value: Horizon) => onHorizons((current) => (current[ordinary] === value ? current : { ...current, [ordinary]: value })),
  };
}

/** The horizon a review compares at, after its trading days or to date, and how each is measured. */
export function HorizonSwitch({ horizon, days, onChange }: { horizon: Horizon; days: number; onChange: (value: Horizon) => void }) {
  const t = useCopy();
  const { locale } = useLocale();
  const after = locale === "zh" ? `${days} 个交易日后` : `${days} trading days`;
  return (
    <span className="mx-horizon-switch inline-flex items-center gap-0.5">
      <Segments
        label={t("对照时点", "Compare at")}
        value={horizon}
        onChange={onChange}
        options={[
          { value: "horizon", label: after },
          { value: "date", label: t("至今", "To date") },
        ]}
      />
      <Help label={t("对照时点", "Compare at")}>
        <p>
          {t(
            "每笔买卖都和“不做这笔交易”比，看窗口内按英镑计、含分红的总回报：买入后总回报为正记为赚，为负记为亏；卖出后总回报为正记为少赚，为负记为少亏。",
            "Each buy or sell is compared with not making that trade, by its total return in GBP over the window, dividends included: after a buy, a positive return is a gain and a negative one a loss; after a sell, a positive return is a gain given up and a negative one a loss avoided.",
          )}
        </p>
        <p>
          {locale === "zh"
            ? `“${after}”从决定当天的收盘算到之后第 ${days} 个交易日的收盘，每笔决定的窗口一样长，可以直接相互比较；“至今”算到最近一个收盘。`
            : `“${after}” runs from the close on the day of the decision to the close ${days} trading days later, so every decision has the same window and they compare directly. “To date” runs to the latest close.`}
        </p>
        <p>
          {locale === "zh"
            ? `结果还不可得的决定不计入成绩，在时间轴上是零线上的空心点：还不满 ${days} 个交易日（“至今”则是之后还没有收盘），或还在等待价格、汇率或分红的最终值。“最近”里的金额不随切换变化，总是按至今计算。`
            : `A decision whose result is not available yet is not scored and sits as a hollow point on the timeline’s zero line: one younger than ${days} trading days (for “To date”, one with no close after it yet), or one still waiting for the final value of a price, exchange rate or dividend. Amounts under “Recently” do not follow the switch: they are always to date.`}
        </p>
      </Help>
    </span>
  );
}

/**
 * The valuation version saved by the end of a decision's day (the broker's UTC trade day), opened in
 * the research journal. With no version saved by then, nothing shows.
 */
export function ModelAtDecision({ row }: { row: Pick<TradeDecision, "ticker" | "date"> }) {
  const { locale, timeZone } = useLocale();
  const { data } = useQuery({
    queryKey: ["model-version-at", row.ticker, row.date],
    queryFn: ({ signal }) => api<ModelVersionAt>(
      `/research/${encodeURIComponent(row.ticker)}/models/as-of?day=${row.date}`, { signal }),
    staleTime: 60_000,
    retry: false,
  });
  const model = data?.model;
  if (!model) return null;
  const day = formatReadingTime(model.savedAt, locale, timeZone, "day");
  return (
    <Link className="mx-text-link mx-decision-model"
      href={`/research?ticker=${encodeURIComponent(row.ticker)}&view=ledger&notebook=models&model=${encodeURIComponent(model.id)}`}>
      {locale === "zh" ? `当时的估值模型 · ${day}保存` : `Valuation model at the time · saved ${day}`}
    </Link>
  );
}

/**
 * Every decision by date and outcome. A decision a link or a pick names leads the panel with its
 * context, and focus moves to it once each time one is named.
 */
export function DecisionTimelinePanel({
  action,
  rows,
  days,
  horizon,
  focus,
  onClear,
  onPick,
  accountOf,
  recordsAccountOf,
  decisionUrl,
  unpriced = [],
}: {
  rows: TradeDecision[];
  days: number;
  horizon: Horizon;
  focus?: TradeDecision;
  /** Lets go of the decision; the review stays as it is beneath it. */
  onClear?: () => void;
  onPick?: (row: TradeDecision) => void;
  decisionUrl?: (row: TradeDecision) => string;
  /** Across accounts, the account each reading names. */
  accountOf?: (row: TradeDecision) => string | undefined;
  recordsAccountOf?: (row: TradeDecision) => string | undefined;
  unpriced?: string[];
  action?: ReactNode;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const card = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const focusKey = focus ? horizonScope(undefined, focus) : "";
  const landed = useRef("");
  const land = useEffectEvent(() => {
    const link = card.current?.querySelector<HTMLElement>(".mx-row-link");
    if (!focusKey || landed.current === focusKey || !link) return;
    // Set before focusing: StrictMode runs this effect twice, and the second run must not move anything.
    landed.current = focusKey;
    link.focus({ preventScroll: true });
    card.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  });
  // A refetch that keeps the decision leaves focus where the reader put it.
  useEffect(() => {
    if (focusKey) land();
    else landed.current = "";
  }, [focusKey]);
  const title = horizon === "horizon"
    ? (locale === "zh" ? `每笔决定 ${days} 个交易日后的结果` : `Each decision after ${days} trading days`)
    : t("每笔决定至今的结果", "Each decision to date");
  return (
    <ChartRecords>
    <Panel
      className="mx-decision-review"
      action={<>{action}{rows.some((row) => row.side === "buy" || row.side === "sell") &&
        <ChartRecordsTrigger label={t("查看精确读数", "View exact values")} placement="heading" />}</>}
      title={title}
      helpLabel={t("买卖决定", "Buy and sell decisions")}
      help={<>
        <p>
          {t(
            "每个交易日的同一代码、同一方向算一次决定，用拆股调整后的收盘价（英镑）加上之后的分红计算。同一天又买又卖时，配对的股数算作日内往返，单独计算，只有多买或多卖的部分算作决定。",
            "One ticker, one side and one trading day make a decision, measured on split-adjusted closes in GBP plus the dividends that followed. When a day both buys and sells, the matched shares are a same-day round trip scored on their own, and only the shares beyond it count as a decision.",
          )}
        </p>
        <p>
          {t(
            "对照的是不做这笔交易：买入之后上涨或派息记为赚，下跌记为亏；卖出之后上涨或派息记为少赚，下跌记为少亏。",
            "Each decision is compared with not trading: a buy gains when the price then rises or pays out and loses when it falls; a sell gives up gains when it then rises or pays out and avoids losses when it falls.",
          )}
        </p>
      </>}
      helpBasis={t(
        "只用已收盘的价格和当日的最终汇率；数据源缺失的价格或汇率最多等待三个交易日，之后沿用此前的值。数据源日后补齐或更正历史时，效果会随之重算。",
        "Only completed closes and each day's final exchange rate are used; a missing price or rate waits up to three trading days for the data provider, then takes the last value before it. If the provider later fills in or corrects its history, effects are restated.",
      )}
    >
      {/* Letting go of a decision returns focus here, to the panel the decision led. */}
      <span ref={anchor} className="sr-only" tabIndex={-1}>{title}</span>
      {focus && (
        <div ref={card} className="mx-decision-focus">
          <DecisionRow row={focus} horizon={horizon} days={days} sided />
          {onClear && (
            <CloseButton
              className="mx-decision-unfocus"
              aria-label={t("取消选中这笔决定", "Deselect this decision")}
              onClick={() => {
                anchor.current?.focus({ preventScroll: true });
                onClear();
              }}
            />
          )}
          <ModelAtDecision row={focus} />
        </div>
      )}
      <DecisionTimeline rows={rows} horizon={horizon} days={days} focus={focus} onPick={onPick} accountOf={accountOf} recordsAccountOf={recordsAccountOf} decisionUrl={decisionUrl} />
      {unpriced.length > 0 && (
        <p className="mx-muted mx-decision-coverage">
          {locale === "zh"
            ? `${unpriced.length} 项持仓没有可核对的行情，未计入：${unpriced.join("、")}`
            : `${unpriced.length} ${unpriced.length === 1 ? "holding has" : "holdings have"} no reconcilable prices and ${unpriced.length === 1 ? "is" : "are"} excluded: ${unpriced.join(", ")}`}
        </p>
      )}
    </Panel>
    </ChartRecords>
  );
}
