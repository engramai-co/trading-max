"use client";

import { ArrowUpRight } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { DashboardLens } from "@/lib/types";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { currency, percent, tone } from "@/workspace/data";
import { Plot } from "./charts";
import { EvidenceTable } from "./evidence-table";
import { Empty, Instrument, Metric, Panel, Segments, useCopy } from "./foundation";
import Link from "./link";
import { SecurityPeek } from "./security-peek";

export type AccountDecisions = NonNullable<DashboardLens["selectedAccountDecisions"]>;
export type TradeDecision = NonNullable<AccountDecisions["decisions"]>[number];
type ClosedTrade = NonNullable<AccountDecisions["closedTrades"]>[number];
type RoundTrip = NonNullable<AccountDecisions["roundTrips"]>[number];
export type Horizon = "horizon" | "date";

export function signedMoney(value: number | null | undefined, digits = 0) {
  if (value == null) return "—";
  const text = currency(value, "GBP", digits);
  return value > 0 && text !== currency(0, "GBP", digits) ? "+" + text : text;
}

export function decisionEffect(row: TradeDecision, horizon: Horizon) {
  return horizon === "horizon" ? row.effectHorizonGbp ?? null : row.effectToDateGbp ?? null;
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

function DecisionRows({ rows, horizon, empty }: { rows: TradeDecision[]; horizon: Horizon; empty: string }) {
  const t = useCopy();
  const { locale } = useLocale();
  if (!rows.length) return <p className="mx-muted">{empty}</p>;
  return (
    <>
      {rows.map((row) => {
        const effect = decisionEffect(row, horizon);
        const change = horizon === "horizon" ? row.returnHorizon : row.returnToDate;
        return (
          <Link
            key={row.date + row.ticker + row.side}
            className="mx-row-link"
            href={"/research?ticker=" + encodeURIComponent(row.ticker) + "&view=technical"}
          >
            <SecurityPeek ticker={row.ticker}>
              <Instrument ticker={row.ticker} name={row.name} small />
            </SecurityPeek>
            <span className={"mx-row-value mx-" + tone(effect)}>
              {signedMoney(effect)}
              <small>
                {formatCalendarDate(row.date, locale)} · {row.kind === "T" ? t("T 净额 ", "T net ") : ""}
                {currency(row.amountGbp)} ·{" "}
                {t("之后 ", "then ")}
                {percent(change, true, 1)}
              </small>
            </span>
            <ArrowUpRight size={15} />
          </Link>
        );
      })}
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
              effect == null
                ? t("尚未满 20 个交易日", "Twenty trading days have not passed")
                : t("之后 ", "Then ") + percent(change, true, 1) + " · " + signedMoney(effect),
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
          // Points carry their own outcome colour; the legend shows only the shape.
          itemStyle: { color: colours.axis },
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
  return (
    <Panel
      title={t("日内做 T", "Same-day round trips")}
      help={t(
        "同一天买入又卖出同一证券时，配对的股数算一次往返：结果是（卖出均价 − 买入均价）× 股数，已扣除费用。当日价差上限是同样股数在当天最高价与最低价之间能赚到的最多金额，用来对照，不是事先可以做到的策略。多买或多卖的部分仍作为买卖决定计算。",
        "When one security is bought and sold on the same day, the matched shares are a round trip: (average sell − average buy) × shares, after costs. The day's range is the most the same shares could have taken between that day's high and low; it is a yardstick, not a strategy available in advance. Shares bought or sold beyond the round trip still count as buy or sell decisions.",
      )}
    >
      <div className="mx-metric-grid mx-metric-grid-three">
        <Metric
          label={t("往返结果", "Round-trip result")}
          value={signedMoney(verdict.result)}
          tone={verdict.result < 0 ? "down" : verdict.result > 0 ? "up" : undefined}
          note={locale === "zh" ? `${verdict.favourable} / ${verdict.count} 次盈利` : `${verdict.favourable} of ${verdict.count} gained`}
        />
        <Metric label={t("当日价差上限", "Day's range on those shares")} value={verdict.range == null ? "—" : currency(verdict.range)} />
        <Metric label={t("抓住的价差", "Share of the range taken")} value={verdict.captured == null ? "—" : percent(verdict.captured, false, 0)} />
      </div>
      <EvidenceTable
        label={t("日内做 T 记录", "Same-day round trips")}
        rows={rows}
        pageSize={10}
        columns={[
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
        ]}
      />
    </Panel>
  );
}

export function DecisionReview({ data }: { data: AccountDecisions | null | undefined }) {
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
  const horizonLabel = horizon === "horizon"
    ? (locale === "zh" ? `${days} 个交易日后` : `After ${days} trading days`)
    : t("至今", "To date");
  const sells = sideVerdict(rows, "sell", horizon);
  const buys = sideVerdict(rows, "buy", horizon);
  const sold = notableDecisions(rows, "sell", horizon);
  const bought = notableDecisions(rows, "buy", horizon);
  const closed = (data.closedTrades ?? []).filter((row) => (row.givenBackGbp ?? 0) > 0);
  const givenBack = closed.reduce((total, row) => total + (row.givenBackGbp ?? 0), 0);
  const unpriced = data.coverage?.unpricedTickers ?? [];
  return (
    <>
      <Panel
        title={t("买卖决定", "Buy and sell decisions")}
        help={t(
          "每个交易日的同一证券、同一方向算一次决定，用拆股调整后的收盘价（英镑）加上之后的分红计算：买入的结果是买入金额乘以之后的涨跌；卖出相反——之后上涨或派息记为少赚，之后下跌记为避开的亏损。同一天又买又卖时，配对的股数算作日内做 T，单独计算，只有多买或多卖的部分算作决定。",
          "One security, one side and one trading day make a decision, measured on split-adjusted closes in GBP plus the dividends that followed: a buy earns its amount times the later change; a sell is the opposite — a later rise or dividend is gain given up, a later fall is a loss avoided. When a day both buys and sells, the matched shares are a same-day round trip scored on their own, and only the shares beyond it count as a decision.",
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
          <Metric
            label={t("卖出后 · ", "Sells · ") + horizonLabel}
            value={signedMoney(sells.effect)}
            tone={sells.evaluated ? (sells.effect < 0 ? "down" : "up") : undefined}
            note={locale === "zh"
              ? `${sells.favourable} / ${sells.evaluated} 次之后下跌`
              : `${sells.favourable} of ${sells.evaluated} fell afterwards`}
          />
          <Metric
            label={t("买入后 · ", "Buys · ") + horizonLabel}
            value={signedMoney(buys.effect)}
            tone={buys.evaluated ? (buys.effect < 0 ? "down" : "up") : undefined}
            note={locale === "zh"
              ? `${buys.favourable} / ${buys.evaluated} 次之后上涨`
              : `${buys.favourable} of ${buys.evaluated} rose afterwards`}
          />
          <Metric
            label={t("比持有期最高收盘少赚", "Below the best close while held")}
            value={currency(givenBack)}
            note={locale === "zh" ? `${closed.length} 笔已结束交易` : `${closed.length} closed trades`}
          />
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
      <RoundTrips data={data} />
      {closed.length > 0 && (
        <Panel
          title={t("持有期间的最佳卖点", "The best close while held")}
          help={t(
            "按建仓日收盘价估算：若在持有期内最高或最低收盘价全部卖出，结果会是多少。用于看清每笔交易错过了多少，而不是可以事先做到的策略。",
            "Estimated from the close on the opening day: the result of selling everything at the highest or lowest close while held. It shows what each trade left behind, not a strategy available in advance.",
          )}
        >
          <EvidenceTable
            label={t("已结束交易与持有期最佳卖点", "Closed trades against their best close")}
            rows={closed.slice(0, 20)}
            pageSize={10}
            columns={[
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
            ]}
          />
        </Panel>
      )}
    </>
  );
}

