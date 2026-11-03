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
                {formatCalendarDate(row.date, locale)} · {currency(row.amountGbp)} ·{" "}
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
              (row.side === "buy" ? t("买入 ", "Bought ") : t("卖出 ", "Sold ")) + currency(row.amountGbp),
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
          "每个交易日的同一证券、同一方向算一次决定，用拆股调整后的收盘价（英镑）计算：买入的结果是买入金额乘以之后的涨跌；卖出相反——之后上涨记为少赚，之后下跌记为避开的亏损。不含分红。",
          "One security, one side and one trading day make a decision, measured on split-adjusted closes in GBP: a buy earns its amount times the later change; a sell is the opposite — a later rise is gain given up, a later fall is a loss avoided. Dividends are excluded.",
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

