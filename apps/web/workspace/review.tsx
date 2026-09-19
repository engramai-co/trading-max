"use client";

import { reviewLabel } from "./review-copy";
import { SystemNotes } from "./review-evidence";
import { Button, Group, Select, Stack } from "@mantine/core";
import { ArrowRight, ArrowUpRight } from "@phosphor-icons/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { AccountCode, DashboardLens } from "@/lib/types";
import { PerformanceContent } from "./performance";
import { CfdImports } from "./settings-preferences";
import { EvidenceTable } from "./evidence-table";
import {
  Availability,
  BehaviorEvidence,
  CfdCashEvidence,
  DetailFacts,
  EndingEvidence,
  StrategyEvidence,
  field,
} from "./review-evidence";
import { Bars, HistoryChart } from "./charts";
import {
  currency,
  navNumber,
  observedNav,
  number,
  numeric,
  object,
  objects,
  percent,
  str,
  tone,
  type Json,
  type Scope,
} from "./data";
import {
  Empty,
  Facts,
  Freshness,
  Instrument,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  Tabs,
  Tag,
  TextLink,
  useCopy,
} from "./foundation";
import { accountName, useWorkspaceProfile } from "./profile";
import { useRouteState } from "./route-state";
import { reviewHighlights } from "./review-highlights";

