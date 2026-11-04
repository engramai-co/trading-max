"use client";

import { CloseButton, Popover } from "@mantine/core";
import { ArrowUpRight } from "@phosphor-icons/react";
import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { AccountCode, DashboardLens } from "@/lib/types";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { currency, percent, tone } from "@/workspace/data";
import { Plot } from "./charts";
import { EvidenceTable } from "./evidence-table";
import { Empty, Instrument, Metric, Panel, Segments, useCopy } from "./foundation";
import Link from "./link";
import { filingLabel, ratingLabel } from "./market-terms";
import { DecisionNarrative } from "./review-narrative";
import { SecurityPeek } from "./security-peek";

export type AccountDecisions = NonNullable<DashboardLens["selectedAccountDecisions"]>;
export type TradeDecision = NonNullable<AccountDecisions["decisions"]>[number];
type ClosedTrade = NonNullable<AccountDecisions["closedTrades"]>[number];
type RoundTrip = NonNullable<AccountDecisions["roundTrips"]>[number];
type DecisionEvent = NonNullable<TradeDecision["events"]>[number];
export type Horizon = "horizon" | "date";
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
 * The review index's decisions across both investing accounts: how many still wait
 * for a close, counted by the lens before it keeps the latest few, the securities
 * of those it kept, and the latest decisions with an outcome.
 */
export function latestDecisions(reviews: DashboardLens["decisionReviews"], limit = 8) {
  const accounts = (["A", "B"] as const).map((code) => [code, reviews?.[code]] as const);
  const rows = accounts
    .flatMap(([code, review]) => (review?.decisions ?? []).map((row) => ({ ...row, account: code })))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amountGbp - a.amountGbp);
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
  const title = event.title ?? "";
  return title.length > 60 ? title.slice(0, 59) + "…" : title;
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

