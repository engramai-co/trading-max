"use client";

/*
 * Direction contract — 首页「账本在下」(owner-pinned 合并账本 with a pie; seed 34de5601), comp-led.
 * THESIS: the morning read in three bands: what the money did, how far US sectors went today, and every
 *   holding with its research on one row. No separate allocation, account or research boxes.
 * OWN-WORLD: the Quiet Ledger, unchanged: white hairline panels on the cool canvas, ink figures, cobalt only
 *   for links and selection, green and red only for gains and losses, sector heat washes.
 * STORY: read the value and today → the period curve → which US sectors moved → each holding's weight, day,
 *   P&L, score and model upside, flags marked in place → open research or a sector.
 * FIRST VIEWPORT: the summary across the top; 区间净盈亏 (about 62%) beside the 美股板块 map (about 38%);
 *   the 持仓 panel below: donut left, ledger right.
 * FORM: 账本在下, the owner's pick among three pie variants of the dealt 合并账本 (index 1, seed 34de5601);
 *   approved comp .impeccable/mocks/decision/overview-r2-ledgerpie.png.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict,
 *   DESIGN.md, and every shipping raster carrying its provenance.
 */

import { Button, Select } from "@mantine/core";
import { ChartLine } from "@phosphor-icons/react";
import Link from "./link";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { DashboardLens, RefreshAttention } from "@/lib/types";
import { TimelineChart } from "./timeline-chart";
import { api, currency, percent, tone } from "@/workspace/data";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { attentionItems, type AttentionItem } from "./attention";
import { type Range, type Scope } from "@/lib/portfolio/nav";
import {
  Empty,
  Facts,
  Freshness,
  Metric,
  LoadingStatus,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  Segments,
  TextLink,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import { Narrative } from "./narrative";
import { CutoffTag, EstimateTag, HistoryCoverage, HistoryHelp, PeriodSpan } from "./history-coverage";
import { DayDrivers, dayDrivers, driverOpenings, signedPounds } from "./day-drivers";
import { PORTFOLIO_RANGES, portfolioPerformanceHref, preferredRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";
import { ReadingBoundary, useReadingBoundary } from "@/ui/charts/reading";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useCurrentDay } from "./current-day";
import { DemoAsOf, useDemonstration } from "./demonstration";
import { LocalOnboarding } from "./local-onboarding";
import { OverviewHoldings } from "./overview-holdings";
import { OverviewSectors, useOverviewSectors } from "./overview-sectors";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { useRetainedResult } from "./retained-result";

/** The overview chart reopens on the range last chosen on this device; a range in the URL wins. */
const RANGE_STORAGE_KEY = "trading_max-overview-range";
function subscribeToStorage(notify: () => void) {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
}
function storedRange() {
  try {
    return window.localStorage.getItem(RANGE_STORAGE_KEY);
  } catch {
    return null;
  }
}
function useRememberedRange() {
  const remembered = useSyncExternalStore(subscribeToStorage, storedRange, () => null);
  const remember = useCallback((range: Range) => {
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, range);
    } catch {
      // Private browsing without storage still switches the range for this view.
    }
  }, []);
  return [remembered, remember] as const;
}

