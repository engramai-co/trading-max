"use client";

import { ArrowRight } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatDateSpan } from "@/ui/formatters";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { AccountCode, DashboardLens } from "@/lib/types";
import { navNumber, observedNav, type Scope } from "@/lib/portfolio/nav";
import { currency, object, percent, str, tone, type Json } from "@/workspace/data";
import { PerformanceContent } from "./performance";
import { CfdImports } from "./settings-preferences";
import {
  Availability,
  BehaviorEvidence,
  CfdCashEvidence,
  StrategyEvidence,
  SystemNotes,
  field,
} from "./review-evidence";
import { HistoryChart } from "./charts";
import {
  Empty,
  Facts,
  Freshness,
  Help,
  Metric,
  Page,
  Panel,
  Pending,
  QueryError,
  UpdateFailure,
  Tabs,
  Tag,
  useCopy,
} from "./foundation";
import Link from "./link";
import { accountName, useWorkspaceProfile } from "./profile";
import { useRouteState } from "./route-state";
import { reviewHighlights } from "./review-highlights";
import {
  BestCloses,
  DecisionTimelinePanel,
  horizonScope,
  HorizonSwitch,
  type HorizonChoices,
  RoundTrips,
  linkedDecision,
  parseDecisionParam,
  sameDecision,
  roundTripVerdict,
  useDecisionHorizon,
} from "./review-decisions";
import {
  type DecisionAccount,
  type DecisionExpansion,
  type ReviewScope,
  type ScopedDecision,
  DecisionExtremes,
  RecentJournal,
  ReviewAccounts,
  ReviewLead,
  ScopeSwitch,
  allDecisions,
  combinedRoundTrips,
  decisionSelectionParams,
  parseReviewWindow,
  reviewLoadingLabel,
  reviewScope,
  scopedDecisions,
} from "./review-board";
import { previousForIdentity } from "./loading-state";
import { useRetainedResult } from "./retained-result";
import { Attribution, Coverage, EndingRisk, Phases, TradeQuality } from "./review-perspectives";

import { useAssistant } from "./assistant/context";
import { ASSISTANT_NAME } from "./assistant-settings";
import { fallObservations, habitDecisions, habitLabels, isHabit, toolHorizon, type Habit } from "./review-patterns";
const ReviewHabits = lazy(async () => ({ default: (await import("./assistant/review")).ReviewHabits }));
const DecisionReading = dynamic(() => import("./assistant/review").then(module => module.DecisionReading));
const FallTimeline = dynamic(() => import("./assistant/review-falls").then(module => module.FallTimeline));

const ACCOUNT_REVIEW_SELECTION = { detail: "summary" as const };

function HabitsSpace({ unavailable = false }: { unavailable?: boolean }) {
  const t = useCopy();
  const [expanded] = useState(() => {
    try { return localStorage.getItem("tm-reading-review-habits") === "open"; }
    catch { return false; }
  });
  return <div className="mx-review-habits-space" data-expanded={expanded || undefined} aria-hidden={!unavailable || undefined}>
    <strong>{t("习惯", "Habits")}</strong>
    <p>{t("模型暂不可用。", "The model is unavailable.")} <Link href="/settings?tab=assistant" prefetch={false} tabIndex={unavailable ? undefined : -1}>{t("{name} 设置", "{name} settings").replace("{name}", ASSISTANT_NAME)}</Link></p>
  </div>;
}

function focusHabitFilter(button: HTMLButtonElement | null) {
  button?.focus({ preventScroll: true });
  button?.scrollIntoView({ block: "center", behavior: "instant" });
}

/**
 * One review for every account: the scope beside the title, then what the decisions did, each
 * decision on a timeline, the ones that helped and cost the most, and the recent record. A single
 * account adds its own analysis below.
 */
