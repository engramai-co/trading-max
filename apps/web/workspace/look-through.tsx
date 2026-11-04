"use client";

import {
  Button,
  Drawer,
  Group,
  Pagination,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "./link";
import { useMemo, useRef, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { LookthroughData, LookthroughPosition } from "@/lib/types";
import { EvidenceTable, usePaginationLabels } from "./evidence-table";
import { AllocationComposition } from "./allocation-composition";
import { AllocationRanking } from "./allocation-ranking";
import { companyAllocation } from "./company-allocation";
import { currency, number, objects, percent, safeUrl, str } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import {
  Empty,
  Facts,
  Freshness,
  Instrument,
  Metric,
  Panel,
  Pending,
  QueryError,
  Segments,
  Tabs,
  useCopy,
} from "./foundation";
import { SecurityPeek } from "./security-peek";
import { Narrative } from "./narrative";

export function Lookthrough() {
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
  const companyComposition = useMemo(() => companyAllocation(data), [data]);
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
                <h3>
                  <button
                    type="button"
                    className="mx-ranking-link"
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
                    {ranking.title}
                    <ArrowRight size={14} />
                  </button>
                </h3>
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
              <Group justify="flex-end" mt="lg">
                <Segments
                  label={t("公司视图", "Company view")}
                  value={chart}
                  onChange={setChart}
                  options={[
                    { value: "rank", label: t("排名", "Rank") },
                    { value: "pie", label: t("组成", "Composition") },
                  ]}
                />
              </Group>
              {chart === "pie" && <AllocationComposition
                key={`companies-${snapshot}`}
                companies
                rows={companyComposition.rows}
                remainder={companyComposition.remainder}
              />}
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
                {(search || country !== "all" || sector !== "all" || ownership !== "all") && (
                  <span>
                    {rows.length} / {data.positions.length}
                  </span>
                )}
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
                              <SecurityPeek
                                ticker={p.ticker}
                                position={{ valueGbp: p.valueGbp, weightPct: p.allocationPct, label: t("敞口", "Exposure") }}
                              >
                                <Instrument
                                  ticker={p.ticker ?? "—"}
                                  name={p.name}
                                  small
                                />
                              </SecurityPeek>
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
                      [
                        t("状态", "Status"),
                        (numeric(source.unweightedHoldingsCount) ?? 0) > 0
                          ? t("部分记录未提供权重", "Some positions have no reported weight")
                          : source.status === "verified"
                            ? t("已核验", "Verified")
                            : t("暂不可用", "Unavailable"),
                      ],
                      [t("发行商", "Issuer"), str(source.issuer) || "—"],
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
