"use client";

/*
 * Direction contract — 首页「账本在下」(owner-pinned 合并账本 with a pie; seed 34de5601), comp-led.
 * THESIS: the morning read in three bands: what the money did, how far the chosen market's sectors went today, and every
 *   holding with its research on one row. No separate allocation, account or research boxes.
 * OWN-WORLD: the Quiet Ledger, unchanged: white hairline panels on the cool canvas, ink figures, cobalt only
 *   for links and selection, green and red only for gains and losses, sector heat washes.
 * STORY: read the value → the period curve, today's movers under the 1D figure → which sectors moved → each holding's weight, day,
 *   P&L, score and model upside, flags marked in place → open research or a sector.
 * FIRST VIEWPORT: the summary across the top; 区间净盈亏 (about 62%) beside the sector map, US by default (about 38%);
 *   the 持仓 panel below: donut left, ledger right.
 * FORM: 账本在下, the owner's pick among three pie variants of the dealt 合并账本 (index 1, seed 34de5601);
 *   approved comp .impeccable/mocks/decision/overview-r2-ledgerpie.png.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict,
 *   DESIGN.md, and every shipping raster carrying its provenance.
 */

import { ChartLine } from "lucide-react";
import Link from "./link";
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBrowserOnline } from "@/ui/query-client";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { DashboardLens, RefreshAttention } from "@/lib/types";
import { TimelineChart, timelinePlotHeight } from "./timeline-chart";
import { readingTone, signedPercent, signedPounds } from "./reading-format";
import { api, currency, percent, tone } from "@/workspace/data";
import { useLocale } from "@/components/locale-provider";
import { attentionItems, type AttentionItem } from "./attention";
import { type Range, type Scope } from "@/lib/portfolio/nav";
import {
  Empty,
  StatusMessage,
  Freshness,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  ReadStatus,
  TextLink,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import dynamic from "next/dynamic";
import { useAssistant, useAssistantPageContext } from "./assistant/context";
import { Narrative } from "./narrative";
import { HistoryCoverage, HistoryHelp, PeriodSpan, periodSpan } from "./history-coverage";
import { DayDrivers, dayDrivers, driverOpenings } from "./day-drivers";
import { portfolioPerformanceHref, portfolioRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";
import { ReadingBoundary, useReadingBoundary } from "@/ui/charts/reading";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useCurrentDay } from "./current-day";
import { DemoAsOf, useDemonstration } from "./demonstration";
import {
  fetchLocalWorkspaceStatus,
  LOCAL_ONBOARDING_QUERY_KEY,
  LocalOnboarding,
} from "./local-onboarding";
import { OverviewHoldings } from "./overview-holdings";
import { hasOverviewAccountData, useOverviewLayout, useSaveOverviewLayout } from "./overview-layout";
import { overviewLedgerRows, overviewScopedHoldings } from "./overview-holdings-data";
import { OverviewSectors } from "./overview-sectors";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { useRetainedResult } from "./retained-result";
import { DashboardRanges, InlineRetry, WaitingAsOf, rangeName } from "./dashboard-controls";
import { SelectPicker } from "./picker";

const OverviewBrief = dynamic(() => import("./assistant/overview").then(module => module.OverviewBrief));

export function OverviewWorkspace({ localWorkspace = false }: { localWorkspace?: boolean }) {
  const t = useCopy();
  const { params } = useRouteState();
  const snapshotId = params.get("snapshotId");
  return (
    <Page className="mx-overview-page" title={t("组合总览", "Portfolio overview")} titleHidden>
      {params.get("evidence") === "portfolio_overview" ? (
        <CitedAccountBalances snapshotId={snapshotId} scope={params.get("scope") ?? "broker_total"} />
      ) : <OverviewContent localWorkspace={localWorkspace} />}
    </Page>
  );
}

function CitedAccountBalances({ snapshotId, scope }: { snapshotId: string | null; scope: string }) {
  const t = useCopy();
  const names: Record<string, string> = {
    invest: t("投资账户", "Invest"), isa: "ISA", cfd: "CFD", household: t("家庭账户", "Household"),
    broker_total: t("全部投资账户", "All investment accounts"),
  };
  const enabled = /^[A-Za-z0-9_-]{1,100}$/.test(snapshotId ?? "") && Object.hasOwn(names, scope);
  const query = useDashboardLens("overview", undefined, enabled, { detail: "summary", scope: scope === "broker_total" ? "total" : scope }, snapshotId ?? undefined);
  const balance = enabled && !query.isFetching && !query.isError && query.data?.runId === snapshotId && query.data.citedAccount?.scope === scope
    ? query.data.citedAccount : undefined;
  const title = t("引用的账户记录", "Cited account balances");
  useAssistantPageContext({ page: "overview", scope: balance?.scope, snapshotId: balance ? snapshotId ?? undefined : undefined });
  return <Panel title={balance ? title + " · " + names[scope] : title}
    action={balance?.asOf ? <Freshness date={balance.asOf} /> : undefined}>
    {enabled && query.isFetching ? <Pending shape="summary" quiet /> : !balance ? (
      <p role="status" data-cited-account="">{t("引用的快照已不可用", "Cited publication unavailable")}</p>
    ) : <div className="mx-metric-grid mx-metric-lead" data-cited-account="">
      <Metric large label={scope === "cfd" ? t("已实现现金权益", "Realised cash equity") : t("账户价值", "Account value")}
        value={currency(balance.totalValueGbp, "GBP", 2)} />
      {balance.cashGbp != null && <Metric label={t("现金", "Cash balance")} value={currency(balance.cashGbp, "GBP", 2)} />}
      {balance.investedGbp != null && <Metric label={t("已投资金额", "Invested value")} value={currency(balance.investedGbp, "GBP", 2)} />}
      {balance.realizedPnlGbp != null && <Metric label={t("已实现盈亏", "Realised P&L")} value={currency(balance.realizedPnlGbp, "GBP", 2)} tone={tone(balance.realizedPnlGbp)} />}
      {balance.unrealizedPnlGbp != null && <Metric label={t("浮动盈亏", "Unrealised P&L")} value={currency(balance.unrealizedPnlGbp, "GBP", 2)} tone={tone(balance.unrealizedPnlGbp)} />}
    </div>}
  </Panel>;
}

function OverviewContent({ localWorkspace }: { localWorkspace: boolean }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { ready: assistantReady, pending: assistantPending } = useAssistant();
  const { data: profile } = useWorkspaceProfile();
  // A late profile can rename options while the reader is switching accounts.
  const [accountWidthLabels] = useState(() => ({
    invest: accountName(profile, "A"),
    isa: accountName(profile, "B"),
  }));
  const { params, update } = useRouteState();
  const { now } = useCurrentDay();
  const query = useDashboardLens("overview", undefined, true, { detail: "summary" });
  const incoming = query.data;
  const reading = useReadingBoundary();
  const runtime = useChartRuntime();
  const demonstration = useDemonstration();
  const refresh = useQuery({
    queryKey: ["refresh-attention"],
    queryFn: ({ signal }) => api<RefreshAttention>("/refresh/attention", { signal }),
    enabled: !demonstration,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  const requestedScope: Scope =
    params.get("scope") === "invest"
      ? "invest"
      : params.get("scope") === "isa"
        ? "isa"
        : "total";
  const range = portfolioRange(params.get("range"), "1D");
  const selection = useMemo(() => ({ range, scope: requestedScope, runId: incoming?.runId ?? "" }), [range, requestedScope, incoming?.runId]);
  const openings = useMemo(() => driverOpenings(range === "1D" ? incoming?.dayAttribution : range === "1W" ? incoming?.windowAttribution : null, requestedScope),
    [range, requestedScope, incoming?.dayAttribution, incoming?.windowAttribution]);
  const history = usePortfolioHistory(selection, Boolean(incoming?.runId), openings);
  // Only publish matching figures, attributions and history together. An open chart reading
  // stays on its own run. An explicit range or account choice still proceeds.
  const candidate = useMemo(() => incoming && {
    lens: incoming, selection, history: history.data,
    updatedAt: Math.max(query.dataUpdatedAt, history.dataUpdatedAt),
    historyUpdatedAt: history.dataUpdatedAt,
  }, [incoming, selection, history.data, query.dataUpdatedAt, history.dataUpdatedAt]);
  const complete = candidate?.history && runtime.status !== "loading" ? candidate : undefined;
  const retained = useRetainedResult(complete, Object.is, (next, previous) =>
    !reading.active || next.selection.range !== previous.selection.range || next.selection.scope !== previous.selection.scope);
  const shown = retained?.selection.scope === requestedScope ? retained : undefined;
  const displayed = shown ?? candidate;
  const data = displayed?.lens;
  const localOnboarding = useQuery({
    queryKey: LOCAL_ONBOARDING_QUERY_KEY,
    queryFn: ({ signal }) => fetchLocalWorkspaceStatus(signal),
    enabled: localWorkspace && !data && query.isError,
    retry: 1,
  });
  const checkingOnboarding = localWorkspace && !data && query.isError && localOnboarding.isPending;
  const initialWaiting = !shown && (
    checkingOnboarding || !query.isError && (!incoming || history.isPending || runtime.status === "loading"));
  const initialError = !initialWaiting && !data && query.isError;
  const online = useBrowserOnline();
  const offline = !online || query.fetchStatus === "paused" || history.fetchStatus === "paused";
  const offlineLabel = t("网络已断开，数据将在重连后更新。", "You’re offline. Data will update when you reconnect.");
  const accountUnavailable = t("账户价值暂不可用", "Account value unavailable");
  const scope = displayed?.selection.scope ?? requestedScope;
  useAssistantPageContext({
    page: "overview",
    scope: scope === "total" ? "broker_total" : scope,
    range: displayed?.selection.range ?? range,
    snapshotId: displayed?.history?.runId ?? data?.runId,
  });
  const publicationFailure = usePublicationFailure(shown?.updatedAt ?? 0);
  const summaryFailure = query.isRefetchError
    ? { updatedAt: shown?.updatedAt ?? query.dataUpdatedAt, retry: query.refetch }
    : publicationFailure;
  const accountReadFailure = initialError ? accountUnavailable : summaryFailure
    ? t("账户价值更新失败", "Account value update failed") : undefined;
  const historyFailure = history.isError && shown
    ? { updatedAt: shown.historyUpdatedAt, retry: history.refetch } : undefined;
  const accounts = (data?.accounts ?? []).filter((a) => a.isInvestable);
  const selected = accounts.find(
    (a) => a.code === (scope === "invest" ? "A" : scope === "isa" ? "B" : ""),
  );
  const holdings = useMemo(
    () => overviewScopedHoldings(data, scope),
    [data, scope],
  );
  const counts = useMemo(() => holdings && overviewLedgerRows(holdings), [holdings]);
  const confirmedEmpty = query.isSuccess && !!incoming && !hasOverviewAccountData(incoming);
  const overview = useRef<HTMLDivElement>(null);
  const { key: layoutKey, workspacePrefix, generation, layout, booting } = useOverviewLayout(requestedScope, locale, confirmedEmpty);
  useSaveOverviewLayout(overview, layoutKey, workspacePrefix, generation, !history.isError && runtime.status === "ready" ? displayed : undefined,
    !initialWaiting && !initialError && !confirmedEmpty && !!data, counts);
  const savedReading = layout?.reading;
  const savedRows = layout?.rows;
  const matchingRows = !counts || savedRows && counts.stocks === savedRows.stocks && counts.funds === savedRows.funds &&
    counts.dateTagged === savedRows.dateTagged;
  const reservedLayout = initialWaiting && !offline && savedReading?.range === range ? savedReading : undefined;
  const px = (value?: number) => value === undefined ? undefined : value + "px";
  const sectorsHeight = online ? layout?.sectors : undefined;
  const briefHeight = online ? layout?.brief : undefined;
  const briefWaiting = initialWaiting ? assistantReady || assistantPending : !!data && assistantPending;
  const pendingStyle = {
    "--mx-overview-summary-size": px(reservedLayout?.summary),
    "--mx-overview-history-size": px(reservedLayout?.history),
    "--mx-overview-plot-top": px(reservedLayout?.plotTop),
    "--mx-overview-sectors-size": px(sectorsHeight),
    "--mx-overview-brief-size": px(briefHeight),
    "--mx-overview-brief-display": briefHeight === undefined ? undefined : "block",
  } as CSSProperties;
  if (initialError && localWorkspace && localOnboarding.data && !localOnboarding.data.confirmed) {
    return <LocalOnboarding showAccountLink />;
  }
  if (data && !accounts.length && data.totalValueGbp == null)
    return (
      <Panel>
        <Empty
          title={t("暂无账户数据", "No account data")}
          description={t(
            "连接 Trading\u00a0212 账户，完成首次同步后即可查看资产和投资表现。",
            "Connect a Trading\u00a0212 account and sync once to see your investments here.",
          )}
          action={
            <Link href="/settings" data-slot="button" className={buttonVariants()}>
              {t("连接账户", "Connect an account")}
            </Link>
          }
        />
      </Panel>
    );
  const pnl =
    scope === "total" ? data?.totalUnrealizedPnlGbp : selected?.unrealizedPnlGbp;
  const cash = scope === "total" ? data?.totalCashGbp : selected?.cashGbp;
  const value =
    scope === "total" ? data?.totalValueGbp : selected?.totalValueGbp;
  // Data problems speak here; a holding's readings are marked in its own row below.
  const attention = demonstration ? [] : attentionItems({ brokerAsOf: data?.brokerAsOf, refresh: refresh.data, now });
  return (
    <ReadingBoundary.Provider value={reading.report}><div ref={overview} className="mx-overview-read" style={pendingStyle}
      data-summary-reserved={!!reservedLayout || undefined}
      data-sectors-reserved={sectorsHeight !== undefined || undefined}
      data-layout-bootstrap={booting && initialWaiting || undefined}>
      <StatusMessage message={offline ? offlineLabel : undefined} />
      <div className="mx-panel mx-overview-portfolio" data-waiting={initialWaiting || undefined}>
        <ReadStatus failure={accountReadFailure} ready={!initialWaiting && query.isSuccess && !!data}
          recovered={t("账户价值已恢复。", "Account value is available again.")} />
        <section
          className="mx-summary"
          aria-label={t("账户价值", "Account value")}
        >
          <div className="mx-summary-top">
            <SelectPicker
              aria-label={t("组合账户", "Portfolio account")}
              intrinsic
              widthLabels={accountWidthLabels}
              options={[
                {
                  value: "total",
                  label: t("全部投资账户", "All investment accounts"),
                },
                { value: "invest", label: accountName(profile, "A") },
                { value: "isa", label: accountName(profile, "B") },
              ]}
              value={requestedScope}
              onChange={(v) => update({ scope: v === "total" ? null : v })}
            />
            {(!initialError || summaryFailure) && (
              <span className="mx-freshness-group">
                {initialWaiting ? offline ? <span className="mx-waiting-as-of">{offlineLabel}</span>
                    : <WaitingAsOf label={t("正在读取账户价值…", "Loading account value…")} />
                  : initialError ? null
                    : demonstration ? <DemoAsOf date={data?.brokerAsOf} /> : <Freshness date={data?.brokerAsOf} />}
                {summaryFailure && <UpdateFailure {...summaryFailure} />}
                {offline && !initialWaiting && <span className="mx-waiting-as-of">{offlineLabel}</span>}
              </span>
            )}
          </div>
          {initialError ? (
            <div className="mx-overview-summary-failure">
              <InlineRetry label={accountUnavailable} retry={query.refetch} />
              <TextLink href="/health">{t("查看数据状态", "Data status")}</TextLink>
            </div>
          ) : <>
          <OverviewLead
            retained={history.isError && displayed?.selection.range !== range}
            selection={displayed?.selection ?? selection}
            data={initialWaiting ? undefined : displayed?.history}
            failed={history.isError}
            dayAttribution={data?.dayAttribution}
            windowAttribution={data?.windowAttribution}
          />
          {!initialWaiting ? <div className="mx-overview-totals">
            <Metric
              large
              label={t("账户价值", "Account value")}
              value={currency(value, "GBP", 2)}
            />
            <div className="mx-overview-statistics">
              <Metric
                label={t("浮动盈亏", "Unrealised P&L")}
                value={currency(pnl, "GBP", 2)}
                tone={tone(pnl)}
                help={t("当前持仓相对买入成本", "Holdings versus cost")}
              />
              <Metric
                label={t("现金", "Cash balance")}
                value={currency(cash, "GBP", 2)}
              />
            </div>
          </div> : <Pending shape="summary" quiet />}
          <Attention items={attention} />
          {!attention.length && initialWaiting && !reservedLayout && <div className="mx-overview-attention-placeholder" aria-hidden="true" />}
          </>}
        </section>
        {!initialWaiting && data && scope !== "total" && !selected && (
          <div className="mx-overview-notice">
            <Notice>
              {t(
                "这份快照还没有该账户的数据。请检查账户连接并完成更新。",
                "This snapshot has no data for this account. Check its connection and run an update.",
              )}
            </Notice>
          </div>
        )}
      </div>
      <div className="mx-overview-row">
        <OverviewHistory
          range={range}
          selection={displayed?.selection ?? selection}
          data={displayed?.history}
          failed={history.isError || initialError}
          retry={initialError ? query.refetch : history.refetch}
          failure={historyFailure}
          waiting={Boolean(shown && shown !== complete && !reading.active)}
          initialWaiting={initialWaiting}
          reservation={reservedLayout ? reservedLayout.plotTop === undefined ? "empty" : "plot" : undefined}
          offline={offline}
          runtime={runtime}
          onRange={(value) => update({ range: value })}
          dayAttribution={data?.dayAttribution}
          windowAttribution={data?.windowAttribution}
        />
        <OverviewSectors online={online} />
      </div>
      <OverviewHoldings holdings={holdings} technical={data?.technical} valuations={data?.valuations}
        runId={!initialWaiting && data?.runId === incoming?.runId && scope === requestedScope ? data?.runId : undefined}
        brokerAsOf={data?.brokerAsOf} account={requestedScope}
        pendingRows={counts ?? savedRows}
        pendingHeight={matchingRows ? layout?.ledger : undefined}
        waiting={initialWaiting} failed={initialError} error={query.error} retry={query.refetch} />
      {!initialWaiting && data && <Narrative snapshot={data.runId} lens="daily_cio_brief" page="overview" />}
      {!initialWaiting && data && assistantReady
        ? <div className="mx-overview-brief"><OverviewBrief snapshot={data.runId} scope={scope} /></div>
        : briefWaiting &&
          <div className="mx-overview-brief" aria-hidden="true">
            <Skeleton className="mx-loading-shape" />
          </div>}
    </div></ReadingBoundary.Provider>
  );
}
function Attention({ items }: { items: AttentionItem[] }) {
  const t = useCopy();
  const { locale } = useLocale();
  const zh = locale === "zh";
  if (!items.length) return null;
  const age = (hours: number) => {
    const days = Math.floor(hours / 24);
    if (days >= 2) return zh ? `账户数据 ${days} 天未更新` : `No account update for ${days} days`;
    return zh ? `账户数据 ${hours} 小时未更新` : `No account update for ${hours} ${hours === 1 ? "hour" : "hours"}`;
  };
  return (
    <nav className="mx-attention" aria-label={t("需要关注", "Needs attention")}>
      {items.map((item) =>
        item.kind === "refresh" ? (
          <Link key="refresh" href="/health" data-tone="warning">
            <strong>{item.scope === "accounts"
              ? t("账户更新连续失败", "Account updates failing")
              : t("收益更新连续失败", "Performance updates failing")}</strong>
            <span>{item.minutes >= 60
              ? Math.floor(item.minutes / 60) + t(" 小时", "h")
              : item.minutes > 0 ? item.minutes + t(" 分钟", "m")
                : item.failures + (item.failures === 1 ? t(" 次", " attempt") : t(" 次", " attempts"))}</span>
          </Link>
        ) : (
          <Link key="stale" href="/health" data-tone="warning">
            {age(item.hours)}
          </Link>
        ),
      )}
    </nav>
  );
}
/** The calendar day it is now where the reader is, as YYYY-MM-DD. */
function localDay(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
/**
 * Phones lead with the period move and the two positions that drove it most; the total and balances follow. Wider
 * windows keep the move in the period panel, so the stylesheet shows this block only below 768px. It reads the
 * same history as the panel, so both always show one figure.
 */
function OverviewLead({ selection, data, failed, retained, dayAttribution, windowAttribution }: {
  selection: Parameters<typeof usePortfolioHistory>[0];
  data?: ReturnType<typeof usePortfolioHistory>["data"];
  failed: boolean;
  retained: boolean;
  dayAttribution?: DashboardLens["dayAttribution"];
  windowAttribution?: DashboardLens["windowAttribution"];
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { range, scope } = selection;
  if (!data) {
    return failed ? null : (
      <div className="mx-overview-lead mx-overview-lead-pending" aria-hidden="true">
        <Skeleton className="mx-loading-shape" />
      </div>
    );
  }
  const { history, money } = data;
  const { points } = history;
  const attribution = range === "1D" ? dayAttribution : range === "1W" ? windowAttribution : undefined;
  const drivers = attribution ? dayDrivers({
    attribution,
    scope,
    day: history.endDay,
    dates: points.map((point) => point.date),
    pnls: money.pnls,
    openings: data.openings,
    cutOff: history.pendingCashFlows,
    limit: 2,
  }) : null;
  // Today's move says so; an earlier session names its day, so a closed market never reads as today.
  const label = range !== "1D" ? rangeName(range, t("全部", "All"))
    : history.endDay === localDay(timeZone) ? t("今日", "Today")
      : periodSpan(points.length ? points : history.endDay ? [{ date: history.endDay }] : [], locale, timeZone) || t("今日", "Today");
  return (
    <div className="mx-overview-lead">
      <div className="mx-overview-lead-head">
        <span className="mx-overview-lead-label">{retained
          ? (range === "1D" ? label + " · " : "") + t("当前显示 ", "Showing ") + rangeName(range, t("全部", "All"))
          : label}</span>
        <TextLink href={portfolioPerformanceHref(scope, range)}>
          <ChartLine aria-hidden="true" size={16} />
          {t("收益分析", "View performance")}
        </TextLink>
      </div>
      <div className="mx-overview-lead-figure">
        <strong className={money.pnl == null ? undefined : "mx-" + tone(money.pnl)}>
          {currency(money.pnl, "GBP", 2)}
        </strong>
        {money.pnl != null && (
          <span
            className={"mx-" + tone(money.pnl)}
          >
            {percent(money.pnlPercents.at(-1), true, 2)}
          </span>
        )}
      </div>
      {drivers && <DayDrivers span={range === "1W" ? "5D" : "1D"} drivers={drivers} />}
    </div>
  );
}
function OverviewHistory({
  range: requestedRange, selection, data, failed, retry, failure, waiting, initialWaiting, reservation, offline, runtime, onRange,
  dayAttribution, windowAttribution,
}: {
  range: Range;
  selection: Parameters<typeof usePortfolioHistory>[0];
  data?: ReturnType<typeof usePortfolioHistory>["data"];
  failed: boolean;
  retry: () => unknown;
  failure?: { updatedAt: number; retry: () => unknown };
  waiting: boolean;
  initialWaiting: boolean;
  reservation?: "empty" | "plot";
  offline: boolean;
  runtime: ReturnType<typeof useChartRuntime>;
  onRange: (range: Range) => void;
  /** Today's moves by position, listed under the 1D figure. */
  dayAttribution?: DashboardLens["dayAttribution"];
  windowAttribution?: DashboardLens["windowAttribution"];
}) {
  const t = useCopy();
  const { range, scope } = selection;
  const plotHeight = 264;
  const pendingPlotHeight = timelinePlotHeight(plotHeight, requestedRange);
  const [figureAnchor, setFigureAnchor] = useState<HTMLDivElement | null>(null);
  const history = useMemo(() => data?.history ?? selectPortfolioHistory({ range, scope }), [data?.history, range, scope]);
  const { points } = history;
  const isIntraday = history.source === "intraday";
  const money = useMemo(() => data?.money ?? portfolioMoney([], scope), [data?.money, scope]);
  // The 1D figure is today's: the positions behind it follow, as the five-day window's do.
  const attribution = range === "1D" ? dayAttribution : range === "1W" ? windowAttribution : undefined;
  const dates = useMemo(() => points.map((point) => point.date), [points]);
  const layers = useMemo(() => {
    const label = t("净盈亏", "Net P&L");
    return [{ label, lines: [{ name: label, values: money.pnls, area: true }], zeroBaseline: true }];
  }, [money.pnls, t]);
  const readNetPnl = useCallback((row: number) => ({
    primary: {
      value: signedPounds(money.pnls[row]),
      tone: readingTone(money.pnls[row]),
      ...(money.pnlPercents[row] != null ? { detail: signedPercent(money.pnlPercents[row]) + t(" 相对期初", " vs opening") } : {}),
    },
  }), [money.pnlPercents, money.pnls, t]);
  const unavailable = t("盈亏记录暂不可用", "P&L history unavailable");
  const readFailure = !initialWaiting && (failed || runtime.status === "failed")
    ? data ? t("盈亏记录更新失败", "P&L history update failed") : unavailable : undefined;
  const drivers = attribution ? dayDrivers({
    attribution,
    scope,
    day: history.endDay,
    dates,
    pnls: money.pnls,
    openings: data?.openings,
    cutOff: history.pendingCashFlows,
  }) : null;
  return (
    <Panel
      className={"mx-overview-history" + (reservation ? " mx-overview-history-reserved" : "")}
      title={t("区间净盈亏", "Period net P&L")}
      help={<HistoryHelp />}
      helpAnchor={figureAnchor}
      action={
        <div className="mx-period-control">
          <PeriodSpan points={initialWaiting ? [] : points} reserve />
          {failure && <UpdateFailure {...failure} showRetry />}
          <DashboardRanges label={t("图表区间", "Chart range")} value={requestedRange} onChange={onRange} />
        </div>
      }
    >
      <ReadStatus failure={readFailure}
        ready={!initialWaiting && !!data && runtime.status === "ready" && !failed}
        recovered={t("盈亏记录已恢复。", "P&L history is available again.")} />
      {initialWaiting || !data && !failed ? (
        <div className="mx-overview-history-pending">
          <div className="mx-period-figure" aria-hidden="true">
            <Skeleton as="span" className="mx-period-figure-placeholder" />
          </div>
          {reservation !== "empty" && <Pending shape="chart" height={pendingPlotHeight} quiet={initialWaiting || offline} label={t("正在读取 ", "Loading ") +
            rangeName(requestedRange, t("全部", "all")) + t(" 盈亏记录…", " P&L history…")} />}
        </div>
      ) : runtime.status === "failed" ? (
        <QueryError retry={runtime.retry} />
      ) : !data ? (
        <div className="mx-overview-unavailable mx-overview-unavailable-history">
          <InlineRetry label={unavailable} retry={retry} />
        </div>
      ) : (
        <div className="mx-data-body" aria-busy={waiting && !failed || undefined}>
          {range !== requestedRange && <p className="mx-prior-range">
            {t("当前显示 ", "Showing ")}{rangeName(range, t("全部", "all"))}
          </p>}
          <div className="mx-period-figure" ref={setFigureAnchor}>
            <strong className={money.pnl == null ? undefined : "mx-" + tone(money.pnl)}>
              {currency(money.pnl, "GBP", 2)}
            </strong>
            {money.pnl != null && (
              <span>
                {percent(money.pnlPercents.at(-1), true, 2)}
              </span>
            )}
            <TextLink href={portfolioPerformanceHref(scope, range)}>
              <ChartLine aria-hidden="true" size={16} />
              {t("收益分析", "View performance")}
            </TextLink>
          </div>
          {drivers && <DayDrivers span={range === "1W" ? "5D" : "1D"} drivers={drivers} />}
          <HistoryCoverage history={history} />
          <TimelineChart
            dates={dates}
            layers={layers}
            label={t("区间净盈亏曲线", "Period net profit and loss over time")}
            intraday={isIntraday}
            range={range}
            timeline={history.timeline}
            observations={points}
            pendingCashFlows={history.pendingCashFlows}
            showHistoryEvidence={false}
            height={plotHeight}
            reading={readNetPnl}
          />
        </div>
      )}
    </Panel>
  );
}