export function ReviewWorkspace() {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  // The scope and its angle are places, as a security and its lens are on the research desk:
  // each choice is a history entry, so Back retraces them.
  const { params, update } = useRouteState("push");
  const scope = reviewScope(params.get("account"));
  const all = scope === "all";
  const snapshotId = params.get("snapshotId");
  const pinned = snapshotId !== null;
  const decisionParamValue = params.get("decision");
  const reference = parseDecisionParam(decisionParamValue);
  const validScope = params.get("account") === null || params.get("account") === scope;
  const canRead = !pinned || (!!snapshotId && validScope && scope !== "C" &&
    (decisionParamValue === null || (!all && !!reference)));
  const overview = useDashboardLens("review", undefined, all && canRead, pinned ? ACCOUNT_REVIEW_SELECTION : undefined, snapshotId ?? undefined);
  const single = useDashboardLens("account-analysis", all ? "A" : scope, !all && canRead, ACCOUNT_REVIEW_SELECTION, snapshotId ?? undefined);
  const query = all ? overview : single;
  const current = useMemo(
    () => query.data && { scope, data: query.data, updatedAt: query.dataUpdatedAt },
    [scope, query.data, query.dataUpdatedAt],
  );
  const retained = useRetainedResult(pinned ? undefined : current);
  // Keep a same-scope review across refetches, but never show another account's figures under a new label.
  const live = previousForIdentity(retained, retained?.scope, scope);
  // Recheck retention before revealing even a previously cached citation.
  const confirmed = !query.isFetching && !query.isError && current?.data.runId === snapshotId;
  const result = pinned ? (confirmed ? current : undefined) : live;
  const publicationFailure = usePublicationFailure(result?.updatedAt ?? 0);
  const failure = query.isError && result ? { updatedAt: result.updatedAt, retry: query.refetch } : publicationFailure;
  // Horizon choices live here, keyed by account and decision, so they outlive the panels that use them.
  const [horizons, setHorizons] = useState<HorizonChoices>({});
  const shown = result?.scope ?? scope;
  const data = result?.data;
  const ledgerRows = useMemo<ScopedDecision[]>(
    () => !data || shown === "C" ? [] : shown === "all" ? allDecisions(data.decisionReviews) : scopedDecisions(shown, data.selectedAccountDecisions),
    [data, shown],
  );
  const rows = useMemo(() => ledgerRows.filter(row => !row.unpriced), [ledgerRows]);
  const {ready, consented, pending: readinessPending} = useAssistant();
  const ordinal = params.get("reviewOrdinal");
  // A cited decision can disambiguate two listings with the same ticker on one day.
  const focus = shown === "all" || shown === "C" ? undefined : ordinal && /^\d{1,4}$/.test(ordinal) && reference
    ? ledgerRows.filter(row => sameDecision(row,reference))[Number(ordinal)] : linkedDecision(ready || snapshotId ? ledgerRows : rows,reference);
  const missingDecision = pinned && (!canRead || (decisionParamValue !== null && !!result && !focus));
  const { horizon: localHorizon, choose, release } = useDecisionHorizon(shown === "all" ? undefined : shown, focus, horizons, setHorizons);
  const requestedHorizon = parseReviewWindow(params.get("reviewWindow"));
  const horizon = requestedHorizon ?? localHorizon;
  const rawHabit = params.get("habit");
  const habit = (ready || snapshotId) && shown === scope && isHabit(rawHabit) ? rawHabit : null;
  const habitRows = habit === "basket_buy" ? ledgerRows : rows;
  const filtered = useMemo(() => habitDecisions(habitRows,habit),[habitRows,habit]);
  const falls = useMemo(() => fallObservations(data?.reviewEvidence,shown === "all" ? ["A","B"] : shown === "C" ? [] : [shown]),[data,shown]);
  const [selection,setSelection] = useState<{row:ScopedDecision;location:"extremes"|"recent";trigger:HTMLElement} | null>(null);
  const selected = ready && selection && filtered.includes(selection.row) && shown === scope ? selection : null;
  const closeReading = () => {setSelection(null); selected?.trigger.focus({preventScroll:true});};
  const readingId = useId();
  const readingHorizon = selected?.location === "recent" ? "date" : horizon;
  const expansion: DecisionExpansion | undefined = ready && shown !== "C" && data ? {
    snapshot: data.runId, horizon, habit, selected:selected?.row ?? null,location:selected?.location ?? null,id:readingId,
    toggle:(row,location,trigger) => setSelection(selected?.row === row && selected.location === location ? null : {row,location,trigger}),
    reading:selected && <div id={readingId}><DecisionReading key={readingId + selected.location + horizonScope(selected.row.account, selected.row) + readingHorizon + data.runId}
      snapshot={data.runId} scope={shown} row={selected.row} horizon={readingHorizon} habit={habit} onClose={closeReading}/></div>,
  } : undefined;
  const filterButton = useRef<HTMLButtonElement>(null);
  const focusFilter = useRef<Habit | null>(null);
  const attachFilter = useCallback((button: HTMLButtonElement | null) => {
    filterButton.current = button;
    if (button && habit && focusFilter.current === habit) {
      focusFilter.current = null;
      focusHabitFilter(button);
    }
  }, [habit]);
  const focusAfterClear = useRef(false);
  const filterChip = habit ? <button ref={attachFilter} type="button" className="mx-review-filter" onClick={() => {focusAfterClear.current = true; setSelection(null);update({habit:null, snapshotId: null});}}>
    {t("只看","Only")} · {t(habitLabels[habit][0],habitLabels[habit][1])} <span aria-hidden="true">×</span><span className="sr-only">{t("清除筛选","Clear filter")}</span></button> : undefined;
  const reviews = shown === "all"
    ? (["A", "B"] as const).map((code) => data?.decisionReviews?.[code])
    : shown === "C" ? [] : [data?.selectedAccountDecisions];
  const available = reviews.some((review) => review?.status === "available");
  // A cold citation can lose its heading while the live dashboard is loading.
  const unfilteredTimelineVisible = available && !habit;
  useEffect(() => {
    if (!unfilteredTimelineVisible || !focusAfterClear.current) return;
    const heading = document.querySelector<HTMLElement>(".mx-decision-review h2");
    if (heading) {
      heading.tabIndex = -1;
      if (document.activeElement === document.body) heading.focus();
      focusAfterClear.current = false;
    }
  }, [unfilteredTimelineVisible]);
  const scopeLabel = accountName(profile, scope);
  const days = reviews.find((review) => review?.horizonDays)?.horizonDays ?? 20;
  const asOf = !data ? undefined : shown === "all"
    ? data.reviewAsOf ?? data.brokerAsOf
    : data.reviewAsOf ?? (str(field(object(object(shown === "C" ? data.selectedCfdReview : data.selectedAccountReview).coverage), "end_date")) || data.brokerAsOf);
  return (
    <Page
      className="mx-review-page"
      title={t("投资复盘", "Investment review")}
      nav={<ScopeSwitch value={scope} onChange={(value) => update({ account: value === "all" ? null : value, decision: null, reviewOrdinal: null, snapshotId: null, habit:null, reviewWindow:null })} />}
      actions={
        <span className="mx-freshness-group">
          {available && (
            <HorizonSwitch
              horizon={horizon}
              days={days}
              onChange={(value) => {
                if (value === horizon) return;
                // A decision's window lives in its address, so a reload, a shared link and Back show the
                // same figures; its kept horizon stays for the entry that has none.
                if (focus) {
                  update({ reviewWindow: toolHorizon(value) });
                  return;
                }
                choose(value);
                if (requestedHorizon) update({ reviewWindow: toolHorizon(value) });
              }}
            />
          )}
          {result && <Freshness date={asOf} />}
          {failure && <UpdateFailure {...failure} />}
        </span>
      }
    >
      {missingDecision ? (
        <Empty title={t("引用的交易决定暂不可用", "Cited decision unavailable")} />
      ) : !result && (query.isPending || query.isFetching) ? (
        <Pending key={scope} shape="review" label={reviewLoadingLabel(scope, scopeLabel, t)} />
      ) : !result || !data ? (
        pinned ? (
          <Empty title={t("引用的数据版本暂不可用", "Cited publication unavailable")} />
        ) : (
          <QueryError error={query.error} retry={query.refetch} />
        )
      ) : (
        <div className="mx-data-body mx-review-body">
          {shown === "C" ? (
            <AccountAnalysis key="C" data={data} code="C" />
          ) : (
            <>
              <ReviewLead
                rows={rows}
                horizon={horizon}
                trips={shown === "all" ? combinedRoundTrips(reviews) : roundTripVerdict(data.selectedAccountDecisions?.roundTripSummary)}
              >
                {shown === "all" ? (
                  <ReviewAccounts
                    horizon={horizon}
                    onOpen={(code) => update({ account: code, decision: null, reviewOrdinal: null, snapshotId: null, reviewWindow: null })}
                    accounts={(["A", "B"] as const).map((code) => ({
                      code,
                      rows: rows.filter((row) => row.account === code),
                      review: data.decisionReviews?.[code],
                      twr: data.risk?.[code]?.twr,
                    }))}
                  />
                ) : (
                  <AccountMoney data={data} />
                )}
              </ReviewLead>
              {available ? (
                <>
                  {ready ? (
                    <Suspense fallback={<HabitsSpace />}>
                      <ReviewHabits key={shown + data.runId} snapshot={data.runId} scope={shown}
                        horizon={horizon} habit={habit} active={!selected} onSelect={(value, options) => {
                          setSelection(null);
                          if (options.focusFilter) {
                            if (value === habit) requestAnimationFrame(() => focusHabitFilter(filterButton.current));
                            else focusFilter.current = value;
                          }
                          update({
                            habit: value, decision: null, reviewOrdinal: null,
                            ...(options.citation ? { evidence: "review_patterns", reviewWindow: toolHorizon(horizon), snapshotId: data.runId } : {}),
                          });
                        }} />
                    </Suspense>
                  ) : readinessPending ? ((data.reviewHabitsConsented || consented) && <HabitsSpace />) : consented ? <HabitsSpace unavailable /> : null}
                  {habit === "untraded_fall" ? <FallTimeline moves={falls} horizon={horizon} action={filterChip}/> : <DecisionTimelinePanel
                    action={filterChip}
                    rows={filtered}
                    days={days}
                    horizon={horizon}
                    focus={focus && ((!habit && focus.unpriced) || filtered.includes(focus as ScopedDecision)) ? focus : undefined}
                    onClear={() => {
                      release(horizon);
                      update({ decision: null, reviewOrdinal: null, snapshotId: null, reviewWindow: null });
                    }}
                    onPick={(row) => update(decisionSelectionParams(row as ScopedDecision, horizon))}
                    accountOf={shown === "all" ? (row) => accountName(profile, (row as ScopedDecision).account) : undefined}
                    unpriced={[...new Set(reviews.flatMap((review) => review?.coverage?.unpricedTickers ?? []))]}
                  />}
                  {habit !== "untraded_fall" && (
                    <DecisionExtremes
                      expansion={expansion}
                      rows={filtered}
                      horizon={horizon}
                      showAccount={shown === "all"}
                    />
                  )}
                </>
              ) : (
                <Panel>
                  <Empty
                    title={t("还没有买卖决定的复盘", "No decision review yet")}
                    description={t(
                      "完成一次完整更新后，这里会逐笔对照每次买入和卖出之后的价格。",
                      "After a full update, each buy and sell is compared with the price that followed.",
                    )}
                  />
                </Panel>
              )}
              <RecentJournal
                expansion={expansion}
                filter={habit === "untraded_fall" ? "falls" : habit ? "trades" : null}
                decisions={filtered}
                evidence={data.reviewEvidence}
                accounts={shown === "all" ? ["A", "B"] : [shown]}
                showAccount={shown === "all"}
              />
              {shown !== "all" && <AccountAnalysis key={shown} data={data} code={shown} />}
            </>
          )}
        </div>
      )}
    </Page>
  );
}