type Placement = { shown: number; left?: number; top?: number; room?: number };

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
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const heading = useId();
  const [place, setPlace] = useState<Placement>({ shown: context.length });
  const [opened, setOpened] = useState(false);
  useLayoutEffect(() => {
    const row = entry.current;
    const element = line.current;
    const more = button.current;
    if (!row || !element || !more) return;
    // Measured once while every item is laid out; later fits reuse the widths. The first
    // item may already be shrunk with an ellipsis, so then its full width is its scroll width.
    const widths = Array.from(element.querySelectorAll<HTMLElement>("[data-item]"), (item) => {
      const width = item.getBoundingClientRect().width;
      return item.scrollWidth > item.clientWidth ? Math.max(width, item.scrollWidth) : width;
    });
    // The button's padding reaches into its margins, so its room on the line is its width less them.
    const margins = getComputedStyle(more);
    const width = more.getBoundingClientRect().width + parseFloat(margins.marginLeft) + parseFloat(margins.marginRight);
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    const fit = () => {
      const { shown, at } = contextFit(widths, element.clientWidth, gap, width);
      const origin = row.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const left = box.left - origin.left + at;
      const top = box.top - origin.top;
      setPlace((current) =>
        current.shown === shown && current.left === left && current.top === top
          ? current
          : { shown, left, top, room: gap + width },
      );
      if (shown < widths.length) return;
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
  }, []);
  const hidden = context.length - place.shown;
  return (
    <div ref={entry} className="mx-decision-entry">
      <Link ref={link} className="mx-row-link mx-decision-row" href={href}>
        {children}
        {context.length > 0 && (
          <span ref={line} className="mx-decision-context" style={hidden ? { paddingInlineEnd: place.room } : undefined}>
            {context.map((item, index) => (
              <span key={index} data-item="" hidden={index >= place.shown}>
                {item}
              </span>
            ))}
          </span>
        )}
      </Link>
      {context.length > 0 && (
        <Popover
          opened={opened}
          onChange={setOpened}
          position="bottom-end"
          width={320}
          offset={8}
          middlewares={{ flip: true, shift: { padding: 16 } }}
          trapFocus
          returnFocus
          transitionProps={{ duration: 0 }}
          // Mantine hides a dropdown while its first position checks for a detached target,
          // the moment its focus trap moves focus in; shown from the start, focus lands inside.
          hideDetached={false}
          shadow="md"
        >
          <Popover.Target>
            <button
              ref={button}
              type="button"
              className="mx-decision-more"
              data-idle={hidden ? undefined : ""}
              style={{ left: place.left, top: place.top }}
              onClick={() => setOpened((value) => !value)}
              onKeyDown={(event) => {
                // Escape closes it from the button too, not only from inside the list.
                if (event.key === "Escape" && opened) setOpened(false);
              }}
            >
              +{hidden || context.length}
              <span className="sr-only">{t(" 项", " more")}</span>
            </button>
          </Popover.Target>
          <Popover.Dropdown ref={list} className="mx-help-popover" aria-labelledby={heading}>
            <div className="mx-help-heading">
              <strong id={heading}>{label}</strong>
              <CloseButton data-autofocus size="sm" aria-label={t("关闭", "Close")} onClick={() => setOpened(false)} />
            </div>
            <ul className="mx-help-body mx-decision-more-list">
              {context.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </Popover.Dropdown>
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

/** One decision: the security, its effect over "date · amount · then", and the arrow to its research. */
function DecisionRow({ row, horizon }: { row: TradeDecision; horizon: Horizon }) {
  const t = useCopy();
  const { locale } = useLocale();
  const effect = decisionEffect(row, horizon);
  const change = horizon === "horizon" ? row.returnHorizon : row.returnToDate;
  const context = decisionContext(row, horizon, t, locale);
  return (
    <DecisionEntry
      key={context.join("\u0000")}
      href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}
      context={context}
      label={row.ticker + " · " + formatCalendarDate(row.date, locale)}
    >
      <SecurityPeek ticker={row.ticker}>
        <Instrument ticker={row.ticker} name={row.name} small />
      </SecurityPeek>
      <span className={"mx-row-value mx-" + effectTone(effect)}>
        <span>{signedMoney(effect)}</span>
        <small>
          {formatCalendarDate(row.date, locale)} · {row.kind === "T" ? t("T 净额 ", "T net ") : ""}
          {currency(row.amountGbp)} ·{" "}
          {t("之后 ", "then ")}
          {percent(change, true, 1)}
        </small>
      </span>
      <ArrowUpRight size={15} aria-hidden="true" />
    </DecisionEntry>
  );
}

function DecisionRows({ rows, horizon, empty }: { rows: TradeDecision[]; horizon: Horizon; empty: string }) {
  if (!rows.length) return <p className="mx-muted">{empty}</p>;
  return (
    <>
      {rows.map((row) => (
        <DecisionRow key={row.date + row.ticker + row.side} row={row} horizon={horizon} />
      ))}
    </>
  );
}

function DecisionTimeline({ rows, horizon }: { rows: TradeDecision[]; horizon: Horizon }) {
  const t = useCopy();
  const { locale } = useLocale();
  const largest = Math.max(1, ...rows.map((row) => row.amountGbp));
  const option = useMemo(
    () => (colours: Record<string, string>) => {
      const point = (row: TradeDecision) => {
        const effect = decisionEffect(row, horizon);
        const colour = effect == null ? colours.axis : effect >= 0 ? colours.positive : colours.negative;
        return {
          value: [Date.parse(row.date), effect ?? 0],
          symbolSize: 6 + 16 * Math.sqrt(row.amountGbp / largest),
          itemStyle: effect == null
            ? { color: "transparent", borderColor: colour, borderWidth: 1.5 }
            : { color: colour, opacity: 0.85 },
          row,
        };
      };
      // The legend names the shape; its upper half is the gain colour and its
      // lower half the loss colour, as points sit above or below £0.
      const split = {
        type: "linear" as const,
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: colours.positive },
          { offset: 0.5, color: colours.positive },
          { offset: 0.5, color: colours.negative },
          { offset: 1, color: colours.negative },
        ],
      };
      return {
        grid: { top: 40, right: 18, bottom: 30, left: 64 },
        tooltip: {
          trigger: "item" as const,
          formatter: (input: unknown) => {
            const row = (input as { data: { row: TradeDecision } }).data.row;
            const effect = decisionEffect(row, horizon);
            const change = horizon === "horizon" ? row.returnHorizon : row.returnToDate;
            return [
              formatCalendarDate(row.date, locale) + " · " + row.ticker,
              (row.kind === "T"
                ? row.side === "buy" ? t("做 T 后净买入 ", "Net bought after a T ") : t("做 T 后净卖出 ", "Net sold after a T ")
                : row.side === "buy" ? t("买入 ", "Bought ") : t("卖出 ", "Sold ")) + currency(row.amountGbp),
              effect != null
                ? t("之后 ", "Then ") + percent(change, true, 1) + " · " + signedMoney(effect)
                : horizon === "horizon"
                  ? t("尚未满 20 个交易日", "Twenty trading days have not passed")
                  : t("观察中，还没有之后的收盘价", "Observing: no later close yet"),
              ...(row.events ?? []).map((event) => formatCalendarDate(event.date, locale) + " " + eventLabel(event, t)),
            ].join("\n");
          },
        },
        xAxis: { type: "time" as const, axisLabel: { formatter: (value: number) => formatCalendarDate(new Date(value).toISOString().slice(0, 10), locale) } },
        yAxis: {
          type: "value" as const,
          axisLabel: { formatter: (value: number) => signedMoney(value) },
          splitLine: { lineStyle: { color: colours.grid, type: "dashed" as const } },
        },
        series: (["buy", "sell"] as const).map((side) => ({
          type: "scatter" as const,
          name: side === "buy" ? t("买入", "Buys") : t("卖出", "Sells"),
          symbol: side === "buy" ? "circle" : "diamond",
          // Points carry their own outcome colour; this colour reaches only the legend.
          itemStyle: { color: split },
          data: rows.filter((row) => row.side === side).map(point),
          markLine: side === "buy"
            ? { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: colours.axis, type: "solid" as const, width: 1 }, label: { show: false } }
            : undefined,
        })),
        legend: { top: 0, right: 0, data: [t("买入", "Buys"), t("卖出", "Sells")] },
      };
    },
    [rows, horizon, largest, locale, t],
  );
  return <Plot research label={t("买卖决定的时间线", "Timeline of buy and sell decisions")} height={340} option={option as never} />;
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

function RoundTrips({ data }: { data: AccountDecisions }) {
  const t = useCopy();
  const { locale } = useLocale();
  const verdict = roundTripVerdict(data.roundTripSummary);
  if (!verdict.count) return null;
  const rows = [...(data.roundTrips ?? [])].reverse();
  const largest = [...rows].sort((a, b) => Math.abs(b.resultGbp) - Math.abs(a.resultGbp)).slice(0, 5);
  const columns = [
    { label: t("日期", "Date"), value: (row: RoundTrip) => formatCalendarDate(row.date, locale) },
    {
      label: t("证券", "Security"),
      value: (row: RoundTrip) => (
        <Link href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}>{row.ticker}</Link>
      ),
    },
    { label: t("股数", "Shares"), value: (row: RoundTrip) => row.matchedQuantity.toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", { maximumFractionDigits: 4 }), numeric: true },
    { label: t("买入均价", "Average buy"), value: (row: RoundTrip) => currency(row.buyAverageGbp, "GBP", 2), numeric: true },
    { label: t("卖出均价", "Average sell"), value: (row: RoundTrip) => currency(row.sellAverageGbp, "GBP", 2), numeric: true },
    { label: t("结果", "Result"), value: (row: RoundTrip) => <span className={"mx-" + tone(row.resultGbp)}>{signedMoney(row.resultGbp, 2)}</span>, numeric: true },
    { label: t("当日价差上限", "Day's range"), value: (row: RoundTrip) => (row.rangeGbp == null ? "—" : currency(row.rangeGbp, "GBP", 2)), numeric: true },
  ];
  return (
    <Panel
      className="mx-decision-table"
      title={t("日内做 T", "Same-day round trips")}
      help={t(
        "同一天买入又卖出同一证券时，配对的股数算一次往返：结果是（卖出均价 − 买入均价）× 股数，已扣除费用。当日价差上限是同样股数在当天最高价与最低价之间能赚到的最多金额，用来对照，不是事先可以做到的策略。多买或多卖的部分仍作为买卖决定计算。",
        "When one security is bought and sold on the same day, the matched shares are a round trip: (average sell − average buy) × shares, after costs. The day's range is the most the same shares could have taken between that day's high and low; it is a yardstick, not a strategy available in advance. Shares bought or sold beyond the round trip still count as buy or sell decisions.",
      )}
    >
      <div className="mx-metric-grid mx-metric-grid-three">
        <Metric label={t("当日价差上限", "Day's range on those shares")} value={verdict.range == null ? "—" : currency(verdict.range)} />
        <Metric label={t("抓住的价差", "Share of the range taken")} value={verdict.captured == null ? "—" : percent(verdict.captured, false, 0)} />
      </div>
      <EvidenceTable label={t("结果最大的日内做 T", "Largest round trips")} rows={largest} columns={columns} />
      {rows.length > largest.length && (
        <details className="mx-chart-data">
          <summary>{locale === "zh" ? `全部 ${rows.length} 次` : `All ${rows.length} round trips`}</summary>
          <EvidenceTable label={t("日内做 T 记录", "Same-day round trips")} rows={rows} pageSize={20} showCount={false} columns={columns} />
        </details>
      )}
    </Panel>
  );
}

/** The closed trades that left the most behind against their best close while held. */
function BestCloses({ rows }: { rows: ClosedTrade[] }) {
  const t = useCopy();
  const { locale } = useLocale();
  if (!rows.length) return null;
  const givenBack = rows.reduce((total, row) => total + (row.givenBackGbp ?? 0), 0);
  const largest = rows.slice(0, 5);
  const columns = [
    {
      label: t("证券", "Security"),
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
      title={t("持有期间的最佳卖点", "The best close while held")}
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
          <EvidenceTable label={t("已结束交易与持有期最佳卖点", "Closed trades against their best close")} rows={rows} pageSize={20} showCount={false} columns={columns} />
        </details>
      )}
    </Panel>
  );
}

export function DecisionReview({
  data,
  account,
  dataAsOf,
}: {
  data: AccountDecisions | null | undefined;
  account?: AccountCode;
  /** When the reviewed figures were built; an older AI review says when it was written. */
  dataAsOf?: string | null;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const [horizon, setHorizon] = useState<Horizon>("horizon");
  if (!data || data.status !== "available")
    return (
      <Panel>
        <Empty
          title={t("还没有买卖决定的复盘", "No decision review yet")}
          description={t(
            "完成一次完整更新后，这里会逐笔对照每次买入和卖出之后的价格。",
            "After a full update, each buy and sell is compared with the price that followed.",
          )}
        />
      </Panel>
    );
  const rows = data.decisions ?? [];
  const days = data.horizonDays ?? 20;
  const window = horizon === "horizon"
    ? (locale === "zh" ? ` ${days} 个交易日` : ` after ${days} trading days`)
    : t("至今", " to date");
  const sells = sideVerdict(rows, "sell", horizon);
  const buys = sideVerdict(rows, "buy", horizon);
  const trips = roundTripVerdict(data.roundTripSummary);
  const sold = notableDecisions(rows, "sell", horizon);
  const bought = notableDecisions(rows, "buy", horizon);
  const closed = (data.closedTrades ?? []).filter((row) => (row.givenBackGbp ?? 0) > 0);
  const unpriced = data.coverage?.unpricedTickers ?? [];
  const verdict = (side: "buy" | "sell", summary: ReturnType<typeof sideVerdict>) => {
    const word = summary.evaluated ? verdictWord(side, summary.effect, t) : "";
    const { favourable, evaluated } = summary;
    const count = side === "sell"
      ? (locale === "zh" ? `${favourable} / ${evaluated} 次卖对了` : `${favourable} of ${evaluated} sells helped`)
      : (locale === "zh" ? `${favourable} / ${evaluated} 次买对了` : `${favourable} of ${evaluated} buys helped`);
    return (
      <Metric
        label={(side === "sell" ? t("卖出后", "Sells") : t("买入后", "Buys")) + window + (word ? " · " + word : "")}
        value={summary.evaluated ? currency(Math.abs(summary.effect)) : "—"}
        tone={word ? (summary.effect < 0 ? "down" : "up") : undefined}
        note={summary.evaluated ? count : undefined}
      />
    );
  };
  return (
    <>
      <Panel
        title={t("买卖决定", "Buy and sell decisions")}
        help={t(
          "每个交易日的同一证券、同一方向算一次决定，用拆股调整后的收盘价（英镑）加上之后的分红计算，对照的是不做这笔交易：买入之后上涨或派息记为赚，下跌记为亏；卖出之后上涨或派息记为少赚，下跌记为少亏。同一天又买又卖时，配对的股数算作日内做 T，单独计算，只有多买或多卖的部分算作决定。只用已收盘的价格和当日的最终汇率；数据源缺失的价格或汇率最多等待三个交易日，之后沿用此前的值。数据源日后补齐或更正历史时，效果会随之重算。",
          "One security, one side and one trading day make a decision, measured on split-adjusted closes in GBP plus the dividends that followed, against not trading: a buy gains when the security then rises or pays out and loses when it falls; a sell gives up gains when it then rises or pays out and avoids losses when it falls. When a day both buys and sells, the matched shares are a same-day round trip scored on their own, and only the shares beyond it count as a decision. Only completed closes and each day's final exchange rate are used; a missing price or rate waits up to three trading days for the data provider, then takes the last value before it. If the provider later fills in or corrects its history, effects are restated.",
        )}
        action={
          <Segments
            label={t("对照时点", "Compare at")}
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: "horizon", label: locale === "zh" ? `${days} 个交易日后` : `${days} trading days` },
              { value: "date", label: t("至今", "To date") },
            ]}
          />
        }
      >
        <div className="mx-metric-grid mx-metric-grid-three">
          {verdict("sell", sells)}
          {verdict("buy", buys)}
          {trips.count > 0 && (
            <Metric
              label={t("日内做 T", "Round trips") + (Math.round(trips.result) ? " · " + (trips.result > 0 ? t("赚", "gained") : t("亏", "lost")) : "")}
              value={currency(Math.abs(trips.result))}
              tone={Math.round(trips.result) ? (trips.result < 0 ? "down" : "up") : undefined}
              note={locale === "zh" ? `${trips.favourable} / ${trips.count} 次盈利` : `${trips.favourable} of ${trips.count} gained`}
            />
          )}
        </div>
        <DecisionTimeline rows={rows} horizon={horizon} />
        {unpriced.length > 0 && (
          <p className="mx-muted mx-decision-coverage">
            {locale === "zh"
              ? `${unpriced.length} 只证券没有可核对的行情，未计入：${unpriced.join("、")}`
              : `${unpriced.length} securities have no reconcilable prices and are excluded: ${unpriced.join(", ")}`}
          </p>
        )}
      </Panel>
      {account && <DecisionNarrative account={account} dataAsOf={dataAsOf ?? data.asOf} />}
      <div className="mx-grid">
        <Panel title={t("卖出后上涨最多", "Sold before the biggest rises")}>
          <DecisionRows rows={sold.worst} horizon={horizon} empty={t("没有卖出后上涨的记录", "No sale was followed by a rise")} />
        </Panel>
        <Panel title={t("卖出后下跌最多", "Sold before the biggest falls")}>
          <DecisionRows rows={sold.best} horizon={horizon} empty={t("没有卖出后下跌的记录", "No sale was followed by a fall")} />
        </Panel>
        <Panel title={t("买入后下跌最多", "Bought before the biggest falls")}>
          <DecisionRows rows={bought.worst} horizon={horizon} empty={t("没有买入后下跌的记录", "No purchase was followed by a fall")} />
        </Panel>
        <Panel title={t("买入后上涨最多", "Bought before the biggest rises")}>
          <DecisionRows rows={bought.best} horizon={horizon} empty={t("没有买入后上涨的记录", "No purchase was followed by a rise")} />
        </Panel>
      </div>
      <BestCloses rows={closed} />
      <RoundTrips data={data} />
    </>
  );
}
