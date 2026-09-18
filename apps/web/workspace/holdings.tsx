"use client";

import {
  Button,
  Checkbox,
  Pagination,
  CloseButton,
  Drawer,
  Group,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { ArrowDown, ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type {
  Holding,
  LookthroughData,
  LookthroughPosition,
} from "@/lib/types";
import { compareHoldings, holdingSortDirection } from "./holdings-data";
import { EvidenceTable, usePaginationLabels } from "./evidence-table";
import { AllocationComposition } from "./allocation-composition";
import { AllocationRanking } from "./allocation-ranking";
import {
  currency,
  number,
  numeric,
  objects,
  percent,
  safeUrl,
  str,
  tone,
} from "./data";
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
  Segments,
  Tabs,
  Tag,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { Narrative } from "./narrative";
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
  const invested = scoped.reduce((sum, h) => sum + h.currentValueGbp, 0);
  const pnl = scoped.reduce((sum, h) => sum + h.pnlGbp, 0);
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
            <div className="mx-metric-grid">
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
                label={t("持仓数量", "Open positions")}
                value={scoped.length}
              />
              <Metric
                label={t("盈利持仓", "Profitable positions")}
                value={scoped.filter((h) => h.pnlGbp > 0).length}
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
                <span className="mx-metric-note">
                  {rows.length} {t("个结果", "results")}
                </span>
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
                              <Instrument ticker={h.ticker} name={h.name} />
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
                                  )}{" "}
                                  / {t("股 · 摊薄", "share · diluted")}
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
                                      Math.min(1, Math.max(0, h.allocationPct)),
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
                        <span>
                          {t("组合权重 ", "Weight ")}
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
function Lookthrough() {
  const t = useCopy();
  const query = useDashboardLens("holdings-lookthrough");
  return query.isPending ? (
    <Pending />
  ) : query.isError ? (
    <QueryError retry={query.refetch} />
  ) : query.data?.lookthrough ? (
    <Exposure data={query.data.lookthrough} snapshot={query.data.runId} />
  ) : (
    <Empty title={t("暂无穿透记录", "No look-through records")} />
  );
}
function Exposure({
  data,
  snapshot,
}: {
  data: LookthroughData;
  snapshot: string;
}) {
  const t = useCopy();
  const paginationLabels = usePaginationLabels();
  const detail = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<
    "companies" | "countries" | "sectors" | "gics" | "sources"
  >("companies");
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("all");
  const [selected, setSelected] = useState<LookthroughPosition | null>(null);
  const [page, setPage] = useState(1);
  const [sector, setSector] = useState("all");
  const [ownership, setOwnership] = useState("all");
  const [sort, setSort] = useState("total");
  const [chart, setChart] = useState("rank");
  const sectors = [
    ...new Set(
      data.positions
        .map((p) => p.gics?.sectorName)
        .filter((v): v is string => Boolean(v)),
    ),
  ].sort();
  const countries = [
    ...new Set(
      data.positions
        .map((p) => p.country)
        .filter((c): c is string => Boolean(c)),
    ),
  ].sort();
  const rows = data.positions
    .filter(
      (p) =>
        (country === "all" || p.country === country) &&
        (sector === "all" || p.gics?.sectorName === sector) &&
        (ownership === "all" ||
          (ownership === "direct" &&
            p.directValueGbp > 0 &&
            p.indirectValueGbp === 0) ||
          (ownership === "indirect" &&
            p.indirectValueGbp > 0 &&
            p.directValueGbp === 0) ||
          (ownership === "both" &&
            p.directValueGbp > 0 &&
            p.indirectValueGbp > 0)) &&
        [
          p.name,
          p.ticker,
          p.isin,
          p.gics?.sectorName,
          p.gics?.industryName,
          p.gics?.subIndustryName,
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "direct"
          ? b.directValueGbp - a.directValueGbp
          : sort === "indirect"
            ? b.indirectValueGbp - a.indirectValueGbp
            : b.valueGbp - a.valueGbp,
    );
  const pages = Math.max(1, Math.ceil(rows.length / 30));
  const currentPage = Math.min(page, pages);
  const pageRows = rows.slice((currentPage - 1) * 30, currentPage * 30);
  if (!data.available)
    return (
      <Panel>
        <Empty
          title={t(
            "底层资产还在等待数据",
            "Look-through data is not available",
          )}
          description={t(
            "完成完整更新后，ETF 成分和分类覆盖将显示在这里。",
            "Run a full update to see ETF constituents and classification coverage.",
          )}
          action={
            <Button component={Link} href="/health">
              {t("查看数据更新", "Open data status")}
            </Button>
          }
        />
      </Panel>
    );
  const allocations =
    view === "countries"
      ? objects(data.countryAllocation)
      : objects(
          view === "gics"
            ? data.gicsSubIndustryAllocation
            : data.industryAllocation,
        );
  const allocationLabel = (r: Record<string, unknown>) =>
    str(r.country ?? r.subIndustry ?? r.name ?? r.industry ?? r.label) || "—";
  const rankings = [
    {
      view: "countries" as const,
      title: t("国家", "Countries"),
      rows: objects(data.countryAllocation),
    },
    {
      view: "companies" as const,
      title: t("公司", "Companies"),
      rows: objects(data.positions),
    },
    {
      view: "sectors" as const,
      title: t("行业", "Industries"),
      rows: objects(data.industryAllocation),
    },
    {
      view: "gics" as const,
      title: t("GICS 子行业", "GICS sub-industries"),
      rows: objects(data.gicsSubIndustryAllocation),
    },
  ];
  return (
    <>
      <Panel>
        <div className="mx-metric-grid">
          <Metric
            label={t("底层证券", "Underlying securities")}
            value={number(data.underlyingCount)}
          />
          <Metric
            label={t("ETF 穿透覆盖", "ETF look-through coverage")}
            value={percent(data.lookthroughCoveragePct)}
          />
          <Metric
            label={t("GICS 分类覆盖", "GICS classification coverage")}
            value={percent(data.gicsCoveragePct)}
            help={t("已分类市值占适用 GICS 分类资产的比例。", "Classified value as a share of assets eligible for GICS classification.")}
          />
          <Metric
            label={t("ETF 投资市值", "ETF invested value")}
            value={currency(data.etfValueGbp)}
          />
        </div>
      </Panel>
      <Panel
        title={t("全组合敞口", "Portfolio-wide exposure")}
      >
        <div className="mx-exposure-rankings">
          {rankings.map((ranking) => {
            const label = (row: Record<string, unknown>) =>
              ranking.view === "companies"
                ? str(row.ticker) || str(row.name) || "—"
                : allocationLabel(row);
            const top = ranking.rows
              .filter((r) => numeric(r.allocationPct) != null)
              .sort((a, b) => Number(b.allocationPct) - Number(a.allocationPct))
              .slice(0, 3);
            return (
              <section
                key={ranking.view}
                className="mx-exposure-ranking"
                aria-label={ranking.title}
              >
                <h3>{ranking.title}</h3>
                <ol>
                  {top.map((row, index) => (
                    <li key={`${label(row)}-${index}`}>
                      <div>
                        <span
                          title={
                            ranking.view === "companies"
                              ? str(row.name)
                              : label(row)
                          }
                        >
                          {label(row)}
                        </span>
                        <strong>{percent(row.allocationPct)}</strong>
                      </div>
                      <span className="mx-rank-track" aria-hidden="true">
                        <i
                          style={{
                            width: `${Math.max(0, Math.min(100, Number(row.allocationPct) * 100))}%`,
                          }}
                        />
                      </span>
                    </li>
                  ))}
                </ol>
                {!top.length && (
                  <p className="mx-form-help">
                    {t("暂无分类记录", "No classified observations")}
                  </p>
                )}
                <button
                  className="mx-text-link"
                  aria-label={`${t("查看明细", "View details")} · ${ranking.title}`}
                  onClick={() => {
                    setView(ranking.view);
                    setSearch("");
                    setCountry("all");
                    setSector("all");
                    setOwnership("all");
                    setPage(1);
                    setSort("total");
                    requestAnimationFrame(() => {
                      detail.current?.focus({ preventScroll: true });
                      detail.current?.scrollIntoView({
                        behavior: "instant",
                        block: "start",
                      });
                    });
                  }}
                >
                  {t("查看明细", "View details")}
                  <ArrowRight size={15} />
                </button>
              </section>
            );
          })}
        </div>
      </Panel>
      <div
        ref={detail}
        tabIndex={-1}
        className="mx-exposure-detail"
        aria-label={t("穿透明细", "Exposure details")}
      >
        <Panel
          title={t("穿透明细", "Look-through details")}
          help={t(
            "把直接持有和基金内的同一公司合并，识别真正的集中度。",
            "Direct holdings and fund constituents are combined to reveal concentration.",
          )}
        >
          <Tabs
            label={t("穿透维度", "Exposure dimension")}
            value={view}
            onChange={setView}
            options={[
              { value: "companies", label: t("公司", "Companies") },
              { value: "countries", label: t("国家", "Countries") },
              { value: "sectors", label: t("行业", "Industries") },
              { value: "gics", label: t("GICS 子行业", "GICS sub-industries") },
              {
                value: "sources",
                label: t("来源与覆盖", "Sources & coverage"),
              },
            ]}
          />
          {view === "companies" ? (
            <>
              <div className="mx-toolbar" style={{ margin: "20px 0" }}>
                <TextInput
                  className="mx-search-input"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.currentTarget.value);
                    setPage(1);
                  }}
                  aria-label={t("搜索底层资产", "Search underlying assets")}
                  placeholder={t(
                    "公司、代码、ISIN 或行业…",
                    "Company, ticker, ISIN or industry…",
                  )}
                  leftSection={<MagnifyingGlass size={17} />}
                />
                <Select
                  aria-label={t("国家筛选", "Filter country")}
                  value={country}
                  onChange={(v) => {
                    setCountry(v ?? "all");
                    setPage(1);
                  }}
                  data={[
                    { value: "all", label: t("全部国家", "All countries") },
                    ...countries.map((c) => ({ value: c, label: c })),
                  ]}
                  searchable
                  w={170}
                />
              </div>
              <Group wrap="wrap" mb="lg">
                <Select
                  aria-label={t("行业筛选", "Filter sector")}
                  value={sector}
                  onChange={(v) => {
                    setSector(v ?? "all");
                    setPage(1);
                  }}
                  data={[
                    { value: "all", label: t("全部行业", "All sectors") },
                    ...sectors.map((v) => ({ value: v, label: v })),
                  ]}
                  searchable
                />
                <Select
                  aria-label={t("持有方式", "Ownership")}
                  value={ownership}
                  onChange={(v) => {
                    setOwnership(v ?? "all");
                    setPage(1);
                  }}
                  data={[
                    { value: "all", label: t("全部持有方式", "All ownership") },
                    { value: "direct", label: t("仅直接持有", "Direct only") },
                    {
                      value: "indirect",
                      label: t("仅基金内持有", "Funds only"),
                    },
                    {
                      value: "both",
                      label: t("直接与基金内都有", "Direct and funds"),
                    },
                  ]}
                />
                <Select
                  aria-label={t("敞口排序", "Sort exposure")}
                  value={sort}
                  onChange={(v) => {
                    setSort(v ?? "total");
                    setPage(1);
                  }}
                  data={[
                    { value: "total", label: t("总敞口优先", "Largest total") },
                    {
                      value: "direct",
                      label: t("直接持有优先", "Largest direct"),
                    },
                    {
                      value: "indirect",
                      label: t("基金内持有优先", "Largest indirect"),
                    },
                    { value: "name", label: t("名称 A–Z", "Name A–Z") },
                  ]}
                />
                <Button
                  variant="subtle"
                  onClick={() => {
                    setSearch("");
                    setCountry("all");
                    setSector("all");
                    setOwnership("all");
                    setPage(1);
                  }}
                >
                  {t("清除筛选", "Clear filters")}
                </Button>
                <span>
                  {rows.length} {t("个结果", "results")}
                </span>
              </Group>
              <div className="mx-mobile-holdings">
                {pageRows.map((p, i) => (
                  <button
                    key={p.entityId || i}
                    className="mx-holding-mobile"
                    onClick={() => setSelected(p)}
                  >
                    <div>
                      <Instrument
                        ticker={p.ticker ?? "—"}
                        name={p.name}
                        small
                      />
                      <span className="mx-row-value">
                        {currency(p.valueGbp)}
                        <small>{percent(p.allocationPct)}</small>
                      </span>
                    </div>
                    <footer>
                      <span>{p.country ?? "—"}</span>
                      <span>
                        {t("直接", "Direct")} {currency(p.directValueGbp)} ·{" "}
                        {t("基金", "Funds")} {currency(p.indirectValueGbp)}
                      </span>
                    </footer>
                  </button>
                ))}
              </div>
              {rows.length ? (
                <div
                  className="mx-table-wrap mx-desktop-holdings"
                  tabIndex={0}
                  role="region"
                  aria-label={t("数据表格", "Data table")}
                >
                  <table className="mx-table">
                    <thead>
                      <tr>
                        <th>{t("底层资产", "Underlying security")}</th>
                        <th>{t("国家", "Country")}</th>
                        <th className="mx-align-right">
                          {t("直接持有", "Direct")}
                        </th>
                        <th className="mx-align-right">
                          {t("基金内持有", "Via funds")}
                        </th>
                        <th className="mx-align-right">
                          {t("合计敞口", "Total exposure")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((p, i) => (
                        <tr key={p.entityId || p.name + i}>
                          <td>
                            <button
                              className="mx-table-button"
                              onClick={() => setSelected(p)}
                            >
                              <Instrument
                                ticker={p.ticker ?? "—"}
                                name={p.name}
                                small
                              />
                            </button>
                          </td>
                          <td>{p.country ?? "—"}</td>
                          <td className="mx-align-right">
                            {currency(p.directValueGbp)}
                          </td>
                          <td className="mx-align-right">
                            {currency(p.indirectValueGbp)}
                          </td>
                          <td className="mx-align-right">
                            <strong>{currency(p.valueGbp)}</strong>
                            <small>{percent(p.allocationPct)}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={t(
                    "没有匹配的底层资产",
                    "No matching underlying assets",
                  )}
                />
              )}
              {pages > 1 && (
                <Pagination
                  total={pages}
                  value={currentPage}
                  onChange={setPage}
                  withEdges
                  mt="md"
                  aria-label={t("底层资产分页", "Underlying asset pages")}
                  getControlProps={paginationLabels}
                />
              )}
            </>
          ) : view === "sources" ? (
            <Stack mt="lg" gap="lg">
              <Facts
                rows={[
                  [
                    t("已穿透市值", "Resolved value"),
                    currency(data.lookthroughValueGbp),
                  ],
                  [
                    t("已分类资产", "Classified assets"),
                    currency(data.gicsClassifiedValueGbp),
                  ],
                  [
                    t("待分类资产", "Awaiting classification"),
                    currency(data.gicsPendingValueGbp),
                  ],
                  [
                    t("不适用 GICS", "GICS not applicable"),
                    currency(data.gicsNotApplicableValueGbp),
                  ],
                  [t("现金", "Cash"), currency(data.cashValueGbp)],
                ]}
              />
              {objects(data.sources).map((source, i) => (
                <div className="mx-disclosure" key={i}>
                  <strong>
                    {str(source.ticker ?? source.etfTicker ?? source.source) ||
                      t("数据来源", "Data source")}
                  </strong>
                  <Facts
                    rows={[
                      [
                        t("数据日期", "As of"),
                        str(source.asOf ?? source.holdingsAsOf) || "—",
                      ],
                      [t("状态", "Status"), str(source.status) || "—"],
                      [
                        t("成分记录数", "Constituent records"),
                        number(source.holdingsCount, 0),
                      ],
                      [
                        t("已覆盖权重", "Resolved weight"),
                        number(source.weightTotalPct) + "%",
                      ],
                    ]}
                  />
                  {safeUrl(str(source.sourceUrl)) && (
                    <a
                      className="mx-text-link"
                      href={safeUrl(str(source.sourceUrl))}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("查看来源", "View source")}
                    </a>
                  )}
                </div>
              ))}
              <Freshness date={data.generatedAt} />
            </Stack>
          ) : (
            <div style={{ marginTop: 18 }}>
              <Group justify="space-between" mb="md">
                <span className="mx-form-help">
                  {chart === "pie" && allocations.length > 12
                    ? t("前 12 项与其余分类", "Top 12 and other categories")
                    : t("前 12 项", "Top 12")}
                </span>
                <Segments
                  label={t("配置图形", "Allocation chart")}
                  value={chart}
                  onChange={setChart}
                  options={[
                    { value: "rank", label: t("排名", "Rank") },
                    { value: "pie", label: t("组成", "Composition") },
                  ]}
                />
              </Group>
              {chart === "rank" ? (
                <AllocationRanking
                  rows={allocations.slice(0, 12).map((row) => ({
                    name: allocationLabel(row),
                    value: numeric(row.valueGbp),
                    weight: numeric(row.allocationPct),
                  }))}
                />
              ) : (
                <AllocationComposition
                  key={`${view}-${snapshot}`}
                  rows={allocations.map((row) => ({
                    name: allocationLabel(row),
                    value: numeric(row.valueGbp),
                    weight: numeric(row.allocationPct),
                  }))}
                />
              )}
              <EvidenceTable
                key={view}
                label={t("完整配置明细", "Complete allocation details")}
                rows={allocations}
                columns={[
                  { label: t("分类", "Category"), value: allocationLabel },
                  {
                    label: t("金额 · GBP", "Value · GBP"),
                    value: (r) => currency(r.valueGbp),
                    numeric: true,
                  },
                  {
                    label: t("权重", "Weight"),
                    value: (r) => percent(r.allocationPct),
                    numeric: true,
                  },
                ]}
              />
            </div>
          )}
        </Panel>
      </div>
      <Narrative snapshot={snapshot} lens="hidden_exposure" page="holdings" />
      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={t("穿透后的真实敞口", "Underlying exposure")}
      >
        {selected && (
          <Stack gap="lg">
            <Instrument ticker={selected.ticker ?? "—"} name={selected.name} />
            <Metric
              large
              label={t("合计敞口", "Total exposure")}
              value={currency(selected.valueGbp, "GBP", 2)}
            />
            <Facts
              rows={[
                [
                  t("直接持有", "Direct value"),
                  currency(selected.directValueGbp),
                ],
                [
                  t("基金内持有", "Indirect value"),
                  currency(selected.indirectValueGbp),
                ],
                [
                  t("组合占比", "Portfolio share"),
                  percent(selected.allocationPct),
                ],
                [t("国家", "Country"), selected.country ?? "—"],
                [
                  t("行业", "Industry"),
                  selected.gics?.subIndustryName ??
                    t("尚未分类", "Unclassified"),
                ],
                ["ISIN", selected.isin ?? "—"],
              ]}
            />
            <Panel title={t("通过这些基金持有", "Held through these funds")}>
              {objects(selected.etfContributors).length ? (
                objects(selected.etfContributors).map((c, i) => (
                  <Facts
                    key={i}
                    rows={[
                      [
                        str(c.etfTicker ?? c.ticker ?? c.name) || "—",
                        currency(c.valueGbp ?? c.contributionGbp),
                      ],
                    ]}
                  />
                ))
              ) : (
                <p className="mx-prose">
                  {t("无间接持仓来源。", "No indirect holding sources.")}
                </p>
              )}
            </Panel>
            {selected.ticker && (
              <Button
                component={Link}
                href={"/research?ticker=" + encodeURIComponent(selected.ticker)}
              >
                {t("进入证券研究", "Open security research")}
              </Button>
            )}
          </Stack>
        )}
      </Drawer>
    </>
  );
}