export function ReviewWorkspace() {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const query = useDashboardLens("review");
  return (
    <Page title={t("投资复盘", "Investment review")}>
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        query.data && (
          <>
            <Panel
              title={t("选择复盘账户", "Choose an account")}
            >
              <div className="mx-grid mx-grid-three">
                {(["A", "B", "C"] as const).map((code) => {
                  const account = query.data?.accounts?.find(
                    (a) => a.code === code,
                  );
                  const cfd = code === "C" ? query.data?.cfd : null;
                  const risk = code !== "C" ? query.data?.risk?.[code] : null;
                  const available = Boolean(account || cfd);
                  return (
                    <Link
                      className="mx-panel mx-account-card"
                      key={code}
                      href={"/account-analysis?account=" + code}
                    >
                      <Group justify="space-between">
                        <span className="mx-account-letter">{code}</span>
                        {(!available || code === "C") && <Tag>
                          {available ? t("导入历史", "Imported history") : t("等待数据", "Awaiting data")}
                        </Tag>}
                      </Group>
                      <h2>{accountName(profile, code)}</h2>
                      <p className="mx-form-help">
                        {code === "C"
                          ? t(
                              "已实现现金权益代理",
                              "Realized cash equity proxy",
                            )
                          : t("账户当前价值", "Current account value")}
                      </p>
                      <div className="mx-number">
                        {currency(
                          account?.totalValueGbp ?? cfd?.endingValueGbp,
                          "GBP",
                          2,
                        )}
                      </div>
                      <Facts
                        rows={
                          code === "C"
                            ? [
                                [
                                  t("已实现净盈亏", "Net realized P&L"),
                                  currency(
                                    cfd?.netRealisedPnlGbp ??
                                      cfd?.realizedPnlGbp,
                                  ),
                                ],
                                [
                                  t("记录截止", "Records through"),
                                  <Freshness key="cfd-date" date={cfd?.asOf} label="" />,
                                ],
                              ]
                            : [
                                ["TWR", percent(risk?.twr, true)],
                                [
                                  t("当前回撤", "Current drawdown"),
                                  percent(risk?.currentDrawdown),
                                ],
                              ]
                        }
                      />
                      <div className="mx-text-link">
                        {t("开始复盘", "Explore account")}
                        <ArrowUpRight size={16} />
                      </div>
                    </Link>
                  );
                })}
              </div>
            </Panel>
          </>
        )
      )}
    </Page>
  );
}
export function AccountReviewWorkspace() {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const code: AccountCode =
    params.get("account") === "C"
      ? "C"
      : params.get("account") === "B"
        ? "B"
        : "A";
  const query = useDashboardLens("account-analysis", code);
  return (
    <Page
      title={
        accountName(profile, code) + " · " + t("投资复盘", "Account review")
      }
      actions={
        <Group>
          <TextLink href="/review">{t("全部账户", "All accounts")}</TextLink>
          <Select
            aria-label={t("复盘账户", "Review account")}
            value={code}
            w={150}
            data={[
              { value: "A", label: accountName(profile, "A") },
              { value: "B", label: accountName(profile, "B") },
              { value: "C", label: accountName(profile, "C") },
            ]}
            onChange={(v) => update({ account: v })}
          />
        </Group>
      }
    >
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        query.data && (
          <AccountJournal key={code} data={query.data} code={code} />
        )
      )}
    </Page>
  );
}
function AccountJournal({
  data,
  code,
}: {
  data: DashboardLens;
  code: AccountCode;
}) {
  const t = useCopy();
  const [tab, setTab] = useState("outcome");
  const [focusPhase, setFocusPhase] = useState("");
  const evidence = useRef<HTMLDivElement>(null);
  const openEvidence = (view: string, phaseId = "") => {
    setFocusPhase(phaseId);
    setTab(view);
    requestAnimationFrame(() => {
      const target =
        (phaseId ? document.getElementById(`review-phase-${phaseId}`) : null) ??
        evidence.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  };
  const cfd = code === "C";
  const review = object(
    cfd ? data.selectedCfdReview : data.selectedAccountReview,
  );
  const money = object(review.moneyOutcome);
  const scope: Scope = code === "A" ? "invest" : code === "B" ? "isa" : "cfd";
  const nav = observedNav(data.nav ?? [], scope, "NetPnlGbp");
  const pnl = money.net_pnl_gbp ?? money.netRealisedPnlGbp;
  const account = data.selectedAccount;
  const unavailable = Object.keys(review).length === 0;
  return (
    <>
      {cfd && (
        <Notice tone="warn">
          {t(
            "这是 CFD 导入历史的复盘。已实现现金权益代理不包含当前未平仓市值，也不等于券商净值。",
            "This review uses imported CFD history. The realized cash equity proxy excludes current open positions and is not broker NAV.",
          )}
        </Notice>
      )}
      <Panel>
        <div className="mx-metric-grid">
          <Metric
            label={t("期末价值", "Ending value")}
            value={currency(
              money.ending_value_gbp ??
                money.endingRealisedCashEquityProxyGbp ??
                (unavailable ? account?.totalValueGbp : null),
              "GBP",
              2,
            )}
          />
          <Metric
            label={t("历史净盈亏", "Historical net P&L")}
            value={currency(pnl, "GBP", 2)}
            tone={tone(pnl)}
          />
          <Metric
            label={t("最大盈亏回撤", "Maximum P&L drawdown")}
            value={currency(
              money.max_pnl_drawdown_gbp ?? money.maxRealisedPnlDrawdownGbp,
            )}
            tone="down"
          />
          <Metric
            label={t("净资金流入", "Net cash contributed")}
            value={currency(
              money.net_external_flows_gbp ?? money.accountCashFlowGbp,
            )}
          />
        </div>
        <Availability data={money} />
        <div style={{ marginTop: 22 }}>
          <Freshness
            date={
              str(field(object(review.coverage), "end_date")) || data.brokerAsOf
            }
          />
        </div>
      </Panel>
      {!unavailable && (
        <ReviewHighlights review={review} cfd={cfd} onEvidence={openEvidence} />
      )}
      <div
        ref={evidence}
        tabIndex={-1}
        className="mx-review-evidence"
        aria-label={t("复盘证据", "Review evidence")}
      >
        <Tabs
          value={tab}
          onChange={setTab}
          label={t("复盘角度", "Review perspective")}
          options={[
            { value: "outcome", label: t("投资结果", "Outcomes") },
            { value: "attribution", label: t("盈亏归因", "Attribution") },
            { value: "quality", label: t("交易质量", "Trade quality") },
            { value: "behavior", label: t("行为分析", "Behavior") },
            { value: "strategy", label: t("策略风险", "Strategy risk") },
            { value: "phases", label: t("阶段与事件", "Phases & events") },
            { value: "risk", label: t("期末风险", "Ending risk") },
            ...(cfd
              ? [{ value: "imports", label: t("导入记录", "Import records") }]
              : []),
          ]}
        />
        {unavailable && (
          <Notice>
            {t(
              "这份快照没有完整的历史复盘记录。已知的账户数据仍会显示；完成完整更新后可获得更丰富的分析。",
              "This snapshot has no complete historical review. Available account data remains visible; a full update can add further analysis.",
            )}
          </Notice>
        )}
        {tab === "imports" && cfd ? (
          <CfdImports />
        ) : tab === "outcome" ? (
          <>
            <Panel
              title={t("盈亏的时间线", "The P&L timeline")}
              help={t(
                "展示真实资金结果，不把入金误算成收益。",
                "A record of financial outcomes, with contributions kept separate from returns.",
              )}
            >
              <HistoryChart
                dates={nav.map((p) => p.date)}
                lines={[
                  {
                    name: t("累计净盈亏", "Cumulative net P&L"),
                    values: nav.map((p) => navNumber(p, scope, "NetPnlGbp")),
                    area: true,
                  },
                ]}
                label={t("账户累计净盈亏", "Account cumulative net P&L")}
              />
            </Panel>
            {cfd && <CfdCashEvidence review={review} />}
            <div className="mx-grid">
              <Panel title={t("资金核对", "Reconcile the money")}>
                <Facts
                  rows={[
                    [
                      t("期初价值", "Opening value"),
                      currency(
                        money.opening_value_gbp ??
                          money.openingRealisedCashEquityProxyGbp,
                      ),
                    ],
                    [
                      t("入金", "Deposits"),
                      currency(money.deposits_gbp ?? money.depositsGbp),
                    ],
                    [
                      t("出金", "Withdrawals"),
                      currency(money.withdrawals_gbp ?? money.withdrawalsGbp),
                    ],
                    [
                      t("期末价值", "Ending value"),
                      currency(
                        money.ending_value_gbp ??
                          money.endingRealisedCashEquityProxyGbp,
                      ),
                    ],
                    [
                      t("净盈亏率", "Net P&L rate"),
                      percent(money.net_pnl_rate, true),
                    ],
                  ]}
                />
              </Panel>
              <Panel title={t("记录覆盖", "Observation coverage")}>
                <Coverage data={object(review.coverage)} />
              </Panel>
            </div>
          </>
        ) : tab === "attribution" ? (
          <Attribution data={object(review.attribution)} cfd={cfd} />
        ) : tab === "quality" ? (
          <TradeQuality
            data={object(
              cfd ? review.tradeQuality : review.realisedTradeQuality,
            )}
            legacy={object(data.selectedAccountAnalysis)}
            cfd={cfd}
          />
        ) : tab === "behavior" ? (
          <BehaviorEvidence
            data={object(review.structuralDiagnostics)}
            cfd={cfd}
          />
        ) : tab === "strategy" ? (
          <>
            <StrategyEvidence data={object(review.strategyRisk)} />
            {!cfd && <PerformanceContent data={data} fixedScope={scope} />}
          </>
        ) : tab === "phases" ? (
          <Phases
            key={focusPhase}
            data={object(review.phases)}
            focusPhase={focusPhase}
          />
        ) : (
          <EndingRisk
            data={object(review.endingRisk)}
            dashboard={data}
            cfd={cfd}
          />
        )}
        {Array.isArray(review.warnings) && review.warnings.length > 0 && (
          <SystemNotes values={review.warnings.map(String)} />
        )}
      </div>
    </>
  );
}
function ReviewHighlights({
  review,
  cfd,
  onEvidence,
}: {
  review: Json;
  cfd: boolean;
  onEvidence: (view: string, phaseId?: string) => void;
}) {
  const t = useCopy();
  const summary = reviewHighlights(review, cfd);
  const missing = t("记录不足", "Insufficient records");
  const cards = [
    {
      title: t("已实现盈利贡献", "Leading realized gain"),
      label:
        summary.contributor?.label ??
        (summary.hasInstruments
          ? t("未见正贡献", "No positive contribution")
          : missing),
      value: summary.contributor?.value,
      partial: summary.attributionPartial,
      target: "attribution",
      available: summary.hasInstruments,
    },
    {
      title: t("已实现亏损拖累", "Leading realized loss"),
      label:
        summary.detractor?.label ??
        (summary.hasInstruments
          ? t("未见负贡献", "No negative contribution")
          : missing),
      value: summary.detractor?.value,
      partial: summary.attributionPartial,
      target: "attribution",
      available: summary.hasInstruments,
    },
    {
      title: cfd ? t("已实现盈亏变动最大阶段", "Largest realized P&L phase") : t("盈亏变动最大阶段", "Largest P&L phase"),
      label: summary.phase
        ? summary.phase.start === summary.phase.end
          ? summary.phase.start || "—"
          : `${summary.phase.start || "—"} → ${summary.phase.end || "—"}`
        : missing,
      value: summary.phase?.value,
      partial: summary.phasesPartial,
      target: "phases",
      available: summary.phase != null,
    },
  ];
  return (
    <Panel
      title={t("本次结论", "Review highlights")}
    >
      <div className="mx-review-highlights">
        {cards.map((card) => (
          <div className="mx-review-highlight" key={card.title}>
            <span className="mx-form-help">{card.title}</span>
            <strong className="mx-highlight-subject">{card.label}</strong>
            <span
              className={`mx-highlight-value mx-${tone(card.value) ?? "neutral"}`}
            >
              {currency(card.value, "GBP", 2)}
            </span>
            {card.partial && <Tag tone="warn">{t("覆盖不完整", "Partial coverage")}</Tag>}
            {card.available && (
              <button
                className="mx-text-link"
                onClick={() =>
                  onEvidence(
                    card.target,
                    card.target === "phases" ? summary.phase?.id : undefined,
                  )
                }
                aria-label={`${card.title} · ${t("查看证据", "View evidence")}`}
              >
                {t("查看证据", "View evidence")}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
function Coverage({ data }: { data: Json }) {
  const t = useCopy();
  return (
    <Facts
      rows={[
        [
          t("开始日期", "First record"),
          str(data.start_date ?? data.startDate) || "—",
        ],
        [
          t("截止日期", "Last record"),
          str(data.end_date ?? data.endDate) || "—",
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
function Attribution({ data, cfd }: { data: Json; cfd: boolean }) {
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
    net_realised_result: t("净收益", "Net result"),
  };
  const label = (r: Json) => components[str(r.label)] ?? reviewLabel(str(r.label ?? r.key), t);
  const value = (r: Json) =>
    numeric(r.netResultGbp ?? r.netRealisedPnl ?? field(r, "contribution_gbp"));
  const labels: Record<string, string> = {
    instrument: t("证券", "Security"),
    country: t("国家", "Country"),
    industry: t("行业", "Industry"),
    direction: t("方向", "Direction"),
    duration: t("持有周期", "Holding period"),
    weekday: t("星期", "Weekday"),
    date: t("日期", "Date"),
    year: t("年度", "Year"),
    month: t("月份", "Month"),
    components: t("费用组成", "P&L components"),
  };
  return (
    <Panel
      title={t("已实现盈亏归因 · GBP", "Realized P&L attribution · GBP")}
      action={
        <Select
          aria-label={t("归因维度", "Attribution dimension")}
          value={dimension}
          onChange={(v) => setDimension(v ?? "instrument")}
          data={Object.keys(keys).map((k) => ({ value: k, label: labels[k] }))}
          w={140}
        />
      }
    >
      <Bars
        label={t("已实现盈亏贡献", "Realized P&L contribution")}
        labels={rows.slice(0, 14).map(label)}
        values={rows.slice(0, 14).map(value)}
      />
      <Availability data={cfd ? data : object(raw)} />
      <EvidenceTable
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
            label: t("净结果", "Net result"),
            value: (r) => currency(value(r), "GBP", 2),
            numeric: true,
          },
        ]}
      />
    </Panel>
  );
}
function TradeQuality({
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
  const best = objects(data.best_trades).filter(
      (trade) => (numeric(trade.netResultGbp) ?? 0) > 0,
    ),
    worst = objects(data.worst_trades).filter(
      (trade) => (numeric(trade.netResultGbp) ?? 0) < 0,
    );
  return (
    <Stack gap="lg">
      <Panel
        title={t("过程是否可持续", "Understand the trading process")}
        help={t(
          "观察已结束交易的分布与质量，不从记录推断投资动机。",
          "Examine closed-trade distributions without inferring investment motives.",
        )}
      >
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
                number(data.average_holding_days ?? data.averageDurationHours),
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
                number(data.median_holding_days ?? data.medianDurationHours),
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
                  ["盈亏持平", "Breakeven trades", "breakeven", "number"],
                  [
                    "一小时内结束",
                    "Closed within one hour",
                    "under_one_hour_count",
                    "number",
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
                    "剔除最佳后",
                    "Without best trade",
                    "net_without_best_trade",
                    "money",
                  ],
                ]
              : [
                  [
                    "已实现净结果",
                    "Net realized result",
                    "net_result_gbp",
                    "money",
                  ],
                  ["同日结束", "Same-day trades", "same_day_count", "number"],
                  [
                    "长期持有交易",
                    "Long holding periods",
                    "long_holding_count",
                    "number",
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
                  <Instrument ticker={str(r.ticker)} name={str(r.name)} small />
                  <span className={"mx-row-value mx-" + tone(r.netResultGbp)}>
                    {currency(r.netResultGbp, "GBP", 2)}
                    <small>
                      {number(r.durationDays)} {t("天", "days")} ·{" "}
                      {str(r.direction)} · {t("费用", "Fees")}{" "}
                      {currency(r.feesGbp, "GBP", 2)}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
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
                label: t("剩余净收益", "Remaining result"),
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
          <Bars
            label={t("剔除后的净盈亏", "Remaining net P&L")}
            labels={objects(data.top_n_counterfactuals).map(
              (r) => t("移除前 ", "Remove top ") + number(r.removeTopN, 0),
            )}
            values={objects(data.top_n_counterfactuals).map((r) =>
              numeric(r.remainingNetResultGbp),
            )}
          />
        </Panel>
      )}
    </Stack>
  );
}
function Phases({ data, focusPhase }: { data: Json; focusPhase?: string }) {
  const t = useCopy();
  const rows = objects(data.items);
  const [phaseLimit, setPhaseLimit] = useState(() =>
    Math.max(8, rows.findIndex((row) => row.phaseId === focusPhase) + 1),
  );
  const classifications: Record<string, string> = {
    large_cash_flow: t("大额资金变动", "Significant cash movement"),
    drawdown_recovery: t("回撤修复", "Drawdown recovery"),
    drawdown_formation: t("回撤形成", "Drawdown building"),
    profit_phase: t("收益增长", "Gains accumulating"),
    loss_phase: t("亏损阶段", "Losses accumulating"),
    flat_phase: t("平稳阶段", "A steady period"),
  };
  const events: Record<string, string> = {
    largest_absolute_realised_change: t("单笔已实现盈亏变化最大", "Largest realized P&L change"),
    largest_account_cash_flow: t("单笔账户资金流最大", "Largest account cash flow"),
    realised_drawdown_trough: t("已实现盈亏回撤最低点", "Realized P&L drawdown trough"),
    phase_start: t("阶段开始 · 当日盈亏", "Phase begins · daily P&L"),
    phase_end: t("阶段结束 · 当日盈亏", "Phase ends · daily P&L"),
    largest_absolute_pnl_day: t(
      "单日盈亏变化最大",
      "Largest daily P&L movement",
    ),
    drawdown_trough: t("累计盈亏回撤最低点", "Cumulative P&L drawdown trough"),
    largest_external_flow: t(
      "单笔外部资金流最大",
      "Largest external cash flow",
    ),
  };
  return (
    <Panel title={t("投资阶段", "Investment phases")}>
      {rows.length ? (
        <div className="mx-timeline">
          {rows.slice(0, phaseLimit).map((row, index) => (
            <article
              className="mx-timeline-entry"
              key={str(row.phaseId) || index}
              id={`review-phase-${str(row.phaseId)}`}
              tabIndex={-1}
              style={{ scrollMarginTop: 24 }}
            >
              <time>
                {str(row.startDate)} → {str(row.endDate)}
              </time>
              <Group justify="space-between">
                <h3>
                  {classifications[str(row.classification)] ??
                    t("阶段 ", "Phase ") + (index + 1)}
                </h3>
                <Tag
                  tone={
                    (numeric(row.netPnlGbp ?? row.realisedPnlGbp) ?? 0) < 0
                      ? "bad"
                      : "good"
                  }
                >
                  {currency(row.netPnlGbp ?? row.realisedPnlGbp, "GBP", 2)}
                </Tag>
              </Group>
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
                  label={t("净入金", "Net contributions")}
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
              <details className="mx-chart-data">
                <summary>
                  {t("贡献与拖累", "Contributors and detractors")}
                </summary>
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
              </details>
              {objects(row.evidenceEvents).map((event, i) => (
                <p key={i}>
                  {str(event.date ?? event.occurredAt)} ·{" "}
                  {events[str(event.type)] ?? t("阶段事件", "Phase event")} ·{" "}
                  {currency(event.amountGbp, "GBP", 2)}
                </p>
              ))}
            </article>
          ))}
          {rows.length > phaseLimit && (
            <Button
              variant="default"
              onClick={() => setPhaseLimit((n) => n + 8)}
            >
              {t("查看更多阶段", "Show more phases")} · {phaseLimit} /{" "}
              {rows.length}
            </Button>
          )}
        </div>
      ) : (
        <Empty
          title={t("还没有完整的阶段记录", "No complete phase history yet")}
          description={t(
            "足够的账户历史可用于划分阶段并关联资金事件。",
            "A longer account history allows phases and cash-flow events to be identified.",
          )}
        />
      )}
    </Panel>
  );
}
function EndingRisk({
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
            label={t("持仓数量", "Positions")}
            value={number(data.position_count ?? holdings.length, 0)}
          />
          <Metric
            label={t("现金权重", "Cash weight")}
            value={percent(data.cash_weight)}
          />
          <Metric
            label={t("投资市值", "Invested value")}
            value={currency(data.invested_value_gbp)}
          />
          <Metric
            label={t("未实现盈亏", "Unrealized P&L")}
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
