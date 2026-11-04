"use client";

import {
  Button,
  Checkbox,
  CloseButton,
  Drawer,
  Group,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { ArrowDown, ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "./link";
import { useMemo, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { Holding } from "@/lib/types";
import { compareHoldings, holdingSortDirection } from "./holdings-data";
import { currency, number, percent, tone } from "@/workspace/data";
import {
  Empty,
  Facts,
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
  useCopy,
} from "./foundation";
import { Lookthrough } from "./look-through";
import { useRouteState } from "./route-state";
import { SecurityPeek } from "./security-peek";
import { accountName, useWorkspaceProfile } from "./profile";

export function HoldingsWorkspace() {
  const t = useCopy();
  const { params, update } = useRouteState();
  const view =
    params.get("view") === "lookthrough" ? "lookthrough" : "positions";
  return (
    <Page title={t("持仓与真实敞口", "Holdings & exposure")}>
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
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const query = useDashboardLens("holdings-positions");
  const account = ["A", "B"].includes(params.get("account") ?? "")
    ? params.get("account")!
    : "all";
  const search = params.get("q") ?? "";
  const sort = ["value", "pnl", "ticker", "allocation"].includes(
    params.get("positionSort") ?? "",
  )
    ? params.get("positionSort")!
    : "value";
  const [selected, setSelected] = useState<Holding | null>(null);
  const [limit, setLimit] = useState(20);
  const [detailed, setDetailed] = useState(true);
  const direction = holdingSortDirection(sort, params.get("direction"));
  const ascending = direction === "asc";
  const scoped = useMemo(
    () =>
      (query.data?.holdings ?? []).filter(
        (h) => account === "all" || h.account === account,
      ),
    [query.data, account],
  );
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
  // Totals come from the broker's account summaries, matching Overview; positions are the fallback.
  const summary = account === "all" ? null : query.data?.accounts?.find((item) => item.code === account);
  const invested = (account === "all" ? query.data?.totalInvestedGbp : summary?.investedGbp)
    ?? scoped.reduce((sum, h) => sum + h.currentValueGbp, 0);
  const pnl = (account === "all" ? query.data?.totalUnrealizedPnlGbp : summary?.unrealizedPnlGbp)
    ?? scoped.reduce((sum, h) => sum + h.pnlGbp, 0);
  // Weight bars compare positions with each other: the largest fills the track.
  const largestAllocation = Math.max(0, ...scoped.map((h) => h.allocationPct));
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
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        <>
          <div className="mx-panel">
            <div className="mx-toolbar" style={{ marginBottom: 24 }}>
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
              <Freshness date={query.data?.brokerAsOf} />
            </div>
            <div className="mx-metric-grid mx-metric-lead">
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
            </div>
          </div>
          <Panel
            title={t("持仓明细", "Positions")}
            help={t(
              "选择任一持仓，查看数量、成本和汇率影响。",
              "Select a position to inspect cost, quantity and currency effects.",
            )}
          >
            <div className="mx-toolbar" style={{ marginBottom: 22 }}>
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
                <Select
                  aria-label={t("持仓排序", "Sort holdings")}
                  w={155}
                  data={[
                    { value: "value", label: sort === "value" && ascending ? t("市值从小到大", "Smallest value") : t("市值从大到小", "Largest value") },
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
            {rows.length ? (
              <>
                <div className="mx-table-wrap mx-desktop-holdings">
                  <table className="mx-table">
                    <thead>
                      <tr>
                        <th>{sortButton(t("资产", "Security"), "ticker")}</th>
                        {detailed && (
                          <>
                            <th className="mx-align-right">
                              {t("买入成本", "Purchase cost")}
                              <small>{t("摊薄成本 / 股", "Diluted cost / share")}</small>
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
                              onClick={() => setSelected(h)}
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
                      onClick={() => setSelected(h)}
                    >
                      <div>
                        <Instrument ticker={h.ticker} name={h.name} />
                        <span className="mx-row-value">
                          {currency(h.currentValueGbp, "GBP", 2)}
                          <small className={"mx-" + tone(h.pnlPct)}>
                            {percent(h.pnlPct, true)}
                          </small>
                        </span>
                      </div>
                      <footer>
                        <span>
                          {accountName(profile, h.account)} ·{" "}
                          {number(h.quantity, 4)} {t("股", "shares")}
                        </span>
                        <span className="mx-weight" aria-label={t("组合权重 ", "Weight ") + percent(h.allocationPct)}>
                          <span className="mx-mini-bar" aria-hidden="true">
                            <i style={{ width: `${largestAllocation > 0 ? (h.allocationPct / largestAllocation) * 100 : 0}%` }} />
                          </span>
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
        </>
      )}
      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={t("持仓明细", "Position detail")}
      >
        {selected && (
          <Stack gap="lg">
            <Instrument ticker={selected.ticker} name={selected.name} />
            <Metric
              large
              label={t("当前市值", "Current market value")}
              value={currency(selected.currentValueGbp, "GBP", 2)}
            />
            <div className="mx-metric-grid mx-position-metrics">
              <Metric
                label={t("浮动盈亏", "Unrealized P&L")}
                value={currency(selected.pnlGbp, "GBP", 2)}
                tone={tone(selected.pnlGbp)}
              />
              <Metric
                label={t("回报率", "Return")}
                value={percent(selected.pnlPct, true, 2)}
                tone={tone(selected.pnlPct)}
              />
            </div>
            <Facts
              rows={[
                [t("账户", "Account"), accountName(profile, selected.account)],
                [t("持有数量", "Quantity"), number(selected.quantity, 5)],
                [
                  t("当前价格", "Current price"),
                  currency(selected.currentPrice, selected.priceCurrency, 2),
                ],
                [
                  t("买入总成本", "Total purchase cost"),
                  currency(selected.costGbp, "GBP", 2),
                ],
                [
                  <span key="diluted-cost">{t("摊薄成本 / 股", "Diluted cost / share")}{" "}<Help label={t("摊薄成本", "Diluted cost")}>{t("计入已实现交易与回收资金，可能不同于券商买入均价。", "Includes realized trades and recovered capital; it may differ from broker purchase cost.")}</Help></span>,
                  currency(
                    selected.dilutedCostPerShareNative,
                    selected.dilutedCostCurrency,
                    2,
                  ),
                ],
                [
                  t("摊薄成本 / 股 · GBP", "Diluted cost / share · GBP"),
                  currency(selected.dilutedCostPerShareGbp, "GBP", 2),
                ],
                [
                  t("汇率影响", "FX impact"),
                  currency(selected.fxImpactGbp, "GBP", 2),
                ],
                [
                  t("快照汇率 / GBP", "Snapshot FX / GBP"),
                  number(selected.snapshotFxRateNativePerGbp, 5),
                ],
                [
                  t("总组合占比", "Overall portfolio weight"),
                  percent(selected.allocationPct),
                ],
              ]}
            />
            <Button
              component={Link}
              href={"/research?ticker=" + encodeURIComponent(selected.ticker)}
              rightSection={<ArrowRight size={16} />}
            >
              {t("研究这项投资", "Research this investment")}
            </Button>
          </Stack>
        )}
      </Drawer>
    </>
  );
}
