"use client";

import { ArrowUpRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { numeric } from "@/lib/numeric";
import type { DashboardLens } from "@/lib/types";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { currency, number, object, objects, percent, str, tone, type Json } from "@/workspace/data";
import { Bars } from "./charts";
import { EvidenceTable } from "./evidence-table";
import { Empty, Facts, Instrument, Metric, Notice, Panel, StatusMessage, Tag, TextLink, useCopy } from "./foundation";
import Link from "./link";
import { reviewLabel } from "./review-copy";
import { Availability, DetailFacts, EndingEvidence, field } from "./review-evidence";
import { SecurityPeek } from "./security-peek";
import { SelectPicker } from "./picker";
import { ReviewDisclosure } from "./review-board";

export function Coverage({ data }: { data: Json }) {
  const t = useCopy();
  const { locale } = useLocale();
  return (
    <Facts
      rows={[
        [
          t("记录区间", "Records"),
          formatDateSpan(
            str(data.start_date ?? data.startDate),
            str(data.end_date ?? data.endDate),
            locale,
          ),
        ],
        [
          t("资金观测点", "Value observations"),
          number(data.nav_observation_count ?? data.navObservationCount, 0),
        ],
        [
          t("交易记录", "Transactions"),
          number(data.transaction_count ?? data.transactionCount, 0),
        ],
        [
          t("已结束交易过程", "Closed trade campaigns"),
          number(data.closed_campaign_count ?? data.closedCampaignCount, 0),
        ],
      ]}
    />
  );
}
export function Attribution({ data, cfd, count }: { data: Json; cfd: boolean; count?: number | null }) {
  const t = useCopy();
  const [dimension, setDimension] = useState("instrument");
  const keys: Record<string, string> = cfd
    ? {
        instrument: "byInstrument",
        direction: "byDirection",
        duration: "byDuration",
        weekday: "byWeekday",
        date: "byDate",
      }
    : {
        instrument: "by_instrument",
        country: "by_country",
        industry: "by_industry",
        direction: "by_direction",
        duration: "by_holding_bucket",
        year: "by_calendar",
        month: "by_calendar",
        weekday: "by_calendar",
        components: "components",
      };
  const raw = data[keys[dimension]];
  const rows = objects(
    cfd
      ? raw
      : ["year", "month", "weekday"].includes(dimension)
        ? object(raw)[dimension]
        : object(raw).buckets,
  );
  const components: Record<string, string> = {
    gross_trade_result: t("换汇费前交易收益", "Trading result before FX fees"),
    transaction_fees: t("换汇费用", "FX fees"),
    net_realised_result: t("净盈亏", "Net P&L"),
  };
  const label = (r: Json) => components[str(r.label)] ?? reviewLabel(str(r.label ?? r.key), t);
  const value = (r: Json) =>
    numeric(r.netResultGbp ?? r.netRealisedPnl ?? field(r, "contribution_gbp"));
  const labels: Record<string, string> = {
    instrument: t("代码", "Ticker"),
    country: t("国家/地区", "Country"),
    industry: t("行业", "Industry"),
    direction: t("方向", "Direction"),
    duration: t("持有周期", "Holding period"),
    weekday: t("星期", "Weekday"),
    date: t("日期", "Date"),
    year: t("年度", "Year"),
    month: t("月份", "Month"),
    components: t("费用组成", "P&L components"),
  };
  const title = t("已实现盈亏归因 · GBP", "Realised P&L attribution · GBP");
  if (data.status === "unavailable") return (
    <Panel title={title}><UnavailableTrades data={data} count={count} /></Panel>
  );
  const evidence = cfd ? data : object(raw);
  return (
    <Panel
      title={title}
      action={
        <SelectPicker
          aria-label={t("归因维度", "Attribution dimension")}
          value={dimension}
          onChange={(v) => setDimension(v ?? "instrument")}
          options={Object.keys(keys).map((k) => ({ value: k, label: labels[k] }))}
          style={{ width: 140 }}
        />
      }
    >
      {rows.length > 0 && <Bars
        label={t("已实现盈亏贡献", "Realised P&L contribution")}
        labels={rows.slice(0, 14).map(label)}
        values={rows.slice(0, 14).map(value)}
      />}
      <Availability data={evidence} />
      {(rows.length > 0 || !explainsCoverage(evidence)) && <EvidenceTable
        key={dimension}
        rows={rows}
        label={t("归因明细", "Attribution detail")}
        columns={[
          { label: labels[dimension], value: label },
          {
            label: t("交易数", "Trades"),
            value: (r) => number(r.tradeCount, 0),
            numeric: true,
          },
          ...(!cfd && dimension !== "components"
            ? [
                {
                  label: t("盈利合计", "Winning results"),
                  value: (r: Json) => currency(r.grossWinsGbp ?? 0, "GBP", 2),
                  numeric: true,
                },
                {
                  label: t("亏损合计", "Losing results"),
                  value: (r: Json) => currency(r.grossLossesGbp ?? 0, "GBP", 2),
                  numeric: true,
                },
                {
                  label: t("换汇费用", "FX fees"),
                  value: (r: Json) => currency(r.feesGbp, "GBP", 2),
                  numeric: true,
                },
                {
                  label: t("盈亏贡献占比", "Signed contribution share"),
                  value: (r: Json) => percent(r.shareOfAbsoluteResult),
                  numeric: true,
                },
              ]
            : []),
          {
            label: t("净盈亏", "Net P&L"),
            value: (r) => currency(value(r), "GBP", 2),
            numeric: true,
          },
        ]}
      />}
    </Panel>
  );
}
function explainsCoverage(data: Json) {
  const reasons = field(data, "partial_reasons");
  return Boolean(field(data, "unavailable_reason")) ||
    (Array.isArray(reasons) && reasons.some(Boolean)) ||
    data.status === "partial" || data.partial === true;
}

function holdingDuration(value: unknown, cfd: boolean, t: ReturnType<typeof useCopy>) {
  const displayed = number(value, cfd ? 1 : 0);
  if (displayed === "—") return displayed;
  const singular = displayed === "1";
  const unit = cfd
    ? (singular ? t(" 小时", " hour") : t(" 小时", " hours"))
    : (singular ? t(" 天", " day") : t(" 天", " days"));
  return displayed + unit;
}

function UnavailableTrades({ data, count, cfdDurations = false }: { data: Json; count: unknown; cfdDurations?: boolean }) {
  const t = useCopy();
  const sameDay = cfdDurations ? numeric(field(data, "same_day_count")) : null;
  const underHour = cfdDurations ? numeric(field(data, "under_one_hour_count")) : null;
  const median = cfdDurations ? numeric(field(data, "median_duration_hours")) : null;
  const average = cfdDurations ? numeric(field(data, "average_duration_hours")) : null;
  const rows: Array<[string, string]> = [];
  if (numeric(count) != null) rows.push([t("已结束交易", "Closed trades"), number(count, 0)]);
  if (sameDay !== null) rows.push([t("同日完成", "Closed on the same day"), number(sameDay, 0)]);
  if (underHour !== null) rows.push([t("一小时内结束", "Closed within one hour"), number(underHour, 0)]);
  if (median !== null) rows.push([t("中位持有周期", "Median holding duration"), holdingDuration(median, true, t)]);
  if (average !== null) rows.push([t("平均持有小时", "Average holding hours"), number(average, 1)]);
  return <>
    {!!rows.length && <Facts rows={rows} />}
    <Availability data={data} />
    {!explainsCoverage(data) && <Empty title={t("暂无记录", "No records")} />}
  </>;
}
export function TradeQuality({
  data,
  legacy,
  cfd,
}: {
  data: Json;
  legacy: Json;
  cfd: boolean;
}) {
  const t = useCopy();
  const fallback = data.status === "unavailable" ? {} : legacy;
  const wins = data.win_count ?? data.wins,
    losses = data.loss_count ?? data.losses;
  const count = data.trade_count ?? data.tradeCount ?? fallback.trades;
  const medianLabel = holdingDuration(data.median_holding_days ?? data.medianDurationHours, cfd, t);
  const title = t("过程是否可持续", "Understand the trading process");
  const help = t(
    "观察已结束交易的分布与质量，不从记录推断投资动机。",
    "Examine closed-trade distributions without inferring investment motives.",
  );
  const best = objects(data.best_trades).filter(
      (trade) => (numeric(trade.netResultGbp) ?? 0) > 0,
    ),
    worst = objects(data.worst_trades).filter(
      (trade) => (numeric(trade.netResultGbp) ?? 0) < 0,
    );
  if (data.status === "unavailable") return (
    <Panel title={title} help={help}><UnavailableTrades data={data} count={count} cfdDurations={cfd} /></Panel>
  );
  return (
    <div className="flex flex-col gap-mx-lg">
      <Panel
        title={title}
        help={help}
      >
        <Availability data={data} />
        <div className="mx-metric-grid">
          <Metric
            label={t("已结束交易", "Closed trades")}
            value={number(count, 0)}
          />
          <Metric
            label={t("胜率", "Win rate")}
            value={percent(data.win_rate ?? data.winRate ?? fallback.win_rate)}
          />
          <Metric
            label={t("盈亏因子", "Profit factor")}
            value={number(
              data.profit_factor ?? data.profitFactor ?? fallback.profit_factor,
            )}
          />
          <Metric
            label={t("每笔期望盈亏", "Expectancy per trade")}
            value={currency(
              data.expectancy_gbp ?? data.expectancy ?? fallback.expectancy,
              "GBP",
              2,
            )}
          />
        </div>
      </Panel>
      <div className="mx-grid">
        <Panel title={t("盈利与亏损", "Winners and losers")}>
          <Bars
            label={t("交易数量分布", "Distribution of closed trades")}
            labels={[
              t("盈利交易", "Winning trades"),
              t("亏损交易", "Losing trades"),
            ]}
            values={[numeric(wins), numeric(losses)]}
            height={170}
          />
          <Facts
            rows={[
              [
                t("平均盈利", "Average win"),
                currency(
                  data.average_win_gbp ?? data.averageWin ?? fallback.avg_win,
                  "GBP",
                  2,
                ),
              ],
              [
                t("平均亏损", "Average loss"),
                currency(
                  data.average_loss_gbp ?? data.averageLoss ?? fallback.avg_loss,
                  "GBP",
                  2,
                ),
              ],
              [
                t("盈亏比", "Payoff ratio"),
                number(data.payoff_ratio ?? data.payoffRatio ?? fallback.payoff),
              ],
            ]}
          />
        </Panel>
        <Panel title={t("持有与连续性", "Duration and consistency")}>
          <Facts
            rows={[
              [
                cfd
                  ? t("平均持有小时", "Average holding hours")
                  : t("平均持有天数", "Average holding days"),
                number(data.average_holding_days ?? data.averageDurationHours, cfd ? 1 : 0),
              ],
              [
                t("最长连胜", "Longest winning streak"),
                number(data.longest_winning_streak ?? data.longestWinStreak, 0),
              ],
              [
                t("最长连亏", "Longest losing streak"),
                number(data.longest_losing_streak ?? data.longestLossStreak, 0),
              ],
              [
                cfd
                  ? t("同日完成", "Closed on the same day")
                  : t("7 天内结束", "Closed within 7 days"),
                number(cfd ? data.sameDayCount : data.short_holding_count, 0),
              ],
              [
                t("中位持有周期", "Median holding duration"),
                medianLabel,
              ],
            ]}
          />
        </Panel>
      </div>
      <Panel title={t("分布与尾部风险", "Distribution and tail risk")}>
        <DetailFacts
          data={data}
          fields={
            cfd
              ? [
                  ["盈亏持平", "Breakeven trades", "breakeven", "count"],
                  [
                    "一小时内结束",
                    "Closed within one hour",
                    "under_one_hour_count",
                    "count",
                  ],
                  ["最佳单笔", "Best trade", "best_trade", "money"],
                  ["最差单笔", "Worst trade", "worst_trade", "money"],
                  [
                    "最佳交易占比",
                    "Best trade concentration",
                    "best_trade_concentration",
                    "percent",
                  ],
                  [
                    "前三笔占比",
                    "Top three concentration",
                    "top_three_trade_concentration",
                    "percent",
                  ],
                  [
                    "去除最佳交易后",
                    "Without best trade",
                    "net_without_best_trade",
                    "money",
                  ],
                ]
              : [
                  [
                    "已实现净盈亏",
                    "Net realised P&L",
                    "net_result_gbp",
                    "money",
                  ],
                  ["同日结束", "Same-day trades", "same_day_count", "count"],
                  [
                    "长期持有交易",
                    "Long holding periods",
                    "long_holding_count",
                    "count",
                  ],
                  [
                    "亏损尾部 P10",
                    "Left-tail P10",
                    "left_tail_loss_p10_gbp",
                    "money",
                  ],
                  [
                    "最佳交易占盈利比",
                    "Best-trade share of profits",
                    "best_trade_share_of_gross_wins",
                    "percent",
                  ],
                ]
          }
        />
      </Panel>
      {(best.length > 0 || worst.length > 0) && (
        <div className="mx-grid">
          {[
            { label: t("主要盈利交易", "Largest winning trades"), rows: best },
            { label: t("主要亏损交易", "Largest losing trades"), rows: worst },
          ].map((group) => (
            <Panel key={group.label} title={group.label}>
              {group.rows.slice(0, 10).map((r, i) => (
                <Link
                  key={i}
                  className="mx-row-link"
                  href={"/research?ticker=" + encodeURIComponent(str(r.ticker))}
                >
                  <SecurityPeek ticker={str(r.ticker)}>
                    <Instrument ticker={str(r.ticker)} name={str(r.name)} small />
                  </SecurityPeek>
                  <span className={"mx-row-value mx-" + tone(r.netResultGbp)}>
                    {currency(r.netResultGbp, "GBP", 2)}
                    <small>
                      {number(r.durationDays, 0)} {number(r.durationDays, 0) === "1" ? t("天", "day") : t("天", "days")}
                      {cfd && str(r.direction) ? " · " + str(r.direction) : ""}
                      {numeric(r.feesGbp) ? " · " + t("费用 ", "Fees ") + currency(r.feesGbp, "GBP", 2) : ""}
                    </small>
                  </span>
                  <ArrowUpRight aria-hidden="true" size={16} />
                </Link>
              ))}
            </Panel>
          ))}
        </div>
      )}
      {objects(data.top_n_counterfactuals).length > 0 && (
        <Panel
          title={t("如果少了最好的几笔交易", "Without the best trades")}
          help={t(
            "用反事实观察收益集中度，不代表另一种可实现策略。",
            "A counterfactual view of profit concentration, not an alternative achievable strategy.",
          )}
        >
          <EvidenceTable
            label={t("剔除最佳交易后的结果", "Without top trades")}
            rows={objects(data.top_n_counterfactuals)}
            columns={[
              {
                label: t("移除前 N", "Remove top N"),
                value: (r) => number(r.removeTopN, 0),
              },
              {
                label: t("实际剔除笔数", "Removed trades"),
                value: (r) => number(r.removedTradeCount, 0),
                numeric: true,
              },
              {
                label: t("剔除收益", "Removed result"),
                value: (r) => currency(r.removedResultGbp, "GBP", 2),
                numeric: true,
              },
              {
                label: t("剩余净盈亏", "Remaining net P&L"),
                value: (r) => currency(r.remainingNetResultGbp, "GBP", 2),
                numeric: true,
              },
              {
                label: t("仍然盈利", "Still profitable"),
                value: (r) =>
                  r.remainingProfitable === true
                    ? t("是", "Yes")
                    : r.remainingProfitable === false
                      ? t("否", "No")
                      : "—",
              },
            ]}
          />
        </Panel>
      )}
    </div>
  );
}
const PHASE_BATCH = 8;

export function Phases({ data, focusPhase }: { data: Json; focusPhase?: string }) {
  const t = useCopy();
  const { locale } = useLocale();
  const rows = objects(data.items);
  const [visible, setVisible] = useState(() => {
    const target = rows.findIndex((row) => row.phaseId === focusPhase);
    const start = Math.floor(Math.max(0, target) / PHASE_BATCH) * PHASE_BATCH;
    return { start, end: start + PHASE_BATCH };
  });
  const focusNext = useRef<number | null>(null);
  const nextArticle = useRef<HTMLElement>(null);
  const earlierButton = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState("");
  const screenStart = Math.min(visible.start, Math.max(0, rows.length - 1));
  const [printing, setPrinting] = useState(false);
  const start = printing ? 0 : screenStart;
  const end = Math.min(visible.end, rows.length);
  useLayoutEffect(() => {
    // The shortcut mounts only its batch on screen. Print includes the history leading to it.
    let restoreEarlierFocus = false;
    const beforePrint = () => {
      restoreEarlierFocus ||= earlierButton.current === document.activeElement;
      flushSync(() => setPrinting(true));
    };
    const afterPrint = () => {
      flushSync(() => setPrinting(false));
      if (restoreEarlierFocus && document.activeElement === document.body) {
        earlierButton.current?.focus({ preventScroll: true });
      }
      restoreEarlierFocus = false;
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, []);
  function reveal(direction: "before" | "after", keyboard: boolean) {
    const next = direction === "before"
      ? { start: Math.max(0, screenStart - PHASE_BATCH), end }
      : { start: screenStart, end: Math.min(rows.length, end + PHASE_BATCH) };
    focusNext.current = keyboard ? (direction === "before" ? next.start : end) : null;
    const count = next.end - next.start;
    setLoaded(t("已显示 {count} / {total} 个阶段", "{count} of {total} phases shown").replace("{count}", String(count)).replace("{total}", String(rows.length)));
    setVisible(next);
  }
  useLayoutEffect(() => {
    if (focusNext.current === null) return;
    nextArticle.current?.focus({ preventScroll: true });
    nextArticle.current?.scrollIntoView({ block: "start", behavior: "instant" });
    focusNext.current = null;
  }, [screenStart, end]);
  const classifications: Record<string, string> = {
    large_cash_flow: t("大额资金变动", "Significant cash movement"),
    drawdown_recovery: t("回撤修复", "Drawdown recovery"),
    drawdown_formation: t("回撤形成", "Drawdown building"),
    profit_phase: t("收益增长", "Gains accumulating"),
    loss_phase: t("亏损阶段", "Losses accumulating"),
    flat_phase: t("平稳阶段", "A steady period"),
  };
  const events: Record<string, string> = {
    largest_absolute_realised_change: t("单笔已实现盈亏变化最大", "Largest realised P&L change"),
    largest_account_cash_flow: t("单笔出入金最大", "Largest deposit or withdrawal"),
    realised_drawdown_trough: t("已实现盈亏回撤最低点", "Realised P&L drawdown trough"),
    phase_start: t("阶段开始 · 当日盈亏", "Phase begins · daily P&L"),
    phase_end: t("阶段结束 · 当日盈亏", "Phase ends · daily P&L"),
    largest_absolute_pnl_day: t(
      "单日盈亏变化最大",
      "Largest daily P&L movement",
    ),
    drawdown_trough: t("累计盈亏回撤最低点", "Cumulative P&L drawdown trough"),
    largest_external_flow: t(
      "单笔外部出入金最大",
      "Largest external deposit or withdrawal",
    ),
  };
  return (
    <Panel title={t("投资阶段", "Investment phases")}>
      {rows.length ? (
        <div className="mx-timeline">
          <StatusMessage message={loaded} />
          {screenStart > 0 && (
            <Button ref={earlierButton} variant="secondary" className={printing ? "mb-4 print:hidden" : "mb-4"} onClick={(event) => reveal("before", event.detail === 0)}>
              {t("查看更早的阶段", "Show earlier phases")} · {screenStart}
            </Button>
          )}
          {rows.slice(start, end).map((row, index) => {
            const pnl = row.netPnlGbp ?? row.realisedPnlGbp;
            const phaseTone = tone(pnl);
            return <article
              ref={(article) => {
                if (article && focusNext.current === start + index) nextArticle.current = article;
              }}
              key={str(row.phaseId) || start + index}
              id={`review-phase-${str(row.phaseId)}`}
              tabIndex={-1}
              className="mx-timeline-entry scroll-mt-[var(--shell-anchor-gap)]"
            >
              <time>
                {formatDateSpan(str(row.startDate), str(row.endDate), locale)}
              </time>
              <div className="flex flex-wrap items-center justify-between gap-mx-md">
                <h3>
                  {classifications[str(row.classification)] ??
                    t("阶段 ", "Phase ") + (start + index + 1)}
                </h3>
                <Tag tone={phaseTone === "down" ? "bad" : phaseTone === "up" ? "good" : undefined}>
                  {currency(pnl, "GBP", 2)}
                </Tag>
              </div>
              <div className="mx-metric-grid" style={{ margin: "16px 0" }}>
                <Metric
                  label={t("期初价值", "Opening value")}
                  value={currency(
                    row.openingValueGbp ??
                      row.openingRealisedCashEquityProxyGbp,
                  )}
                />
                <Metric
                  label={t("期末价值", "Ending value")}
                  value={currency(
                    row.endingValueGbp ?? row.endingRealisedCashEquityProxyGbp,
                  )}
                />
                <Metric
                  label={t("净入金", "Net deposits")}
                  value={currency(
                    row.netExternalFlowsGbp ?? row.accountCashFlowGbp,
                  )}
                />
                <Metric
                  label={t("最大盈亏回撤", "Max P&L drawdown")}
                  value={currency(
                    row.maxPnlDrawdownGbp ?? row.maxRealisedPnlDrawdownGbp,
                  )}
                />
              </div>
              <Facts
                rows={[
                  [
                    t("期末盈亏回撤", "Ending P&L drawdown"),
                    currency(
                      row.endingPnlDrawdownGbp ??
                        row.endingRealisedPnlDrawdownGbp,
                    ),
                  ],
                ]}
              />
              <ReviewDisclosure label={t("贡献与拖累", "Contributors and detractors")} className="mx-chart-data">
                <EvidenceTable
                  label={t("阶段收益来源", "Phase contribution")}
                  rows={[
                    ...objects(row.topContributors),
                    ...objects(row.topDetractors),
                  ]}
                  columns={[
                    {
                      label: t("来源", "Source"),
                      value: (r) => str(r.label ?? r.key),
                    },
                    {
                      label: t("净贡献", "Net contribution"),
                      value: (r) =>
                        currency(r.netResultGbp ?? r.realisedPnl, "GBP", 2),
                      numeric: true,
                    },
                  ]}
                />
              </ReviewDisclosure>
              {objects(row.evidenceEvents).map((event, i) => (
                <p key={i}>
                  {formatCalendarDate(str(event.date ?? event.occurredAt), locale)} ·{" "}
                  {events[str(event.type)] ?? t("阶段事件", "Phase event")} ·{" "}
                  {currency(event.amountGbp, "GBP", 2)}
                </p>
              ))}
            </article>;
          })}
          {rows.length > end && (
            <Button variant="secondary" onClick={(event) => reveal("after", event.detail === 0)}>
              {t("查看更多阶段", "Show more phases")} · {end} / {rows.length}
            </Button>
          )}
        </div>
      ) : (
        <Empty
          title={t("还没有完整的阶段记录", "No complete phase history yet")}
          description={t(
            "足够的账户历史可用于划分阶段并关联出入金。",
            "A longer account history allows phases, deposits and withdrawals to be identified.",
          )}
        />
      )}
    </Panel>
  );
}
export function EndingRisk({
  data,
  cfd,
}: {
  data: Json;
  dashboard: DashboardLens;
  cfd: boolean;
}) {
  const t = useCopy();
  if (cfd)
    return (
      <Panel title={t("期末风险的可见范围", "What is visible at the end")}>
        <Notice>
          {t(
            "导入记录无法重建当前未平仓市值。请在券商中核对实时仓位与保证金。",
            "Imported records cannot reconstruct current open-position values. Check live positions and margin at the broker.",
          )}
        </Notice>
        <Facts
          rows={[
            [
              t("未匹配成交订单", "Unmatched executed orders"),
              number(data.unmatchedExecutedOrderCount, 0),
            ],
          ]}
        />
      </Panel>
    );
  const holdings = objects(data.holdings);
  return (
    <>
      <Panel title={t("复盘终点，仍然持有什么", "What remained at the end")}>
        <div className="mx-metric-grid">
          <Metric
            label={t("持仓数量", "Holdings")}
            value={number(data.position_count ?? holdings.length, 0)}
          />
          <Metric
            label={t("现金权重", "Cash weight")}
            value={percent(data.cash_weight)}
          />
          <Metric
            label={t("已投资市值", "Invested value")}
            value={currency(data.invested_value_gbp)}
          />
          <Metric
            label={t("浮动盈亏", "Unrealised P&L")}
            value={currency(data.unrealized_pnl_gbp)}
          />
        </div>
        <Bars
          label={t("期末持仓市值", "Ending holdings by value")}
          labels={holdings.map((h) => str(h.ticker))}
          values={holdings.map((h) =>
            numeric(h.currentValueGbp ?? h.current_value_gbp),
          )}
        />
      </Panel>
      <EndingEvidence data={data} />
      <TextLink href="/holdings?view=lookthrough">
        {t(
          "穿透当前组合，检查底层集中度",
          "Inspect current underlying concentration",
        )}
      </TextLink>
    </>
  );
}
