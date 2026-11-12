"use client";

import {
  Button,
  Checkbox,
  CloseButton,
  Drawer,
  Group,
  Select,
  TextInput,
} from "@mantine/core";
import { ArrowDown, MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useAllocationChartColours } from "@/ui/charts/palette";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { Holding } from "@/lib/types";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { compareHoldings, dayChangeColumn, holdingSort, holdingSortDirection } from "./holdings-data";
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
  Tabs,
  Tag,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { Lookthrough } from "./look-through";
import { HoldingDetail } from "./holding-detail";
import { useRouteState } from "./route-state";
import { SecurityPeek } from "./security-peek";
import { accountName, useWorkspaceProfile } from "./profile";

export function HoldingsWorkspace() {
  const t = useCopy();
  const { params, update } = useRouteState();
  const view =
    params.get("view") === "lookthrough" ? "lookthrough" : "positions";
  return (
    <Page title={t("持仓", "Holdings")}>
      <Tabs
        label={t("持仓视图", "Holdings view")}
        value={view}
        onChange={(v) => update({ view: v === "positions" ? null : v })}
        options={[
          { value: "positions", label: t("直接持仓", "Your positions") },
          {
            value: "lookthrough",
            label: t("穿透底层资产", "Look-through exposure"),
          },
        ]}
      />
      {view === "positions" ? <Positions /> : <Lookthrough />}
    </Page>
  );
}
function Positions() {
  const t = useCopy();
  const [barColour] = useAllocationChartColours();
  const { locale } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const query = useDashboardLens("holdings-positions");
  const publicationFailure = usePublicationFailure(query.dataUpdatedAt);
  const failure = query.isRefetchError ? { updatedAt: query.dataUpdatedAt, retry: query.refetch } : publicationFailure;
  const account = ["A", "B"].includes(params.get("account") ?? "")
    ? params.get("account")!
    : "all";
  const search = params.get("q") ?? "";
  const requestedSort = holdingSort(params.get("positionSort"));
  const [selected, setSelected] = useState<{ holding: Holding; runId?: string; accountAsOf?: string | null; scope: string } | null>(null);
  const positionData = query.data;
  const [limit, setLimit] = useState(20);
  const [detailed, setDetailed] = useState(true);
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
  const rows = useMemo(
    () =>
      scoped
        .filter((h) =>
          (h.ticker + " " + h.name)
            .toLowerCase()
            .includes(search.toLowerCase().trim()),
        )
        .sort((a, b) => compareHoldings(a, b, sort, direction)),
    [scoped, search, sort, direction],
  );
  function selectHolding(holding: Holding) {
    // Keep the timestamp paired with the figures even if the lens refreshes with the drawer open.
    const accountAsOf = positionData?.accounts?.find((item) => item.code === holding.account)?.asOf;
    setSelected({ holding, accountAsOf, runId: positionData?.runId, scope: account });
  }
  // Totals come from the broker's account summaries, matching Overview; positions are the fallback.
  const summary = account === "all" ? null : query.data?.accounts?.find((item) => item.code === account);
  const invested = (account === "all" ? query.data?.totalInvestedGbp : summary?.investedGbp)
    ?? scoped.reduce((sum, h) => sum + h.currentValueGbp, 0);
  const pnl = (account === "all" ? query.data?.totalUnrealizedPnlGbp : summary?.unrealizedPnlGbp)
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
  const sortButton = (label: string, key: string) => (
    <button
      className="mx-sort"
      onClick={() =>
        update({
          positionSort: key,
          direction: sort === key ? (ascending ? "desc" : "asc") : key === "ticker" ? "asc" : "desc",
        })
      }
    >
      {label}
      {sort === key && (
        <ArrowDown
          size={12}
          style={{ transform: ascending ? "rotate(180deg)" : undefined }}
        />
      )}
    </button>
  );
  return (
    <>
          <div className="mx-panel mx-holdings-summary">
            <div className="mx-toolbar">
              <Select
                aria-label={t("选择账户", "Choose account")}
                w={190}
                value={account}
                onChange={(v) => {
                  setLimit(20);
                  update({ account: v === "all" ? null : v });
                }}
                data={[
                  {
                    value: "all",
                    label: t("全部投资账户", "All investment accounts"),
                  },
                  { value: "A", label: accountName(profile, "A") },
                  { value: "B", label: accountName(profile, "B") },
                ]}
              />
              <span className="mx-freshness-group">
                <Freshness date={query.data?.brokerAsOf} />
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
                label={t("浮动盈亏", "Unrealized P&L")}
                value={currency(pnl, "GBP", 2)}
                tone={tone(pnl)}
              />
              <Metric
                label={t("盈利持仓", "Profitable positions")}
                value={`${scoped.filter((h) => h.pnlGbp > 0).length} / ${scoped.length}`}
              />
            </div>}
          </div>
          <Panel className="mx-holdings-list">
            <div className="mx-toolbar">
              <TextInput
                className="mx-search-input"
                aria-label={t("筛选持仓", "Filter positions")}
                placeholder={t("筛选持仓…", "Filter positions…")}
                leftSection={<MagnifyingGlass size={17} />}
                value={search}
                onChange={(e) => {
                  setLimit(20);
                  update({ q: e.currentTarget.value || null });
                }}
                rightSection={
                  search && (
                    <CloseButton
                      aria-label={t("清除搜索", "Clear search")}
                      onClick={() => update({ q: null })}
                    />
                  )
                }
              />
              <Group gap="sm">
                <Checkbox
                  label={t("成本与汇率", "Cost & FX")}
                  checked={detailed}
                  onChange={(e) => setDetailed(e.currentTarget.checked)}
                />
                {search && (
                  <span className="mx-metric-note">
                    {rows.length} / {scoped.length}
                  </span>
                )}
                {/* Phones sort here; the desktop table sorts from its headers. */}
                <Select
                  className="mx-holdings-sort"
                  aria-label={t("持仓排序", "Sort holdings")}
                  w={155}
                  data={[
                    { value: "value", label: sort === "value" && ascending ? t("市值从小到大", "Smallest value") : t("市值从大到小", "Largest value") },
                    ...(hasDay ? [{ value: "day", label: sort === "day" && ascending ? columnLabel + t("跌幅最大", " · largest fall") : columnLabel + t("涨幅最大", " · largest rise") }] : []),
                    { value: "pnl", label: sort === "pnl" && ascending ? t("盈亏从低到高", "Lowest P&L") : t("盈亏从高到低", "Highest P&L") },
                    {
                      value: "allocation",
                      label: sort === "allocation" && ascending ? t("权重从小到大", "Smallest weight") : t("权重从大到小", "Largest weight"),
                    },
                    { value: "ticker", label: sort === "ticker" && !ascending ? t("代码 Z–A", "Ticker Z–A") : t("代码 A–Z", "Ticker A–Z") },
                  ]}
                  value={sort}
                  onChange={(v) => update({ positionSort: v, direction: v === "ticker" ? "asc" : "desc" })}
                />
              </Group>
            </div>
            {query.isPending ? (
              <Pending shape="holdings" label={t("正在读取持仓…", "Loading holdings…")} />
            ) : !query.data ? (
              <QueryError retry={query.refetch} />
            ) : rows.length ? (
              <>
                <div className="mx-table-wrap mx-desktop-holdings">
                  <table className="mx-table">
                    <thead>
                      <tr>
                        <th>{sortButton(t("资产", "Security"), "ticker")}</th>
                        {detailed && (
                          <>
                            <th className="mx-align-right">
                              <span className="mx-th-help">
                                {t("买入成本", "Purchase cost")}
                                <Help label={t("买入成本", "Purchase cost")}>
                                  {t(
                                    "下方是每股摊薄成本：计入已实现交易与回收资金，可能不同于券商买入均价。",
                                    "The figure below is the diluted cost per share. It includes realized trades and recovered capital, so it may differ from the broker's average purchase price.",
                                  )}
                                </Help>
                              </span>
                            </th>
                            <th className="mx-align-right">
                              {t("当前价格", "Current price")}
                            </th>
                            <th className="mx-align-right">
                              {t("汇率影响", "FX impact")}
                            </th>
                          </>
                        )}
                        <th>{t("账户", "Account")}</th>
                        <th className="mx-align-right">
                          {sortButton(t("市值", "Market value"), "value")}
                        </th>
                        {hasDay && (
                          <th className="mx-align-right">
                            {sortButton(columnLabel, "day")}
                          </th>
                        )}
                        <th className="mx-align-right">
                          {sortButton(t("浮动盈亏", "Unrealized P&L"), "pnl")}
                        </th>
                        <th className="mx-align-right">
                          {sortButton(
                            t("总组合占比", "Portfolio weight"),
                            "allocation",
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, limit).map((h) => (
                        <tr key={h.account + h.ticker}>
                          <td>
                            <button
                              className="mx-table-button"
                              onClick={() => selectHolding(h)}
                              aria-label={
                                t("查看持仓 ", "View position ") + h.ticker
                              }
                            >
                              <SecurityPeek ticker={h.ticker} position={{ valueGbp: h.currentValueGbp, weightPct: h.allocationPct }}>
                                <Instrument ticker={h.ticker} name={h.name} />
                              </SecurityPeek>
                            </button>
                          </td>
                          {detailed && (
                            <>
                              <td className="mx-align-right">
                                {currency(h.costGbp, "GBP", 2)}
                                <small>
                                  {currency(
                                    h.dilutedCostPerShareNative,
                                    h.dilutedCostCurrency,
                                    2,
                                  )}
                                </small>
                              </td>
                              <td className="mx-align-right">
                                {currency(h.currentPrice, h.priceCurrency, 2)}
                              </td>
                              <td className="mx-align-right">
                                {currency(h.fxImpactGbp, "GBP", 2)}
                              </td>
                            </>
                          )}
                          <td>
                            <Tag>{accountName(profile, h.account)}</Tag>
                          </td>
                          <td className="mx-align-right">
                            <strong>
                              {currency(h.currentValueGbp, "GBP", 2)}
                            </strong>
                            <small>
                              {number(h.quantity, 4)} {t("股", "shares")}
                            </small>
                          </td>
                          {hasDay && (
                            <td className="mx-align-right">
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
                                    <small>
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
                            </td>
                          )}
                          <td className="mx-align-right">
                            <strong className={"mx-" + tone(h.pnlGbp)}>
                              {currency(h.pnlGbp, "GBP", 2)}
                            </strong>
                            <small>
                              <span className={"mx-" + tone(h.pnlPct)}>
                                {percent(h.pnlPct, true, 2)}
                              </span>
                            </small>
                          </td>
                          <td className="mx-align-right">
                            <Group gap="sm" justify="flex-end">
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
                            </Group>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mx-mobile-holdings">
                  {rows.slice(0, limit).map((h) => (
                    <button
                      key={h.account + h.ticker}
                      className="mx-holding-mobile"
                      onClick={() => selectHolding(h)}
                    >
                      <div>
                        <Instrument ticker={h.ticker} name={h.name} />
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
                          {number(h.quantity, 4)} {t("股", "shares")}
                        </span>
                        <span className="mx-weight">
                          <span className="mx-mini-bar" aria-hidden="true">
                            <i style={{ width: `${largestAllocation > 0 ? (h.allocationPct / largestAllocation) * 100 : 0}%`, backgroundColor: barColour }} />
                          </span>
                          <span className="sr-only">{t("组合权重", "Weight")} </span>
                          {percent(h.allocationPct)}
                        </span>
                      </footer>
                      {detailed && (
                        <footer>
                          <span>
                            {t("成本", "Cost")} {currency(h.costGbp, "GBP", 2)}
                          </span>
                          <span>
                            {t("现价", "Price")}{" "}
                            {currency(h.currentPrice, h.priceCurrency, 2)}
                          </span>
                        </footer>
                      )}
                    </button>
                  ))}
                </div>
                {rows.length > limit && (
                  <Button
                    variant="subtle"
                    fullWidth
                    mt="md"
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
                    ? t("没有匹配的持仓", "No matching positions")
                    : t("这个账户还没有持仓", "No positions in this account")
                }
                description={t(
                  "试试另一个名称，或切换账户范围。",
                  "Try another name or select a different account.",
                )}
                action={
                  search && (
                    <Button
                      variant="default"
                      onClick={() => update({ q: null })}
                    >
                      {t("清除筛选", "Clear filter")}
                    </Button>
                  )
                }
              />
            )}
          </Panel>
      <Drawer
        opened={selected !== null && selected.scope === account}
        onClose={() => setSelected(null)}
        title={t("持仓明细", "Position detail")}
        closeButtonProps={{ "aria-label": t("关闭持仓明细", "Close position detail") }}
        classNames={{ content: "mx-position-drawer" }}
      >
        {selected && (
          <HoldingDetail
            holding={selected.holding}
            account={accountName(profile, selected.holding.account)}
            accountAsOf={selected.accountAsOf}
            runId={selected.runId}
            today={today}
            now={now}
          />
        )}
      </Drawer>
    </>
  );
}
