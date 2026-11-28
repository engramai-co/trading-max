"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { WorkspaceSheet } from "./overlay";
import { SearchInput } from "@/components/ui/search-input";
import { useAssistantPageContext } from "./assistant/context";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowDown, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button, CloseButton } from "@/components/ui/button";
import { useAllocationChartColours } from "@/ui/charts/palette";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { Holding } from "@/lib/types";
import { quoteValue } from "./financial-values";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { compareHoldings, dayChangeColumn, holdingSort, holdingSortDirection, type HoldingSort } from "./holdings-data";
import { ClosedMarket } from "./closed-market";
import { useCurrentDay } from "./current-day";
import { currency, number, percent, tone } from "@/workspace/data";
import { signedPounds } from "./day-drivers";
import {
  Empty,
  Freshness,
  Help,
  Instrument,
  Metric,
  Page,
  Panel,
  Pending,
  QueryError,
  QueryReadStatus,
  TabPanel,
  Tabs,
  TabsScope,
  Tag,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { Lookthrough } from "./look-through";
import { HoldingDetail } from "./holding-detail";
import { holdingPeekQuote, holdingPositionAsOf } from "./holding-detail-data";
import { useRouteState } from "./route-state";
import { SecurityPeek } from "./security-peek";
import { accountName, useWorkspaceProfile } from "./profile";
import { SelectPicker } from "./picker";

export function HoldingsWorkspace() {
  const t = useCopy();
  const { params, update } = useRouteState();
  const view =
    params.get("view") === "lookthrough" ? "lookthrough" : "positions";
  return (
    <Page title={t("持仓", "Holdings")}>
      <TabsScope value={view} onChange={(v) => update({ view: v === "positions" ? null : v })}>
      <Tabs
        label={t("持仓视图", "Holdings view")}
        value={view}
        options={[
          { value: "positions", label: t("直接持仓", "Direct holdings") },
          {
            value: "lookthrough",
            label: t("穿透", "Look-through"),
          },
        ]}
      />
      <TabPanel value={view}>
      {view === "positions" ? <Positions /> : <Lookthrough />}
      </TabPanel>
      </TabsScope>
    </Page>
  );
}
function Positions() {
  const t = useCopy();
  const [barColour] = useAllocationChartColours();
  const { locale, timeZone } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const cited = params.get("evidence") && params.get("snapshotId") || undefined;
  const account = ["A", "B"].includes(params.get("account") ?? "")
    ? params.get("account")!
    : "all";
  const query = useDashboardLens("holdings-positions",cited && (account === "A" || account === "B") ? account : undefined,true,cited ? {detail:"summary"} : undefined,cited);
  const publicationFailure = usePublicationFailure(query.dataUpdatedAt);
  const failure = query.isRefetchError ? { updatedAt: query.dataUpdatedAt, retry: query.refetch } : publicationFailure;
  const search = params.get("q") ?? "";
  const searchInput = useRef<HTMLInputElement>(null);
  const requestedSort = holdingSort(params.get("positionSort"));
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<{ holding: Holding; runId?: string; positionAsOf?: string | null; scope: string } | null>(null);
  const positionData = query.data;
  const focusedHolding = selected?.scope === account ? selected : null;
  const displayedAccount = focusedHolding?.holding.account ?? account;
  useAssistantPageContext({
    page: "holdings",
    scope: displayedAccount === "A" ? "invest" : displayedAccount === "B" ? "isa" : "broker_total",
    ticker: focusedHolding?.holding.ticker,
    snapshotId: focusedHolding?.runId ?? positionData?.runId,
  });
  const [limit, setLimit] = useState(20);
  const [detailed, setDetailed] = useState(true);
  const [sortStatus, setSortStatus] = useState("");
  const { today, now } = useCurrentDay();
  const scoped = useMemo(
    () =>
      (positionData?.holdings ?? []).filter(
        (h) => account === "all" || h.account === account,
      ),
    [positionData, account],
  );
  // The day column appears when a position has a reading or a known closure.
  const hasDay = scoped.some((h) => h.dayChangeGbp != null || h.dayChangeClosedOn);
  const sort = requestedSort === "day" && !hasDay ? "value" : requestedSort;
  const direction = holdingSortDirection(sort, params.get("direction"));
  const ascending = direction === "asc";
  const matching = search.toLowerCase().trim();
  const rows = scoped
    .filter(holding => (holding.ticker + " " + holding.name).toLowerCase().includes(matching))
    .sort((a, b) => compareHoldings(a, b, sort, direction));
  const positionStamp = (holding: Holding) => holdingPositionAsOf(holding, positionData);
  const snapshotBasis = (holding: Holding) => {
    const at = positionStamp(holding);
    return <small className="mx-holding-quote-basis">{t("券商快照", "Broker snapshot")} · {at
      ? <time dateTime={at}>{formatDateTime(at, locale, timeZone, now)}</time>
      : t("时间未提供", "Time unavailable")}</small>;
  };
  function selectHolding(holding: Holding, trigger: HTMLButtonElement) {
    detailTrigger.current = trigger;
    // Keep the timestamp paired with the figures even if the lens refreshes with the drawer open.
    const positionAsOf = positionStamp(holding);
    setSelected({ holding, positionAsOf, runId: positionData?.runId, scope: account });
  }
  // Totals come from the broker's account summaries, matching Overview; positions are the fallback.
  const summary = account === "all" ? null : query.data?.accounts?.find((item) => item.code === account);
  const invested = ((cited || account === "all") ? query.data?.totalInvestedGbp : summary?.investedGbp)
    ?? scoped.reduce((sum, h) => sum + h.currentValueGbp, 0);
  const pnl = ((cited || account === "all") ? query.data?.totalUnrealizedPnlGbp : summary?.unrealizedPnlGbp)
    ?? scoped.reduce((sum, h) => sum + h.pnlGbp, 0);
  // Weight bars compare positions with each other: the largest fills the track.
  const largestAllocation = Math.max(0, ...scoped.map((h) => h.allocationPct));
  const dayLabel = (date?: string | null) =>
    !date || date === today ? t("今日", "Today") : formatCalendarDate(date, locale, now);
  // An account still on Friday is never called today beside one already on Monday.
  const { latest: columnDay, earlier } = dayChangeColumn(scoped);
  const columnLabel = dayLabel(columnDay);
  const otherDay = (h: Holding) =>
    earlier(h) ? dayLabel(earlier(h)) : null;
  const sortLabels: Record<HoldingSort, string> = {
    ticker: t("名称", "Name"),
    value: t("市值", "Market value"),
    day: columnLabel,
    pnl: t("浮动盈亏", "Unrealised P&L"),
    allocation: t("占比", "Weight"),
  };
  const sortChoices = {
    value: [t("市值从大到小", "Largest value"), t("市值从小到大", "Smallest value")],
    day: [columnLabel + t("涨幅最大", " · largest rise"), columnLabel + t("跌幅最大", " · largest fall")],
    pnl: [t("盈亏从高到低", "Highest P&L"), t("盈亏从低到高", "Lowest P&L")],
    allocation: [t("权重从大到小", "Largest weight"), t("权重从小到大", "Smallest weight")],
    ticker: [t("代码 Z–A", "Ticker Z–A"), t("代码 A–Z", "Ticker A–Z")],
  };
  const phoneSortChoices = (["value", ...(hasDay ? ["day"] : []), "pnl", "allocation", "ticker"] as HoldingSort[])
    .flatMap((key) => {
      const [descendingLabel, ascendingLabel] = sortChoices[key];
      const descendingOption = { value: key + ":desc", label: descendingLabel };
      const ascendingOption = { value: key + ":asc", label: ascendingLabel };
      return key === "ticker" ? [ascendingOption, descendingOption] : [descendingOption, ascendingOption];
    });

  function changeSort(key: HoldingSort, nextDirection: "asc" | "desc") {
    if (sort === key && direction === nextDirection) return;
    update({ positionSort: key, direction: nextDirection });
    const order = sortChoices[key][nextDirection === "asc" ? 1 : 0];
    setSortStatus(t("已排序：", "Sorted by ") + order + t("，", ", ") + rows.length + t(" 条持仓", " holdings"));
  }

  function sortHeading(key: HoldingSort, numeric = false) {
    return <TableHead scope="col" className={numeric ? "mx-align-right" : undefined}
      aria-sort={sort === key ? (ascending ? "ascending" : "descending") : undefined}>
      <Button type="button" className={`tm-table-sort w-full px-2 text-muted-foreground ${numeric ? "justify-end" : "justify-start"}`} variant="ghost" size="table"
        onClick={() => changeSort(key, sort === key ? (ascending ? "desc" : "asc") : holdingSortDirection(key, null))}>
        {sortLabels[key]}
        {sort === key && <ArrowDown aria-hidden="true" size={16} className="-mx-[2px] shrink-0" />}
      </Button>
    </TableHead>;
  }
  if (cited && query.isError) return <Empty title={t("引用的数据版本暂不可用","Cited publication unavailable")} />;
  return (
    <>
          <div className="mx-panel mx-holdings-summary">
            <div className="mx-toolbar">
              <SelectPicker
                aria-label={t("选择账户", "Choose account")}
                intrinsic
                value={account}
                onChange={(v) => {
                  setLimit(20);
                  update({ account: v === "all" ? null : v });
                }}
                options={[
                  {
                    value: "all",
                    label: t("全部投资账户", "All investment accounts"),
                  },
                  { value: "A", label: accountName(profile, "A") },
                  { value: "B", label: accountName(profile, "B") },
                ]}
              />
              <span className="mx-freshness-group">
                <Freshness date={summary?.asOf ?? query.data?.brokerAsOf} />
                {failure && <UpdateFailure {...failure} />}
              </span>
            </div>
            {!query.data ? <Pending shape="summary" height={68} quiet />
              : <div className="mx-metric-grid mx-metric-lead">
              <Metric
                label={t("已投资市值", "Invested value")}
                value={currency(invested, "GBP", 2)}
              />
              <Metric
                label={t("浮动盈亏", "Unrealised P&L")}
                value={currency(pnl, "GBP", 2)}
                tone={tone(pnl)}
              />
              <Metric
                label={t("盈利持仓", "Profitable holdings")}
                value={`${scoped.filter((h) => h.pnlGbp > 0).length} / ${scoped.length}`}
              />
            </div>}
          </div>
          <Panel className="mx-holdings-list tm-table-variants">
            <div className="mx-toolbar">
              <SearchInput
                className="mx-search-input"
                ref={searchInput}
                aria-label={t("筛选持仓", "Filter holdings")}
                placeholder={t("筛选持仓…", "Filter holdings…")}
                leading={<Search aria-hidden="true" size={18} />}
                value={search}
                onChange={(e) => {
                  setLimit(20);
                  update({ q: e.currentTarget.value || null });
                }}
                trailing={
                  search && (
                    <CloseButton
                      aria-label={t("清除搜索", "Clear search")}
                      onClick={() => { update({ q: null }); searchInput.current?.focus(); }}
                    />
                  )
                }
              />
              <div className="flex flex-wrap items-center gap-mx-sm">
                <Checkbox
                  label={t("成本与汇率", "Cost & FX")}
                  checked={detailed}
                  onCheckedChange={(checked) => setDetailed(checked)}
                />
                {search && (
                  <span className="mx-metric-note">
                    {rows.length} / {scoped.length}
                  </span>
                )}
                {/* Phones sort here; the desktop table sorts from its headers. */}
                <SelectPicker
                  className="mx-holdings-sort"
                  aria-label={t("持仓排序", "Sort holdings")}
                  style={{ width: 155 }}
                  options={phoneSortChoices}
                  value={sort + ":" + direction}
                  onChange={(value) => {
                    if (!value) return;
                    const [key, order] = value.split(":");
                    changeSort(holdingSort(key), order === "asc" ? "asc" : "desc");
                  }}
                />
              </div>
            </div>
            <p role="status" className="sr-only">{sortStatus}</p>
            <QueryReadStatus key={cited ?? "live"} failed={!positionData && query.isError}
              refreshFailed={!!failure?.updatedAt} ready={!!positionData} error={query.error} />
            {query.isPending ? (
              <Pending shape="holdings" label={t("正在读取持仓…", "Loading holdings…")} />
            ) : !query.data ? (
              <QueryError retry={query.refetch} error={query.error} />
            ) : rows.length ? (
              <>
                <Table containerProps={{ className: "mx-table-wrap mx-desktop-holdings tm-table-wide" }} label={t("直接持仓", "Direct holdings")} className="mx-table">
                  <TableHeader>
                    <TableRow>
                      {sortHeading("ticker")}
                      {detailed && (
                        <>
                          <TableHead scope="col" className="mx-align-right">
                            <span className="mx-th-help">
                              {t("买入成本", "Purchase cost")}
                              <Help label={t("买入成本", "Purchase cost")}>
                                {t(
                                  "下方是每股摊薄成本：计入已实现交易与回收资金，可能不同于券商买入均价。",
                                  "The figure below is the diluted cost per share. It includes realised trades and recovered capital, so it may differ from the broker's average purchase price.",
                                )}
                              </Help>
                            </span>
                          </TableHead>
                          <TableHead scope="col" className="mx-align-right">
                            {t("现价", "Current price")}
                          </TableHead>
                          <TableHead scope="col" className="mx-align-right">
                            {t("汇率影响", "FX impact")}
                          </TableHead>
                        </>
                      )}
                      <TableHead scope="col">{t("账户", "Account")}</TableHead>
                      {sortHeading("value", true)}
                      {hasDay && sortHeading("day", true)}
                      {sortHeading("pnl", true)}
                      {sortHeading("allocation", true)}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, limit).map((h) => (
                      <TableRow key={h.account + ":" + h.ticker}>
                        <TableHead scope="row">
                          <button
                            className="mx-table-button"
                            onClick={(event) => selectHolding(h, event.currentTarget)}
                          >
                            <span className="sr-only">{t("查看持仓 ", "View holding ")}</span>
                            <SecurityPeek
                              ticker={h.ticker}
                              priceTicker={h.researchTicker ?? undefined}
                              range="1D"
                              position={{ valueGbp: h.currentValueGbp, weightPct: h.allocationPct }}
                              quote={holdingPeekQuote(h, positionData, accountName(profile, h.account), Boolean(cited))}
                            >
                              <Instrument ticker={h.ticker} name={h.name} isin={h.fundIsin} />
                            </SecurityPeek>
                          </button>
                        </TableHead>
                        {detailed && (
                          <>
                            <TableCell className="mx-align-right">
                              {currency(h.costGbp, "GBP", 2)}
                              <small>
                                {quoteValue(h.dilutedCostPerShareNative, h.dilutedCostCurrency)}
                              </small>
                            </TableCell>
                            <TableCell className="mx-align-right">
                              {quoteValue(h.currentPrice, h.priceCurrency)}
                              {snapshotBasis(h)}
                            </TableCell>
                            <TableCell className="mx-align-right">
                              {currency(h.fxImpactGbp, "GBP", 2)}
                            </TableCell>
                          </>
                        )}
                        <TableCell>
                          <Tag>{accountName(profile, h.account)}</Tag>
                        </TableCell>
                        <TableCell className="mx-align-right">
                          <strong>
                            {currency(h.currentValueGbp, "GBP", 2)}
                          </strong>
                          <small>
                            {number(h.quantity, 4)} {number(h.quantity, 4) === "1" ? t("股", "share") : t("股", "shares")}
                          </small>
                        </TableCell>
                        {hasDay && (
                          <TableCell className="mx-align-right">
                            {h.dayChangeClosedOn ? (
                              <>
                                <ClosedMarket />
                                {otherDay(h) && <small><Tag tone="warn">{otherDay(h)}</Tag></small>}
                              </>
                            ) : h.dayChangeGbp == null ? "—" : (
                              <>
                                <strong className={"mx-" + tone(h.dayChangeGbp)}>
                                  {signedPounds(h.dayChangeGbp)}
                                </strong>
                                {(h.dayChangePct != null || otherDay(h)) && (
                                  <small className="tm-holding-day-detail">
                                    {h.dayChangePct != null && (
                                      <span className={"mx-" + tone(h.dayChangePct)}>
                                        {percent(h.dayChangePct, true, 2)}
                                      </span>
                                    )}{" "}
                                    {otherDay(h) && <Tag tone="warn">{otherDay(h)}</Tag>}
                                  </small>
                                )}
                              </>
                            )}
                          </TableCell>
                        )}
                        <TableCell className="mx-align-right">
                          <strong className={"mx-" + tone(h.pnlGbp)}>
                            {currency(h.pnlGbp, "GBP", 2)}
                          </strong>
                          <small>
                            <span className={"mx-" + tone(h.pnlPct)}>
                              {percent(h.pnlPct, true, 2)}
                            </span>
                          </small>
                        </TableCell>
                        <TableCell className="mx-align-right">
                          <div className="flex flex-wrap items-center justify-end gap-mx-sm">
                            <div className="mx-mini-bar" aria-hidden="true">
                              <i
                                style={{
                                  backgroundColor: barColour,
                                  width: percent(
                                    largestAllocation > 0
                                      ? Math.min(1, Math.max(0, h.allocationPct / largestAllocation))
                                      : 0,
                                  ),
                                }}
                              />
                            </div>
                            {percent(h.allocationPct)}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="mx-mobile-holdings tm-table-compact">
                  {rows.slice(0, limit).map((h) => (
                    <button
                      key={h.account + h.ticker}
                      className="mx-holding-mobile"
                      onClick={(event) => selectHolding(h, event.currentTarget)}
                    >
                      <div>
                        <Instrument ticker={h.ticker} name={h.name} isin={h.fundIsin} />
                        <span className="mx-row-value">
                          {currency(h.currentValueGbp, "GBP", 2)}
                          <small>
                            <span className={"mx-" + tone(h.pnlGbp)}>
                              {currency(h.pnlGbp, "GBP", 2)} · {percent(h.pnlPct, true)}
                            </span>
                          </small>
                          {(h.dayChangeGbp != null || h.dayChangeClosedOn) && (
                            <small className="mx-holding-day">
                              {dayLabel(h.dayChangeClosedOn ?? h.dayChangeDate ?? columnDay)}{" "}
                              {h.dayChangeClosedOn ? <ClosedMarket /> : h.dayChangeGbp != null && (
                                <span className={"mx-" + tone(h.dayChangeGbp)}>
                                  {signedPounds(h.dayChangeGbp)}
                                  {h.dayChangePct != null && " " + percent(h.dayChangePct, true, 2)}
                                </span>
                              )}
                            </small>
                          )}
                        </span>
                      </div>
                      <footer>
                        <span>
                          {accountName(profile, h.account)} ·{" "}
                          {number(h.quantity, 4)} {number(h.quantity, 4) === "1" ? t("股", "share") : t("股", "shares")}
                        </span>
                        <span className="mx-weight">
                          <span className="mx-mini-bar" aria-hidden="true">
                            <i style={{ width: `${largestAllocation > 0 ? (h.allocationPct / largestAllocation) * 100 : 0}%`, backgroundColor: barColour }} />
                          </span>
                          <span className="sr-only">{t("占比", "Weight")} </span>
                          {percent(h.allocationPct)}
                        </span>
                      </footer>
                      {detailed && (
                        <footer>
                          <span>
                            {t("成本", "Cost")} {currency(h.costGbp, "GBP", 2)}
                          </span>
                          <span>
                            {t("报价", "Price")}{" "}
                            {quoteValue(h.currentPrice, h.priceCurrency)}
                            {snapshotBasis(h)}
                          </span>
                        </footer>
                      )}
                    </button>
                  ))}
                </div>
                {rows.length > limit && (
                  <Button
                    variant="ghost"
                    fullWidth
                    className="mt-mx-md"
                    onClick={() => setLimit((n) => n + 30)}
                  >
                    {t("继续显示", "Show more")} · {rows.length - limit}
                  </Button>
                )}
              </>
            ) : (
              <Empty
                title={
                  search
                    ? t("没有匹配的持仓", "No matching holdings")
                    : t("这个账户还没有持仓", "No holdings in this account")
                }
                description={t(
                  "试试另一个名称，或切换账户范围。",
                  "Try another name or select a different account.",
                )}
                action={
                  search && (
                    <Button
                      variant="secondary"
                      onClick={() => update({ q: null })}
                    >
                      {t("清除筛选", "Clear filters")}
                    </Button>
                  )
                }
              />
            )}
          </Panel>
      <WorkspaceSheet
        open={selected !== null && selected.scope === account}
        onClose={() => setSelected(null)}
        title={t("持仓明细", "Holding detail")}
        finalFocus={detailTrigger}
        closeLabel={t("关闭持仓明细", "Close holding detail")}
        className="mx-position-drawer"
      >
        {selected && (
          <HoldingDetail
            holding={selected.holding}
            account={accountName(profile, selected.holding.account)}
            positionAsOf={selected.positionAsOf}
            runId={selected.runId}
            today={today}
            now={now}
          />
        )}
      </WorkspaceSheet>
    </>
  );
}