/** An account's money beside its decisions: where it ended, what it made, its worst run and its deposits. */
function AccountMoney({ data }: { data: DashboardLens }) {
  const t = useCopy();
  const review = object(data.selectedAccountReview);
  const money = object(review.moneyOutcome);
  const unavailable = Object.keys(review).length === 0;
  const pnl = money.net_pnl_gbp;
  const rows: Array<[string, string, string | undefined]> = unavailable
    ? [[t("券商快照市值", "Broker snapshot value"), currency(data.selectedAccount?.totalValueGbp, "GBP", 2), undefined]]
    : [
      [t("期末价值", "Ending value"), currency(money.ending_value_gbp, "GBP", 2), undefined],
      [t("历史净盈亏", "Historical net P&L"), currency(pnl, "GBP", 2), tone(pnl) ?? undefined],
      [t("最大盈亏回撤", "Max P&L drawdown"), currency(money.max_pnl_drawdown_gbp), "down"],
      [t("净入金", "Net deposits"), currency(money.net_external_flows_gbp), undefined],
    ];
  return (
    <>
      <dl className="mx-review-money">
        {rows.map(([label, value, tone]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={tone ? "mx-" + tone : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      {!unavailable && <Availability data={money} />}
    </>
  );
}

function ReviewPrerequisites({ cfd, onImports }: { cfd: boolean; onImports: () => void }) {
  const t = useCopy();
  return <Panel title={t("开始复盘所需的记录", "History needed for review")}>
    <ul className="mx-review-prerequisites">
      <li>{cfd
        ? t("CFD 已平仓交易及费用：导出券商的详细历史 CSV。", "Closed CFD trades and fees: export the broker’s detailed history CSV.")
        : t("成交历史：在设置中连接账户，授予只读交易历史权限。", "Fills: connect the account in Settings with read-only history access.")}</li>
      <li>{cfd
        ? t("入金、出金与转账：导出同一区间的资金流水 CSV。导入后更新 CFD 复盘。", "Deposits, withdrawals and transfers: export the cash history CSV for the same dates. Update CFD review after importing.")
        : t("入金、出金与估值历史：运行一次账户与流水更新。", "Deposits, withdrawals and valuation history: run an Accounts & history update.")}</li>
    </ul>
    {cfd ? <button type="button" className="mx-index-retry" onClick={onImports}>{t("导入 CFD 历史", "Import CFD history")}</button>
      : <Link className="mx-text-link" href="/settings?tab=accounts">{t("设置账户连接", "Set up account connections")}</Link>}
  </Panel>;
}

/**
 * One account's own analysis: what its results came from, how its trades and behaviour held up,
 * its phases and the risk it ended with. CFD history, which has no decisions, leads with its money.
 */
function AccountAnalysis({ data, code }: { data: DashboardLens; code: AccountCode }) {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const cfd = code === "C";
  const views = [
    { value: "outcome", label: t("投资结果", "Outcomes") },
    { value: "attribution", label: t("盈亏归因", "Attribution") },
    { value: "quality", label: t("交易质量", "Trade quality") },
    { value: "behavior", label: t("行为分析", "Behaviour") },
    { value: "strategy", label: t("策略风险", "Strategy risk") },
    { value: "phases", label: t("阶段与事件", "Phases & events") },
    { value: "risk", label: t("期末风险", "Ending risk") },
    ...(cfd ? [{ value: "imports", label: t("导入记录", "Import records") }] : []),
  ];
  // The angle lives in the address, so a refresh, Back or a copied link opens the same one.
  const tab = views.find((view) => view.value === params.get("reviewView"))?.value ?? "outcome";
  const [focusPhase, setFocusPhase] = useState("");
  const evidence = useRef<HTMLElement>(null);
  // A highlight opens its evidence once the address has switched the angle and the evidence is drawn.
  const pendingEvidence = useRef<{ view: string; phase: string } | null>(null);
  const [evidenceRequest, setEvidenceRequest] = useState(0);
  const openEvidence = (view: string, phaseId = "") => {
    setFocusPhase(phaseId);
    pendingEvidence.current = { view, phase: phaseId };
    setEvidenceRequest((count) => count + 1);
    update({ reviewView: view });
  };
  useEffect(() => {
    const pending = pendingEvidence.current;
    if (!pending || pending.view !== tab) return;
    pendingEvidence.current = null;
    const target =
      (pending.phase ? document.getElementById(`review-phase-${pending.phase}`) : null) ??
      evidence.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [tab, evidenceRequest]);
  const review = object(cfd ? data.selectedCfdReview : data.selectedAccountReview);
  const money = object(review.moneyOutcome);
  const scope: Scope = code === "A" ? "invest" : code === "B" ? "isa" : "cfd";
  const nav = observedNav(data.nav ?? [], scope, "NetPnlGbp");
  const unavailable = Object.keys(review).length === 0;
  const caveat = t("已实现现金权益", "Realised cash equity");
  const decisions = data.selectedAccountDecisions;
  return (
    <>
      {cfd && (
        <section className="mx-panel mx-review-lead" aria-label={t("复盘结论", "Review summary")}>
          <div className="mx-metric-grid mx-metric-lead">
            <Metric
              label={
                // The caveat sits beside the figure it qualifies, not in a banner above the page.
                <>
                  {t("期末价值", "Ending value")}
                  <Help label={caveat} tag={<Tag>{caveat}</Tag>}>
                    {t(
                      "导入的 CFD 历史只能还原已实现的现金权益：不含当前未平仓市值，也不等于券商账户价值。",
                      "Imported CFD history only rebuilds realised cash equity: it excludes open positions and is not the broker account value.",
                    )}
                  </Help>
                </>
              }
              value={currency(money.endingRealisedCashEquityProxyGbp, "GBP", 2)}
            />
            <Metric label={t("历史净盈亏", "Historical net P&L")} value={currency(money.netRealisedPnlGbp, "GBP", 2)} tone={tone(money.netRealisedPnlGbp)} />
            <Metric label={t("最大盈亏回撤", "Max P&L drawdown")} value={currency(money.maxRealisedPnlDrawdownGbp)} tone="down" />
            <Metric label={t("净入金", "Net deposits")} value={currency(money.accountCashFlowGbp)} />
          </div>
          {!unavailable && <Availability data={money} />}
        </section>
      )}
      {!unavailable && <ReviewHighlights review={review} cfd={cfd} onEvidence={openEvidence} />}
      <section
        ref={evidence}
        tabIndex={-1}
        className="mx-review-evidence"
        aria-label={t("账户分析", "Account analysis")}
      >
        <Tabs
          value={tab}
          onChange={(view) => update({ reviewView: view })}
          label={t("复盘角度", "Review perspective")}
          options={views}
        />
        {unavailable && tab !== "imports" ? (
          <ReviewPrerequisites cfd={cfd} onImports={() => update({ reviewView: "imports" })} />
        ) : tab === "imports" && cfd ? (
          <CfdImports />
        ) : tab === "outcome" ? (
          <>
            <Panel
              title={t("盈亏的时间线", "The P&L timeline")}
              help={t(
                "展示真实资金结果，不把入金误算成收益。",
                "A record of financial outcomes, with deposits kept separate from returns.",
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
                    [t("期初价值", "Opening value"), currency(money.opening_value_gbp ?? money.openingRealisedCashEquityProxyGbp)],
                    [t("入金", "Deposits"), currency(money.deposits_gbp ?? money.depositsGbp)],
                    [t("出金", "Withdrawals"), currency(money.withdrawals_gbp ?? money.withdrawalsGbp)],
                    [t("期末价值", "Ending value"), currency(money.ending_value_gbp ?? money.endingRealisedCashEquityProxyGbp)],
                    [t("净盈亏率", "Net P&L rate"), percent(money.net_pnl_rate, true)],
                  ]}
                />
                <Coverage data={object(review.coverage)} />
              </div>
            </Panel>
          </>
        ) : tab === "attribution" ? (
          <Attribution data={object(review.attribution)} cfd={cfd} />
        ) : tab === "quality" ? (
          <>
            {!cfd && decisions?.status === "available" && (
              <>
                <BestCloses rows={(decisions.closedTrades ?? []).filter((row) => (row.givenBackGbp ?? 0) > 0)} />
                <RoundTrips data={decisions} />
              </>
            )}
            <TradeQuality
              data={object(cfd ? review.tradeQuality : review.realisedTradeQuality)}
              legacy={object(data.selectedAccountAnalysis)}
              cfd={cfd}
            />
          </>
        ) : tab === "behavior" ? (
          <BehaviorEvidence data={object(review.structuralDiagnostics)} cfd={cfd} />
        ) : tab === "strategy" ? (
          <>
            <StrategyEvidence data={object(review.strategyRisk)} />
            {!cfd && <PerformanceContent data={data} fixedScope={scope} />}
          </>
        ) : tab === "phases" ? (
          <Phases key={focusPhase} data={object(review.phases)} focusPhase={focusPhase} />
        ) : (
          <EndingRisk data={object(review.endingRisk)} dashboard={data} cfd={cfd} />
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
      title: t("已实现盈利贡献", "Leading realised gain"),
      label: summary.contributor?.label ?? (summary.hasInstruments ? t("未见正贡献", "No positive contribution") : missing),
      value: summary.contributor?.value,
      partial: summary.attributionPartial,
      target: "attribution",
      available: summary.hasInstruments,
    },
    {
      title: t("已实现亏损拖累", "Leading realised loss"),
      label: summary.detractor?.label ?? (summary.hasInstruments ? t("未见负贡献", "No negative contribution") : missing),
      value: summary.detractor?.value,
      partial: summary.attributionPartial,
      target: "attribution",
      available: summary.hasInstruments,
    },
    {
      title: cfd ? t("已实现盈亏变动最大阶段", "Largest realised P&L phase") : t("盈亏变动最大阶段", "Largest P&L phase"),
      label: summary.phase ? formatDateSpan(summary.phase.start, summary.phase.end, locale) : missing,
      value: summary.phase?.value,
      partial: summary.phasesPartial,
      target: "phases",
      available: summary.phase != null,
    },
  ];
  return (
    <section className="mx-panel mx-review-highlights-panel" aria-label={t("账户要点", "Account highlights")}>
      <div className="mx-review-highlights">
        {cards.map((card) => {
          // The title, subject and amount stack on wider screens. On a phone the subject, amount and
          // arrow follow the title on its line, or move under it together when they do not fit.
          const body = (
            <>
              <span className="mx-highlight-title">{card.title}</span>
              <span className="mx-highlight-figure">
                <strong className="mx-highlight-subject">{card.label}</strong>
                <span className={"mx-highlight-value mx-" + (tone(card.value) ?? "neutral")}>
                  {currency(card.value, "GBP", 2)}
                </span>
                {card.available && <ArrowRight className="mx-highlight-go" size={14} aria-hidden="true" />}
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
    </section>
  );
}

export type { DecisionAccount, ReviewScope };

