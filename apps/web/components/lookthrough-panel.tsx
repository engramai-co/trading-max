"use client";

import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
  Pagination,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { ArrowSquareOut, Info, MagnifyingGlass } from "@phosphor-icons/react";
import { useMediaQuery } from "@mantine/hooks";
import type { EChartsOption } from "echarts";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { CompanyMark } from "@/components/company-mark";
import { ContextHelp } from "@/components/context-help";
import { useLocale } from "@/components/locale-provider";
import {
  browseLookthroughPositions,
  type LookthroughExposureFilter,
  lookthroughExposureFilters,
  type LookthroughSort,
  lookthroughSorts,
  lookthroughSector,
  unclassifiedSector,
} from "@/lib/lookthrough-browse";
import type {
  LookthroughCountry,
  LookthroughData,
  LookthroughGicsSubIndustry,
  LookthroughIndustry,
  LookthroughPosition,
} from "@/lib/types";
import { replaceUrlState } from "@/lib/url-state";
import { categoricalChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import { formatCurrency } from "@/ui/formatters";

type Slice = { allocationPct: number; label: string; valueGbp: number };
type ExposureView = "pie" | "ranking";

const DESKTOP_POSITION_PAGE_SIZE = 50;
const MOBILE_POSITION_PAGE_SIZE = 20;
const RANKING_PREVIEW_SIZE = 5;
const rankingColours = ["blue", "cyan", "indigo", "grape", "teal", "violet"];

function formatAllocationPercent(value: number, locale: "en" | "zh") {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-GB", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.abs(value));
}

function rankSlices(rows: Slice[]): Slice[] {
  return rows
    .filter((row) => Number.isFinite(row.valueGbp) && row.valueGbp > 0)
    .sort((left, right) => right.valueGbp - left.valueGbp);
}

function summarizeSlices(rows: Slice[], otherLabel: string, limit: number): Slice[] {
  const ranked = rankSlices(rows);
  const remainder = ranked.slice(limit);
  const remainderValue = remainder.reduce((sum, row) => sum + row.valueGbp, 0);
  const remainderAllocation = remainder.reduce((sum, row) => sum + row.allocationPct, 0);
  return remainderValue > 0
    ? [
        ...ranked.slice(0, limit),
        { allocationPct: remainderAllocation, label: otherLabel, valueGbp: remainderValue },
      ]
    : ranked;
}

function ExposurePie({
  description,
  limit,
  meta,
  otherLabel,
  rows,
  title,
}: {
  description: string;
  limit: number;
  meta?: string;
  otherLabel: string;
  rows: Slice[];
  title: string;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const mobile = useMediaQuery("(max-width: 48em)");
  const [legendExpanded, setLegendExpanded] = useState(false);
  const summarized = useMemo(
    () => summarizeSlices(rows, otherLabel, limit),
    [limit, otherLabel, rows],
  );
  const option = useMemo<EChartsOption | null>(() => summarized.length ? {
    color: [...categoricalChartColours],
    series: [{
      data: summarized.map((row) => ({ name: row.label, value: row.allocationPct * 100 })),
      emphasis: { focus: "self" },
      label: { show: false },
      labelLine: { show: false },
      radius: ["52%", "78%"],
      type: "pie",
    }],
    tooltip: {
      trigger: "item",
      valueFormatter: (value) => formatAllocationPercent(Number(value) / 100, locale),
    },
  } : null, [locale, summarized]);
  const chartRef = useECharts(option);
  const compactLegend = mobile && !legendExpanded && summarized.length > 4;
  const legendRows = compactLegend
    ? [...summarized.slice(0, 3), summarized[summarized.length - 1]]
    : summarized;
  const top = summarized[0];

  return (
    <Paper component="section" p={{ base: "md", sm: "lg" }} withBorder>
      <Stack gap="md">
        <div>
          <Group gap="xs" wrap="nowrap">
            <Title order={2} size="h3">{title}</Title>
            <ContextHelp
              content={description}
              label={zh ? `${title}说明` : `About ${title}`}
              title={title}
            />
          </Group>
          {top ? (
            <Text c="dimmed" mt={4} size="sm">
              {zh ? "占比最高" : "Largest"} · {top.label} {formatAllocationPercent(top.allocationPct, locale)}
            </Text>
          ) : null}
        </div>
        <Box aria-label={title} h={mobile ? 190 : 220} role="img">
          <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
        </Box>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" verticalSpacing="xs">
          {legendRows.map((row) => {
            const colourIndex = summarized.indexOf(row);
            return (
              <Group gap="xs" key={row.label} wrap="nowrap">
                <Box
                  aria-hidden="true"
                  style={{
                    backgroundColor: categoricalChartColours[colourIndex % categoricalChartColours.length],
                    borderRadius: "50%",
                    flexShrink: 0,
                    height: 10,
                    width: 10,
                  }}
                />
                <Text flex={1} lineClamp={1} size="sm" title={row.label}>{row.label}</Text>
                <Text fw={700} size="sm">{formatAllocationPercent(row.allocationPct, locale)}</Text>
              </Group>
            );
          })}
        </SimpleGrid>
        {meta ? <Text c="dimmed" size="xs">{meta}</Text> : null}
        {mobile && summarized.length > 4 ? (
          <Button onClick={() => setLegendExpanded((value) => !value)} size="xs" variant="subtle">
            {legendExpanded
              ? zh ? "收起图例" : "Collapse legend"
              : zh ? "展开完整图例" : "Expand legend"}
          </Button>
        ) : null}
      </Stack>
    </Paper>
  );
}

function ExposureRanking({
  description,
  embedded = false,
  limit = RANKING_PREVIEW_SIZE,
  meta,
  rows,
  title,
}: {
  description: string;
  embedded?: boolean;
  limit?: number;
  meta?: string;
  rows: Slice[];
  title: string;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [expanded, setExpanded] = useState(false);
  const ranked = useMemo(() => rankSlices(rows), [rows]);
  const visible = expanded ? ranked : ranked.slice(0, limit);
  const top = ranked[0];
  const content = (
    <Stack gap="md">
      <div>
        <Group gap="xs" wrap="nowrap">
          <Title order={2} size="h3">{title}</Title>
          <ContextHelp
            content={description}
            label={zh ? `${title}说明` : `About ${title}`}
            title={title}
          />
        </Group>
        {top ? (
          <Text c="dimmed" mt={4} size="sm">
            {zh ? "最大敞口" : "Largest exposure"} · {top.label} {formatAllocationPercent(top.allocationPct, locale)}
          </Text>
        ) : null}
      </div>
      <Stack gap="sm">
        {visible.map((row, index) => (
          <div key={row.label}>
            <Group gap="sm" justify="space-between" mb={5} wrap="nowrap">
              <Text lineClamp={1} size="sm" title={row.label}>{row.label}</Text>
              <Group gap="sm" wrap="nowrap">
                <Text c="dimmed" size="xs">{formatCurrency(row.valueGbp, locale, "GBP", 0)}</Text>
                <Text fw={750} size="sm">{formatAllocationPercent(row.allocationPct, locale)}</Text>
              </Group>
            </Group>
            <Progress color={rankingColours[index % rankingColours.length]} size="sm" value={Math.min(100, Math.abs(row.allocationPct) * 100)} />
          </div>
        ))}
      </Stack>
      {meta ? <Text c="dimmed" size="xs">{meta}</Text> : null}
      {ranked.length > limit ? (
        <Button onClick={() => setExpanded((value) => !value)} size="xs" variant="subtle">
          {expanded
            ? zh ? "收起次要分类" : "Hide secondary categories"
            : zh ? `查看其余 ${ranked.length - limit} 个分类` : `Show ${ranked.length - limit} more categories`}
        </Button>
      ) : null}
    </Stack>
  );
  return embedded
    ? <Box component="section" py="sm">{content}</Box>
    : <Paper component="section" p={{ base: "md", sm: "lg" }} withBorder>{content}</Paper>;
}

export function LookthroughPanel({ data }: { data: LookthroughData }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const mobile = useMediaQuery("(max-width: 48em)");
  const pageSize = mobile ? MOBILE_POSITION_PAGE_SIZE : DESKTOP_POSITION_PAGE_SIZE;
  const params = useSearchParams();
  const requestedExposure = params.get("ltExposure") as LookthroughExposureFilter | null;
  const requestedSort = params.get("ltSort") as LookthroughSort | null;
  const requestedExposureView = params.get("ltChart") as ExposureView | null;
  const requestedPage = Number(params.get("ltPage") ?? 1);
  const [query, setQuery] = useState(params.get("ltq") ?? "");
  const [country, setCountry] = useState(params.get("ltCountry") ?? "all");
  const [sector, setSector] = useState(params.get("ltSector") ?? "all");
  const [exposure, setExposure] = useState<LookthroughExposureFilter>(
    lookthroughExposureFilters.includes(requestedExposure as LookthroughExposureFilter)
      ? requestedExposure!
      : "all",
  );
  const [sort, setSort] = useState<LookthroughSort>(
    lookthroughSorts.includes(requestedSort as LookthroughSort) ? requestedSort! : "exposure",
  );
  const [exposureView, setExposureView] = useState<ExposureView>(
    requestedExposureView === "pie" ? "pie" : "ranking",
  );
  const [page, setPage] = useState(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const positions = useMemo(
    () => browseLookthroughPositions(data.positions, query, { country, exposure, sector, sort }),
    [country, data.positions, exposure, query, sector, sort],
  );
  const totalPages = Math.max(1, Math.ceil(positions.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const firstRow = positions.length ? (safePage - 1) * pageSize + 1 : 0;
  const lastRow = Math.min(safePage * pageSize, positions.length);
  const visiblePositions = positions.slice(firstRow ? firstRow - 1 : 0, lastRow);
  const countries = useMemo(
    () => Array.from(new Set(data.positions.map((position) => position.country ?? "__unknown__"))).sort(),
    [data.positions],
  );
  const sectors = useMemo(
    () => Array.from(new Set(data.positions.map(lookthroughSector))).sort(),
    [data.positions],
  );
  const hasFilters = Boolean(query) || country !== "all" || sector !== "all" || exposure !== "all" || sort !== "exposure";

  const countryRows = data.countryAllocation.map((row: LookthroughCountry) => ({
    allocationPct: row.allocationPct,
    label: row.country,
    valueGbp: row.valueGbp,
  }));
  const industryRows = data.industryAllocation.map((row: LookthroughIndustry) => ({
    allocationPct: row.allocationPct,
    label: row.industry,
    valueGbp: row.valueGbp,
  }));
  const gicsRows = (data.gicsSubIndustryAllocation ?? []).map((row: LookthroughGicsSubIndustry) => ({
    allocationPct: row.allocationPct,
    label: row.classificationStatus === "not-applicable"
      ? zh ? "其他" : "Other"
      : row.classificationStatus === "pending-identity"
        ? zh ? "未识别证券" : "Unidentified securities"
        : row.classificationStatus === "pending-classification"
          ? zh ? "未分类" : "Unclassified"
          : row.subIndustry,
    valueGbp: row.valueGbp,
  }));
  const concentrationRows = data.positions.map((row: LookthroughPosition) => ({
    allocationPct: row.allocationPct,
    label: row.ticker ?? row.name,
    valueGbp: row.valueGbp,
  }));
  const topEightPct = concentrationRows.slice(0, 8).reduce((sum, row) => sum + row.allocationPct, 0);

  function setPageState(next: number) {
    setPage(next);
    replaceUrlState({ ltPage: next === 1 ? null : String(next) });
  }

  function updateQuery(next: string) {
    setQuery(next);
    setPage(1);
    replaceUrlState({ ltq: next.trim() || null, ltPage: null });
  }

  function updateCountry(next: string) {
    setCountry(next);
    setPage(1);
    replaceUrlState({ ltCountry: next === "all" ? null : next, ltPage: null });
  }

  function updateSector(next: string) {
    setSector(next);
    setPage(1);
    replaceUrlState({ ltSector: next === "all" ? null : next, ltPage: null });
  }

  function updateExposure(next: LookthroughExposureFilter) {
    setExposure(next);
    setPage(1);
    replaceUrlState({ ltExposure: next === "all" ? null : next, ltPage: null });
  }

  function updateSort(next: LookthroughSort) {
    setSort(next);
    setPage(1);
    replaceUrlState({ ltSort: next === "exposure" ? null : next, ltPage: null });
  }

  function updateExposureView(next: ExposureView) {
    setExposureView(next);
    replaceUrlState({ ltChart: next === "ranking" ? null : next });
  }

  function clearFilters() {
    setQuery("");
    setCountry("all");
    setSector("all");
    setExposure("all");
    setSort("exposure");
    setPage(1);
    replaceUrlState({
      ltCountry: null,
      ltExposure: null,
      ltPage: null,
      ltq: null,
      ltSector: null,
      ltSort: null,
    });
  }

  if (!data.available) {
    return (
      <Alert color="yellow" icon={<Info aria-hidden="true" size={18} />} title={zh ? "暂时无法查看 ETF 持仓" : "ETF holdings are temporarily unavailable"}>
        {zh ? "你仍可以查看券商持仓。" : "You can still view your broker positions."}
      </Alert>
    );
  }

  return (
    <Stack gap="xl">
      <section aria-labelledby="lookthrough-lenses-title">
        <Group align="flex-end" justify="space-between" mb="md" wrap="wrap">
          <div>
            <Title id="lookthrough-lenses-title" order={2}>{zh ? "组合敞口" : "Portfolio exposure"}</Title>
            <Text c="dimmed" mt={2} size="sm">
              {zh
                ? `合并 Invest 与 ISA · ${data.sources.length} 只 ETF · ${data.underlyingCount.toLocaleString("zh-CN")} 个底层持仓`
                : `Invest + ISA · ${data.sources.length} ETFs · ${data.underlyingCount.toLocaleString("en-GB")} underlying holdings`}
            </Text>
          </div>
          <SegmentedControl
            aria-label={zh ? "图表样式" : "Chart style"}
            className="tm-performance-selector"
            color="brand"
            data={[
              { label: zh ? "排名" : "Ranking", value: "ranking" },
              { label: zh ? "饼图" : "Pie", value: "pie" },
            ]}
            onChange={(value) => updateExposureView(value as ExposureView)}
            size="xs"
            value={exposureView}
          />
        </Group>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {exposureView === "pie" ? (
            <ExposurePie
              description={zh ? "占已投资资产；按风险国家与基金官方地域。" : "Share of invested assets by country of risk and official fund geography."}
              limit={5}
              otherLabel={zh ? "其他国家" : "Other countries"}
              rows={countryRows}
              title={zh ? "国家分布" : "Country exposure"}
            />
          ) : (
            <ExposureRanking
              description={zh ? "占已投资资产；按风险国家与基金官方地域。" : "Share of invested assets by country of risk and official fund geography."}
              limit={mobile ? 3 : 5}
              rows={countryRows}
              title={zh ? "国家分布" : "Country exposure"}
            />
          )}
          {exposureView === "pie" ? (
            <ExposurePie
              description={zh ? "同一家公司在直接持仓和 ETF 中的敞口会合并计算。完整名单见下方。" : "Direct and ETF holdings in the same company are combined. See the full list below."}
              limit={7}
              meta={`Top 8 · ${formatAllocationPercent(topEightPct, locale)}`}
              otherLabel={zh ? "其他个股" : "Other companies"}
              rows={concentrationRows}
              title={zh ? "个股分布" : "Company exposure"}
            />
          ) : (
            <ExposureRanking
              description={zh ? "同一家公司在直接持仓和 ETF 中的敞口会合并计算。完整名单见下方。" : "Direct and ETF holdings in the same company are combined. See the full list below."}
              limit={mobile ? 3 : 5}
              meta={`Top 8 · ${formatAllocationPercent(topEightPct, locale)}`}
              rows={concentrationRows.slice(0, 12)}
              title={zh ? "个股分布" : "Company exposure"}
            />
          )}
          {exposureView === "pie" ? (
            <ExposurePie
              description={zh ? "占已投资资产；基金官方板块与直接持仓 GICS 板块。" : "Share of invested assets using official fund sectors and direct-holding GICS sectors."}
              limit={5}
              otherLabel={zh ? "其他板块" : "Other sectors"}
              rows={industryRows}
              title={zh ? "板块分布" : "Sector exposure"}
            />
          ) : (
            <ExposureRanking
              description={zh ? "占已投资资产；基金官方板块与直接持仓 GICS 板块。" : "Share of invested assets using official fund sectors and direct-holding GICS sectors."}
              limit={mobile ? 3 : 5}
              rows={industryRows}
              title={zh ? "板块分布" : "Sector exposure"}
            />
          )}
          {exposureView === "pie" ? (
            <ExposurePie
              description={zh ? "未识别或尚未分类的持仓会单独列出。" : "Unidentified and unclassified holdings are listed separately."}
              limit={5}
              meta={`${zh ? "股票分类覆盖率" : "Equity classification coverage"} ${formatAllocationPercent(data.gicsCoveragePct ?? 0, locale)}`}
              otherLabel={zh ? "其他子行业" : "Other sub-industries"}
              rows={gicsRows}
              title={zh ? "GICS 子行业" : "GICS sub-industries"}
            />
          ) : (
            <ExposureRanking
              description={zh ? "未识别或尚未分类的持仓会单独列出。" : "Unidentified and unclassified holdings are listed separately."}
              limit={mobile ? 3 : 5}
              meta={`${zh ? "股票分类覆盖率" : "Equity classification coverage"} ${formatAllocationPercent(data.gicsCoveragePct ?? 0, locale)}`}
              rows={gicsRows}
              title={zh ? "GICS 子行业" : "GICS sub-industries"}
            />
          )}
        </SimpleGrid>
      </section>

      <Paper component="section" p={{ base: "md", sm: "lg" }} withBorder>
        <Stack gap="lg">
          <div>
            <Title id="underlying-table-title" order={2}>{zh ? "底层持仓" : "Underlying holdings"}</Title>
          </div>

          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
            <TextInput
              aria-label={zh ? "搜索底层持仓" : "Search underlying holdings"}
              label={zh ? "搜索" : "Search"}
              leftSection={<MagnifyingGlass aria-hidden="true" size={17} />}
              onChange={(event) => updateQuery(event.currentTarget.value)}
              placeholder={zh ? "Ticker、公司、ISIN 或行业" : "Ticker, company, ISIN, or sector"}
              rightSection={query ? <CloseButton aria-label={zh ? "清除穿透搜索" : "Clear look-through search"} onClick={() => updateQuery("")} size="sm" /> : null}
              rightSectionPointerEvents="all"
              value={query}
            />
            <Select
              allowDeselect={false}
              data={[
                { label: zh ? "所有国家" : "All countries", value: "all" },
                ...countries.map((value) => ({ label: value === "__unknown__" ? zh ? "国家未知" : "Unknown country" : value, value })),
              ]}
              label={zh ? "国家" : "Country"}
              onChange={(value) => updateCountry(value ?? "all")}
              searchable
              value={country}
            />
            <Select
              allowDeselect={false}
              data={[
                { label: zh ? "所有板块" : "All sectors", value: "all" },
                ...sectors.map((value) => ({ label: value === unclassifiedSector ? zh ? "未分类" : "Unclassified" : value, value })),
              ]}
              label={zh ? "板块" : "Sector"}
              onChange={(value) => updateSector(value ?? "all")}
              searchable
              value={sector}
            />
            <Select
              allowDeselect={false}
              data={[
                { label: zh ? "全部持有方式" : "All holdings", value: "all" },
                { label: zh ? "直接持有" : "Direct", value: "direct" },
                { label: zh ? "仅通过 ETF" : "ETF only", value: "indirect" },
                { label: zh ? "直接持有 + ETF" : "Direct + ETF", value: "mixed" },
              ]}
              label={zh ? "持有方式" : "Holding type"}
              onChange={(value) => updateExposure(value as LookthroughExposureFilter)}
              value={exposure}
            />
            <Select
              allowDeselect={false}
              data={[
                { label: zh ? "总敞口：高到低" : "Exposure: high to low", value: "exposure" },
                { label: zh ? "直接敞口：高到低" : "Direct: high to low", value: "direct" },
                { label: zh ? "间接敞口：高到低" : "Indirect: high to low", value: "indirect" },
                { label: zh ? "公司名称：A–Z" : "Company: A–Z", value: "name" },
              ]}
              label={zh ? "排序" : "Sort"}
              onChange={(value) => updateSort(value as LookthroughSort)}
              value={sort}
            />
          </SimpleGrid>

          <Group justify="space-between" wrap="wrap">
            <Text aria-live="polite" c="dimmed" size="sm">
              {positions.length
                ? zh ? `显示第 ${firstRow}–${lastRow} 项，共 ${positions.length} 项` : `Showing ${firstRow}–${lastRow} of ${positions.length}`
                : zh ? "没有匹配的底层持仓" : "No matching underlying holdings"}
            </Text>
            {hasFilters ? <Button onClick={clearFilters} size="xs" variant="subtle">{zh ? "清除筛选" : "Clear filters"}</Button> : null}
          </Group>

          {visiblePositions.length ? (
            <>
              <Stack aria-label={zh ? "底层持仓列表" : "Underlying holdings list"} gap="xs" hiddenFrom="sm">
                {visiblePositions.map((position) => (
                  <UnderlyingMobileRow key={position.entityId || position.isin || `${position.ticker}-${position.name}`} locale={locale} position={position} />
                ))}
              </Stack>
              <Table.ScrollContainer
                minWidth={900}
                visibleFrom="sm"
                scrollAreaProps={{ viewportProps: { "aria-label": zh ? "底层个股敞口表" : "Underlying exposure table", tabIndex: 0 } }}
              >
                <Table highlightOnHover stickyHeader>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{zh ? "证券" : "Security"}</Table.Th>
                      <Table.Th>{zh ? "国家 / 板块" : "Country / sector"}</Table.Th>
                      <Table.Th ta="right">{zh ? "直接" : "Direct"}</Table.Th>
                      <Table.Th ta="right">{zh ? "间接" : "Indirect"}</Table.Th>
                      <Table.Th ta="right">{zh ? "总敞口" : "Exposure"}</Table.Th>
                      <Table.Th ta="right">{zh ? "占比" : "Weight"}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {visiblePositions.map((position) => (
                      <Table.Tr key={position.entityId || position.isin || `${position.ticker}-${position.name}`}>
                        <Table.Td>
                          <Group gap="sm" wrap="nowrap">
                            <CompanyMark name={position.name} ticker={position.ticker ?? position.name.slice(0, 2)} />
                            <div>
                              <Text fw={700}>{position.ticker ?? "—"}</Text>
                              <Text c="dimmed" lineClamp={1} size="xs" title={position.name}>{position.name}</Text>
                            </div>
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{position.country ?? "—"}</Text>
                          <Text c="dimmed" lineClamp={1} size="xs" title={position.gics?.sectorName ?? undefined}>{position.gics?.sectorName ?? (zh ? "未分类" : "Unclassified")}</Text>
                        </Table.Td>
                        <Table.Td ta="right">{formatCurrency(position.directValueGbp, locale, "GBP", 0)}</Table.Td>
                        <Table.Td ta="right">{formatCurrency(position.indirectValueGbp, locale, "GBP", 0)}</Table.Td>
                        <Table.Td fw={750} ta="right">{formatCurrency(position.valueGbp, locale, "GBP", 0)}</Table.Td>
                        <Table.Td fw={700} ta="right">{formatAllocationPercent(position.allocationPct, locale)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
              {totalPages > 1 ? (
                <Group justify="center">
                  <Pagination
                    aria-label={zh ? "底层持仓分页" : "Underlying holdings pages"}
                    boundaries={1}
                    onChange={setPageState}
                    siblings={1}
                    total={totalPages}
                    value={safePage}
                    withEdges
                  />
                </Group>
              ) : null}
            </>
          ) : (
            <Stack align="center" gap="xs" py="xl">
              <Title order={3} size="h4">{zh ? "没有匹配的底层持仓" : "No matching underlying holdings"}</Title>
              <Text c="dimmed" ta="center">{zh ? "清除搜索或筛选，查看全部持仓。" : "Clear the search or filters to view all holdings."}</Text>
              <Button onClick={clearFilters} variant="light">{zh ? "清除筛选" : "Clear filters"}</Button>
            </Stack>
          )}
        </Stack>
      </Paper>

      <Accordion variant="contained">
        <Accordion.Item value="sources">
          <Accordion.Control>
            <Group justify="space-between" pr="md">
              <Text fw={700}>{zh ? "ETF 数据来源" : "ETF data sources"}</Text>
              <Badge color="gray" variant="light">{data.sources.length}</Badge>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              {data.sources.map((source) => (
                <Group align="flex-start" justify="space-between" key={`${source.ticker}-${source.asOf}`} wrap="wrap">
                  <div>
                    <Group gap="xs">
                      <Text fw={700}>{source.ticker}</Text>
                      {source.status === "unavailable" ? <Badge color="yellow" size="xs" variant="light">{zh ? "暂不可用" : "Unavailable"}</Badge> : null}
                    </Group>
                    <Text c="dimmed" size="xs">
                      {source.holdingsCount.toLocaleString(locale === "zh" ? "zh-CN" : "en-GB")} {zh ? "项成分" : "constituents"} · {zh ? "截至" : "as of"} {source.asOf}
                    </Text>
                  </div>
                  <Anchor href={source.sourceUrl} rel="noreferrer" size="sm" target="_blank">
                    {zh ? "查看基金页面" : "View fund page"} <ArrowSquareOut aria-hidden="true" size={14} />
                  </Anchor>
                </Group>
              ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function UnderlyingMobileRow({ locale, position }: { locale: "zh" | "en"; position: LookthroughPosition }) {
  const zh = locale === "zh";
  return (
    <Paper p="sm" withBorder>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" miw={0} wrap="nowrap">
            <CompanyMark name={position.name} size={38} ticker={position.ticker ?? position.name.slice(0, 2)} />
            <div style={{ minWidth: 0 }}>
              <Text fw={750}>{position.ticker ?? "—"}</Text>
              <Text c="dimmed" lineClamp={2} size="xs">{position.name}</Text>
            </div>
          </Group>
          <div style={{ flexShrink: 0, textAlign: "right" }}>
            <Text fw={800}>{formatCurrency(position.valueGbp, locale, "GBP", 0)}</Text>
            <Text c="dimmed" size="xs">{formatAllocationPercent(position.allocationPct, locale)}</Text>
          </div>
        </Group>
        <details className="tm-lookthrough-row-details">
          <summary>{zh ? "查看持仓构成" : "View holding breakdown"}</summary>
          <SimpleGrid cols={2} mt="sm">
            <MobileDatum label={zh ? "直接" : "Direct"} value={formatCurrency(position.directValueGbp, locale, "GBP", 0)} />
            <MobileDatum label={zh ? "ETF 间接" : "ETF indirect"} value={formatCurrency(position.indirectValueGbp, locale, "GBP", 0)} />
            <MobileDatum label={zh ? "国家" : "Country"} value={position.country ?? "—"} />
            <MobileDatum label={zh ? "板块" : "Sector"} value={position.gics?.sectorName ?? (zh ? "未分类" : "Unclassified")} />
          </SimpleGrid>
        </details>
      </Stack>
    </Paper>
  );
}

function MobileDatum({ label, value }: { label: string; value: string }) {
  return <div><Text c="dimmed" size="xs">{label}</Text><Text fw={700} size="sm">{value}</Text></div>;
}
