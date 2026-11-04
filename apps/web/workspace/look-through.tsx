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
import { MagnifyingGlass } from "@phosphor-icons/react";
import Link from "./link";
import { useMemo, useState } from "react";
import { useLocale } from "@/components/locale-provider";
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
  Tag,
  useCopy,
} from "./foundation";
import { countryCode, countryName, industryName } from "./exposure-names";
import { SecurityPeek } from "./security-peek";
import { Narrative } from "./narrative";

/** Coverage below this is named; above it the page stays quiet. */
const COVERAGE_FLOOR = 0.98;

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
  const { locale } = useLocale();
  const paginationLabels = usePaginationLabels();
  const [view, setView] = useState<
    "companies" | "countries" | "sectors" | "gics" | "sources"
  >("companies");
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("all");
  const [selected, setSelected] = useState<LookthroughPosition | null>(null);
  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [sector, setSector] = useState("all");
  const [ownership, setOwnership] = useState("all");
  const [sort, setSort] = useState("total");
  const [chart, setChart] = useState("rank");
  const companyComposition = useMemo(() => companyAllocation(data), [data]);
  // "Taiwan" and "Taiwan Region" are one place; filters and totals use the country code.
  const place = (name: string | null | undefined) => countryCode(name) ?? name ?? "";
  const countryLabel = (name: string | null | undefined) => countryName(name, locale);
  const className = (name: string | null | undefined) => industryName(name, locale);
  const byLabel = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label, locale === "zh" ? "zh-CN" : "en-GB");
  const sectors = [
    ...new Set(
      data.positions
        .map((p) => p.gics?.sectorName)
        .filter((v): v is string => Boolean(v)),
    ),
  ]
    .map((value) => ({ value, label: className(value) }))
    .sort(byLabel);
  const countries = [
    ...new Map(
      data.positions
        .filter((p) => p.country)
        .map((p) => [place(p.country), { value: place(p.country), label: countryLabel(p.country) }]),
    ).values(),
  ].sort(byLabel);
  const filtered = Boolean(search.trim()) || country !== "all" || sector !== "all" || ownership !== "all";
  const rows = data.positions
    .filter(
      (p) =>
        (country === "all" || place(p.country) === country) &&
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
          className(p.gics?.sectorName),
          className(p.gics?.subIndustryName),
          countryLabel(p.country),
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
  // Large pages keep the ranking scannable; "show all" lifts paging with the same filters.
  const pageSize = 100;
  const pages = showAll ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages);
  const pageRows = showAll
    ? rows
    : rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const clearFilters = () => {
    setSearch("");
    setCountry("all");
    setSector("all");
    setOwnership("all");
    setPage(1);
  };
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
  const countryAllocation = [
    ...objects(data.countryAllocation)
      .reduce((merged, row) => {
        const key = place(str(row.country));
        const previous = merged.get(key);
        merged.set(
          key,
          previous
            ? {
                ...previous,
                valueGbp: (numeric(previous.valueGbp) ?? 0) + (numeric(row.valueGbp) ?? 0),
                allocationPct:
                  (numeric(previous.allocationPct) ?? 0) + (numeric(row.allocationPct) ?? 0),
              }
            : row,
        );
        return merged;
      }, new Map<string, Record<string, unknown>>())
      .values(),
  ].sort((a, b) => (numeric(b.valueGbp) ?? 0) - (numeric(a.valueGbp) ?? 0));
  const allocations =
    view === "countries"
      ? countryAllocation
      : objects(
          view === "gics"
            ? data.gicsSubIndustryAllocation
            : data.industryAllocation,
        );
  const allocationLabel = (r: Record<string, unknown>) =>
    r.country != null
      ? countryLabel(str(r.country))
      : className(str(r.subIndustry ?? r.name ?? r.industry ?? r.label)) || "—";
  const coverageLow = data.lookthroughCoveragePct < COVERAGE_FLOOR;
  const classificationLow = data.gicsCoveragePct < COVERAGE_FLOOR;
  return (
    <>
      {/* One quiet line: what the look-through covers and when it was taken. */}
      <div className="mx-exposure-basis">
        <span>
          {number(data.underlyingCount, 0)}
          {t(" 只底层证券", " underlying securities")}
        </span>
        {coverageLow && (
          <Tag tone="warn">
            {t("ETF 穿透覆盖 ", "ETF look-through ")}
            {percent(data.lookthroughCoveragePct)}
          </Tag>
        )}
        {classificationLow && (
          <Tag tone="warn">
            {t("GICS 分类覆盖 ", "GICS classified ")}
            {percent(data.gicsCoveragePct)}
          </Tag>
        )}
        <Freshness date={data.brokerAsOf || data.generatedAt} />
      </div>
      <Panel>
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
            {/* Filters on the left, the view switch on the right, one row. */}
            <div className="mx-toolbar" style={{ margin: "20px 0" }}>
              <Group gap="sm" wrap="wrap" className="mx-exposure-filters">
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
                    ...countries,
                  ]}
                  searchable
                />
                <Select
                  aria-label={t("行业筛选", "Filter sector")}
                  value={sector}
                  onChange={(v) => {
                    setSector(v ?? "all");
                    setPage(1);
                  }}
                  data={[
                    { value: "all", label: t("全部行业", "All sectors") },
                    ...sectors,
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
                {filtered && (
                  <>
                    <Button variant="subtle" onClick={clearFilters}>
                      {t("清除筛选", "Clear filters")}
                    </Button>
                    <span role="status">
                      {number(rows.length, 0)} / {number(data.positions.length, 0)}
                    </span>
                  </>
                )}
              </Group>
              <Segments
                label={t("公司视图", "Company view")}
                value={chart}
                onChange={setChart}
                options={[
                  { value: "rank", label: t("排名", "Rank") },
                  { value: "pie", label: t("组成", "Composition") },
                ]}
              />
            </div>
            {chart === "pie" && <AllocationComposition
              key={`companies-${snapshot}`}
              companies
              rows={companyComposition.rows}
              remainder={companyComposition.remainder}
            />}
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
                    <span>{countryLabel(p.country)}</span>
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
                aria-label={t("底层资产", "Underlying securities")}
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
                        <td>{countryLabel(p.country)}</td>
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
            {(pages > 1 || showAll) && (
              <div className="mx-exposure-paging">
                {pages > 1 && (
                  <nav aria-label={t("底层资产分页", "Underlying asset pages")}>
                    <Pagination
                      total={pages}
                      value={currentPage}
                      onChange={setPage}
                      withEdges
                      getControlProps={paginationLabels}
                    />
                  </nav>
                )}
                <Button
                  variant="subtle"
                  onClick={() => {
                    setShowAll(!showAll);
                    setPage(1);
                  }}
                >
                  {showAll
                    ? t("分页显示", "Show in pages")
                    : t("显示全部 ", "Show all ") + number(rows.length, 0)}
                </Button>
              </div>
            )}
          </>
        ) : view === "sources" ? (
          <Stack mt="lg" gap="lg">
            <Facts
              rows={[
                [
                  t("ETF 穿透覆盖", "ETF look-through coverage"),
                  percent(data.lookthroughCoveragePct),
                ],
                [
                  t("GICS 分类覆盖", "GICS classification coverage"),
                  percent(data.gicsCoveragePct),
                ],
                [t("ETF 投资市值", "ETF invested value"), currency(data.etfValueGbp)],
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
                [t("国家", "Country"), countryName(selected.country, locale)],
                [
                  t("行业", "Industry"),
                  selected.gics?.subIndustryName
                    ? industryName(selected.gics.subIndustryName, locale)
                    : t("尚未分类", "Unclassified"),
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
