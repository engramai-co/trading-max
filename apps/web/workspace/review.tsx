"use client";

import { SystemNotes } from "./review-evidence";
import { Group, Select } from "@mantine/core";
import { ArrowRight, ArrowUpRight } from "@phosphor-icons/react";
import Link from "./link";
import { useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { AccountCode, DashboardLens } from "@/lib/types";
import { PerformanceContent } from "./performance";
import { CfdImports } from "./settings-preferences";
import {
  Availability,
  BehaviorEvidence,
  CfdCashEvidence,
  StrategyEvidence,
  field,
} from "./review-evidence";
import { HistoryChart } from "./charts";
import { currency, object, percent, str, tone, type Json } from "@/workspace/data";
import { navNumber, observedNav, type Scope } from "@/lib/portfolio/nav";
import {
  Bento,
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
  useCopy,
} from "./foundation";
import { accountName, useWorkspaceProfile } from "./profile";
import { useRouteState } from "./route-state";
import { reviewHighlights } from "./review-highlights";
import { DecisionReview, effectTone, observing, signedMoney, verdictWord, type TradeDecision } from "./review-decisions";
import { Attribution, Coverage, EndingRisk, Phases, TradeQuality } from "./review-perspectives";

export function ReviewWorkspace() {
  const t = useCopy();
  const { locale } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  const query = useDashboardLens("review");
  const latest = (["A", "B"] as const)
    .flatMap((code) =>
      (query.data?.decisionReviews?.[code]?.decisions ?? []).map((row: TradeDecision) => ({ ...row, account: code })),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.amountGbp - a.amountGbp);
  // Decisions without a close after them yet say nothing on their own; they share one line.
  const watching = [...new Set(latest.filter(observing).map((row) => row.ticker))];
  const watchingCount = latest.filter(observing).length;
  const recent = latest.filter((row) => !observing(row)).slice(0, 8);
  // A retired CFD account keeps its review, reached from the account switcher.
  const codes = query.data?.cfd?.accountStatus === "retired" ? (["A", "B"] as const) : (["A", "B", "C"] as const);
  return (
    <Page title={t("投资复盘", "Investment review")}>
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        query.data && (
          <>
              <div className={"mx-grid" + (codes.length === 3 ? " mx-grid-three" : "")}>
                {codes.map((code) => {
                  const account = query.data?.accounts?.find(
                    (a) => a.code === code,
                  );
                  const cfd = code === "C" ? query.data?.cfd : null;
                  const risk = code !== "C" ? query.data?.risk?.[code] : null;
                  const decisions = code !== "C" ? query.data?.decisionReviews?.[code] : null;
                  const days = decisions?.horizonDays ?? 20;
                  const verdict = (side: "buys" | "sells") => {
                    const summary = decisions?.status === "available" ? decisions[side] : null;
                    if (!summary?.evaluated) return "—";
                    const effect = summary.effectHorizonGbp ?? 0;
                    const word = verdictWord(side === "buys" ? "buy" : "sell", effect, t);
                    return (
                      <span key={side} className={"mx-" + effectTone(effect)}>
                        {(word ? word + " " : "") + currency(Math.abs(effect))}
                      </span>
                    );
                  };
                  const available = Boolean(account || cfd);
                  return (
                    <Link
                      className="mx-panel mx-account-card"
                      key={code}
                      href={"/account-analysis?account=" + code}
                    >
                      <Group justify="space-between" wrap="nowrap" gap="sm">
                        <h2>{accountName(profile, code)}</h2>
                        {!available ? (
                          <Tag>{t("等待数据", "Awaiting data")}</Tag>
                        ) : (
                          <ArrowUpRight className="mx-account-go" size={18} aria-hidden />
                        )}
                      </Group>
                      {code === "C" && cfd && (
                        <p className="mx-form-help">
                          {t("导入历史 · 已实现现金权益代理", "Imported history · realized cash equity proxy")}
                        </p>
                      )}
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
                                ["TWR", <span key="twr" className={risk?.twr == null ? undefined : risk.twr < 0 ? "mx-down" : "mx-up"}>{percent(risk?.twr, true)}</span>],
                                [
                                  locale === "zh" ? `卖出后 ${days} 个交易日` : `Sells after ${days} trading days`,
                                  verdict("sells"),
                                ],
                                [
                                  locale === "zh" ? `买入后 ${days} 个交易日` : `Buys after ${days} trading days`,
                                  verdict("buys"),
                                ],
                              ]
                        }
                      />
                    </Link>
                  );
                })}
              </div>
              {(recent.length > 0 || watchingCount > 0) && (
                <Panel title={t("最近的买卖决定", "Recent decisions")}>
                  {watchingCount > 0 && (
                    <p className="mx-decision-watching">
                      {locale === "zh" ? `观察中 ${watchingCount} 笔` : `Watching ${watchingCount}`}
                      <span className="mx-muted">{" · " + watching.join(locale === "zh" ? "、" : ", ")}</span>
                    </p>
                  )}
                  {recent.map((row) => (
                    <Link
                      key={row.account + row.date + row.ticker + row.side}
                      className="mx-row-link mx-decision-row"
                      href={"/account-analysis?account=" + row.account + "&reviewView=decisions"}
                    >
                      <Instrument ticker={row.ticker} name={accountName(profile, row.account)} small />
                      <span className={"mx-row-value mx-" + effectTone(row.effectToDateGbp)}>
                        {signedMoney(row.effectToDateGbp)}
                        <small>
                          {formatCalendarDate(row.date, locale)} ·{" "}
                          {row.side === "buy" ? t("买入 ", "Bought ") : t("卖出 ", "Sold ")}
                          {currency(row.amountGbp)} · {t("之后 ", "then ")}
                          {percent(row.returnToDate, true, 1)}
                        </small>
                      </span>
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  ))}
                </Panel>
              )}
          </>
        )
      )}
    </Page>
  );
}
const ACCOUNT_REVIEW_SELECTION = { detail: "summary" as const };

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
  const query = useDashboardLens("account-analysis", code, true, ACCOUNT_REVIEW_SELECTION);
  return (
    <Page
      title={
        accountName(profile, code) + " · " + t("投资复盘", "Account review")
      }
      actions={
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
  const { params } = useRouteState();
  const decisionsAvailable = data.selectedAccountDecisions?.status === "available";
  const [tab, setTab] = useState(
    params.get("reviewView") ?? (decisionsAvailable ? "decisions" : "outcome"),
  );
  const [focusPhase, setFocusPhase] = useState("");
  const evidence = useRef<HTMLElement>(null);
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
      <Bento className="mx-review-bento">
      <Panel bare className="mx-bento-wide">
        <div className="mx-metric-grid mx-metric-lead">
          <Metric
            label={
              cfd ? (
                // The caveat sits beside the figure it qualifies, not in a banner above the page.
                <>
                  {t("期末价值", "Ending value")}
                  <span
                    className="mx-estimate-tag"
                    title={t(
                      "导入的 CFD 历史只能还原已实现的现金权益：不含当前未平仓市值，也不等于券商净值。",
                      "Imported CFD history only rebuilds realized cash equity: it excludes open positions and is not broker NAV.",
                    )}
                  >
                    <Tag>{t("已实现现金权益", "Realized cash equity")}</Tag>
                  </span>
                </>
              ) : (
                t("期末价值", "Ending value")
              )
            }
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
              // The review's figures are as of the run that built it, which can be
              // hours older than the live account value on the overview.
              data.reviewAsOf ?? (str(field(object(review.coverage), "end_date")) || data.brokerAsOf)
            }
          />
        </div>
      </Panel>
      {!unavailable && (
        <ReviewHighlights review={review} cfd={cfd} onEvidence={openEvidence} />
      )}
      </Bento>
      <section
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
            ...(cfd ? [] : [{ value: "decisions", label: t("买卖决定", "Decisions") }]),
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
        {unavailable && tab !== "decisions" && (
          <Notice>
            {t(
              "这份快照没有完整的历史复盘记录。已知的账户数据仍会显示；完成完整更新后可获得更丰富的分析。",
              "This snapshot has no complete historical review. Available account data remains visible; a full update can add further analysis.",
            )}
          </Notice>
        )}
        {tab === "imports" && cfd ? (
          <CfdImports />
        ) : tab === "decisions" && !cfd ? (
          <DecisionReview data={data.selectedAccountDecisions} account={code} dataAsOf={data.reviewAsOf} />
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
                currencyTick
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
            <Panel title={t("资金与记录", "Money and records")}>
              <div className="mx-grid-two mx-reconcile">
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
                <Coverage data={object(review.coverage)} />
              </div>
            </Panel>
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
      </section>
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
  const { locale } = useLocale();
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
        ? formatDateSpan(summary.phase.start, summary.phase.end, locale)
        : missing,
      value: summary.phase?.value,
      partial: summary.phasesPartial,
      target: "phases",
      available: summary.phase != null,
    },
  ];
  return (
    <Panel bare className="mx-bento-wide">
      <div className="mx-review-highlights">
        {cards.map((card) => {
          const body = (
            <>
              <span className="mx-form-help">
                {card.title}
                {card.available && <ArrowRight className="mx-highlight-go" size={14} aria-hidden="true" />}
              </span>
              <strong className="mx-highlight-subject">{card.label}</strong>
              <span className={"mx-highlight-value mx-" + (tone(card.value) ?? "neutral")}>
                {currency(card.value, "GBP", 2)}
              </span>
              {card.partial && <Tag tone="warn">{t("覆盖不完整", "Partial coverage")}</Tag>}
            </>
          );
          // The whole card opens the evidence behind it.
          return card.available ? (
            <button
              type="button"
              className="mx-review-highlight"
              key={card.title}
              onClick={() => onEvidence(card.target, card.target === "phases" ? summary.phase?.id : undefined)}
            >
              {body}
            </button>
          ) : (
            <div className="mx-review-highlight" key={card.title}>
              {body}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