export function OverviewWorkspace({ localWorkspace = false }: { localWorkspace?: boolean }) {
  const t = useCopy();
  return (
    <Page className="mx-overview-page" title={t("组合总览", "Portfolio overview")} titleHidden>
      <OverviewContent localWorkspace={localWorkspace} />
    </Page>
  );
}
function OverviewContent({ localWorkspace }: { localWorkspace: boolean }) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const { today, now } = useCurrentDay();
  const query = useDashboardLens("overview", undefined, true, { detail: "summary" });
  const incoming = query.data;
  const reading = useReadingBoundary();
  const sectors = useOverviewSectors();
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
  const [remembered, remember] = useRememberedRange();
  const range = preferredRange(params.get("range"), remembered);
  const selection = useMemo(() => ({ range, scope: requestedScope, runId: incoming?.runId ?? "" }), [range, requestedScope, incoming?.runId]);
  const todaySelection = useMemo(() => ({ ...selection, range: "1D" as const }), [selection]);
  const openings = useMemo(() => driverOpenings(range === "1D" ? incoming?.dayAttribution : range === "1W" ? incoming?.windowAttribution : null, requestedScope),
    [range, requestedScope, incoming?.dayAttribution, incoming?.windowAttribution]);
  const todayOpenings = useMemo(() => driverOpenings(incoming?.dayAttribution, requestedScope), [incoming?.dayAttribution, requestedScope]);
  const history = usePortfolioHistory(selection, Boolean(incoming?.runId), openings);
  const todayHistory = usePortfolioHistory(todaySelection, Boolean(incoming?.runId), todayOpenings);
  // Only publish matching figures, attributions and history together. An open chart reading
  // or exact record stays on its own run. An explicit range or account choice still proceeds.
  const candidate = useMemo(() => incoming && {
    lens: incoming, selection, history: history.data, today: todayHistory.data,
    updatedAt: Math.max(query.dataUpdatedAt, history.dataUpdatedAt, todayHistory.dataUpdatedAt),
  }, [incoming, selection, history.data, todayHistory.data, query.dataUpdatedAt, history.dataUpdatedAt, todayHistory.dataUpdatedAt]);
  const complete = candidate?.history && candidate.today && runtime.status !== "loading" ? candidate : undefined;
  const shown = useRetainedResult(complete, Object.is, (next, previous) =>
    !reading.active || next.selection.range !== previous.selection.range || next.selection.scope !== previous.selection.scope);
  const initialWaiting = !shown && !query.isError && (
    !incoming || history.isPending || todayHistory.isPending || runtime.status === "loading");
  const displayed = shown ?? candidate;
  const data = displayed?.lens;
  const scope = displayed?.selection.scope ?? requestedScope;
  const publicationFailure = usePublicationFailure(shown?.updatedAt ?? 0);
  const summaryFailure = query.isRefetchError
    ? { updatedAt: shown?.updatedAt ?? query.dataUpdatedAt, retry: query.refetch }
    : publicationFailure;
  const todayFailure = todayHistory.isError && shown
    ? { updatedAt: shown.updatedAt, retry: todayHistory.refetch } : undefined;
  const historyFailure = history.isError && shown
    ? { updatedAt: shown.updatedAt, retry: history.refetch } : undefined;
  const accounts = (data?.accounts ?? []).filter((a) => a.isInvestable);
  const selected = accounts.find(
    (a) => a.code === (scope === "invest" ? "A" : scope === "isa" ? "B" : ""),
  );
  const holdings = (data?.holdings ?? []).filter(
    (h) => scope === "total" || h.account === (scope === "invest" ? "A" : "B"),
  );
  if (!data && query.isError) return localWorkspace ? <LocalOnboarding showAccountLink /> : <QueryError retry={query.refetch} />;
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
            <Button component={Link} href="/settings">
              {t("连接账户", "Connect an account")}
            </Button>
          }
        />
      </Panel>
    );
  const pnl =
    scope === "total" ? data?.totalUnrealizedPnlGbp : selected?.unrealizedPnlGbp;
  const cash = scope === "total" ? data?.totalCashGbp : selected?.cashGbp;
  const value =
    scope === "total" ? data?.totalValueGbp : selected?.totalValueGbp;
  const previousDay =
    scope === "total" ? data?.latestModelDayReturn : selected?.dailyReturn;
  // Data problems speak here; a holding's readings are marked in its own row below.
  const attention = demonstration ? [] : attentionItems({ brokerAsOf: data?.brokerAsOf, refresh: refresh.data, now });
  return (
    <ReadingBoundary.Provider value={reading.report}><div className="mx-overview-read">
      {initialWaiting && <LoadingStatus label={t("正在读取组合总览…", "Loading your portfolio overview…")} />}
      <div className="mx-panel mx-overview-portfolio">
        <section
          className="mx-summary"
          aria-label={t("组合资产", "Portfolio assets")}
        >
          <div className="mx-summary-top">
            <Select
              aria-label={t("组合账户", "Portfolio account")}
              w={186}
              data={[
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
            <span className="mx-freshness-group">
              {demonstration ? <DemoAsOf date={data?.brokerAsOf} /> : <Freshness date={data?.brokerAsOf} />}
              {summaryFailure && <UpdateFailure {...summaryFailure} />}
            </span>
          </div>
          {initialWaiting ? <Pending shape="summary" quiet /> : <>
          <div className="mx-overview-totals">
            <Metric
              large
              label={t("总资产", "Portfolio value")}
              value={currency(value, "GBP", 2)}
            />
            <div className="mx-overview-statistics">
              <Metric
                label={t("浮动盈亏", "Unrealized P&L")}
                value={currency(pnl, "GBP", 2)}
                tone={tone(pnl)}
                help={t("当前持仓相对买入成本", "Open positions versus cost")}
              />
              <Metric
                label={t("现金", "Cash balance")}
                value={currency(cash, "GBP", 2)}
              />
              <TodayMetric
                scope={scope}
                data={displayed?.today}
                failed={todayHistory.isError}
                retry={todayHistory.refetch}
                failure={todayFailure}
                attribution={data?.dayAttribution}
                previousDay={previousDay}
                today={today}
                now={now}
              />
            </div>
          </div>
          <Attention items={attention} />
          </>}
        </section>
        {!initialWaiting && scope !== "total" && !selected && (
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
          failed={history.isError}
          retry={history.refetch}
          failure={historyFailure}
          waiting={Boolean(shown && shown !== complete && !reading.active)}
          initialWaiting={initialWaiting}
          runtime={runtime}
          onRange={(value) => {
            remember(value);
            update({ range: value });
          }}
          windowAttribution={data?.windowAttribution}
        />
        <OverviewSectors query={sectors} initialWaiting={initialWaiting} />
      </div>
      {initialWaiting ? <Panel className="mx-overview-holdings" title={t("持仓", "Holdings")}><Pending shape="holdings" quiet /></Panel>
        : <OverviewHoldings holdings={holdings} technical={data?.technical} valuations={data?.valuations}
          runId={data?.runId === incoming?.runId && scope === requestedScope ? data?.runId : undefined}
          brokerAsOf={data?.brokerAsOf} account={requestedScope} />}
      {!initialWaiting && data && <Narrative snapshot={data.runId} lens="daily_cio_brief" page="overview" />}
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
    return zh ? `账户数据 ${hours} 小时未更新` : `No account update for ${hours} hours`;
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
                : item.failures + t(" 次", " attempts")}</span>
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
/** What today did to the account, and the positions behind it; the 1D chart's own figure. */
function TodayMetric({
  scope,
  data,
  failed,
  retry,
  failure,
  attribution,
  previousDay,
  today,
  now,
}: {
  scope: Scope;
  data?: ReturnType<typeof usePortfolioHistory>["data"];
  failed: boolean;
  retry: () => unknown;
  failure?: { updatedAt: number; retry: () => unknown };
  attribution?: DashboardLens["dayAttribution"];
  previousDay?: number | null;
  /** Today's calendar day in the display time zone. */
  today: string;
  now: number;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const history = data?.history;
  const money = data?.money;
  const points = history?.points ?? [];
  const day = history?.endDay;
  const pnl = money?.pnl ?? null;
  const share = money?.pnlPercents.at(-1) ?? null;
  // On a weekend or before the day's first observation the window is an earlier
  // trading day: name it instead of calling it today.
  const label = !day || day === today
    ? t("今日", "Today")
    : formatCalendarDate(day, locale, now);
  // The drivers explain this figure only, so they wait while it stops at a cutoff.
  const drivers = attribution && money && history ? dayDrivers({
    attribution,
    scope,
    day,
    dates: points.map((p) => p.date),
    pnls: money.pnls,
    openings: data?.openings,
    cutOff: history.pendingCashFlows,
  }) : null;
  return (
    <Metric
      label={<>{label}{history && <CutoffTag history={history} />}{failure && <UpdateFailure {...failure} />}</>}
      helpLabel={label}
      value={pnl == null ? (failed && !data
        ? <button type="button" className="mx-inline-retry" onClick={() => void retry()}>{t("重试", "Retry")}</button>
        : "—") : (
        <>
          {signedPounds(pnl)}
          {share != null && <small className="mx-metric-change">{percent(share, true, 2)}</small>}
          <EstimateTag points={points} />
        </>
      )}
      tone={tone(pnl)}
      help={(
        <>
          {history?.pendingCashFlows && (
            <p>
              {t(
                "新的现金流待核对：数字统计至最后可核对的记录，核对完成后更新，届时再列出变动最大的持仓。",
                "New cash flows await reconciliation: the figure stops at the last verified record and catches up once they are reconciled; the largest position moves follow then.",
              )}
            </p>
          )}
          <p>
            {t(
              "本交易日第一条账户记录以来的净盈亏，已扣除当日出入金；下面列出变动最大的持仓。",
              "Net P&L since the trading day's first account observation, excluding money moved in or out that day; the largest position moves follow.",
            )}
          </p>
          <Facts rows={[[
            t("上一交易日收益", "Previous trading day"),
            <span key="previous" className={previousDay == null ? undefined : "mx-" + tone(previousDay)}>
              {percent(previousDay, true, 2)}
            </span>,
          ]]} />
        </>
      )}
      note={drivers ? <DayDrivers drivers={drivers} /> : undefined}
    />
  );
}
function OverviewHistory({
  range: requestedRange, selection, data, failed, retry, failure, waiting, initialWaiting, runtime, onRange, windowAttribution,
}: {
  range: Range;
  selection: Parameters<typeof usePortfolioHistory>[0];
  data?: ReturnType<typeof usePortfolioHistory>["data"];
  failed: boolean;
  retry: () => unknown;
  failure?: { updatedAt: number; retry: () => unknown };
  waiting: boolean;
  initialWaiting: boolean;
  runtime: ReturnType<typeof useChartRuntime>;
  onRange: (range: Range) => void;
  windowAttribution?: DashboardLens["windowAttribution"];
}) {
  const t = useCopy();
  const { range, scope } = selection;
  const history = data?.history ?? selectPortfolioHistory({ range, scope });
  const { points } = history;
  const isIntraday = history.source === "intraday";
  const money = data?.money ?? portfolioMoney([], scope);
  const attribution = windowAttribution;
  const lines = [{ name: t("净盈亏", "Net P&L"), values: money.pnls, area: true }];
  const drivers = range === "1W" && attribution ? dayDrivers({
    attribution,
    scope,
    day: history.endDay,
    dates: points.map((p) => p.date),
    pnls: money.pnls,
    openings: data?.openings,
    cutOff: history.pendingCashFlows,
  }) : null;
  return (
    <Panel
      className="mx-overview-history"
      title={t("区间净盈亏", "Period P&L")}
      help={<HistoryHelp />}
      action={
        <div className="mx-period-control">
          <PeriodSpan points={initialWaiting ? [] : points} reserve />
          {failure && <UpdateFailure {...failure} />}
          <Segments
            label={t("图表区间", "Chart range")}
            value={requestedRange}
            onChange={onRange}
            shortcuts
            options={PORTFOLIO_RANGES.map(
              (v) => ({
                value: v,
                label: v === "ALL" ? t("全部", "All") : v === "1W" ? "5D" : v,
              }),
            )}
          />
        </div>
      }
    >
      {initialWaiting || !data && !failed ? (
        <Pending shape="chart" height={326} quiet={initialWaiting} label={t("正在读取盈亏记录…", "Loading profit and loss records…")} />
      ) : runtime.status === "failed" ? (
        <QueryError retry={runtime.retry} />
      ) : !data ? (
        <QueryError retry={retry} />
      ) : (
        <div className="mx-data-body" aria-busy={waiting && !failed || undefined}>
          <div className="mx-period-figure">
            <strong className={money.pnl == null ? undefined : "mx-" + tone(money.pnl)}>
              {currency(money.pnl, "GBP", 2)}
            </strong>
            {money.pnl != null && (
              <span title={t("区间净盈亏 ÷ 期初账户价值", "Period net P&L divided by opening account value")}>
                {percent(money.pnlPercents.at(-1), true, 2)}
              </span>
            )}
            <EstimateTag points={points} />
            <TextLink href={portfolioPerformanceHref(scope, range)}>
              <ChartLine size={14} />
              {t("收益分析", "View performance")}
            </TextLink>
          </div>
          {drivers && <DayDrivers span="5D" drivers={drivers} />}
          <HistoryCoverage history={history} />
          <TimelineChart
            dates={points.map((p) => p.date)}
            layers={[{ label: t("净盈亏", "Net P&L"), lines, zeroBaseline: true }]}
            label={t("区间净盈亏曲线", "Period net profit and loss over time")}
            intraday={isIntraday}
            range={range}
            timeline={history.timeline}
            observations={points}
            pendingCashFlows={history.pendingCashFlows}
            recordSource={selection}
            height={264}
            tooltip={{
              range: range === "1W" ? "5D" : range === "ALL" ? t("全部", "All") : range,
              unit: "GBP",
              primary: [{ label: t("区间净盈亏", "Period P&L"), values: money.pnls, signed: true }],
              secondary: [],
            }}
          />
        </div>
      )}
    </Panel>
  );
}
