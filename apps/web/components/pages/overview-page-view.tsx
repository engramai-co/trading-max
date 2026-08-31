"use client";

import {
  Alert,
  Badge,
  Box,
  Card,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import type { EChartsOption } from "echarts";
import {
  ArrowRight,
  CaretDown,
  ChartDonut,
  ClockCounterClockwise,
  Flask,
  Pulse,
  TrendDown,
  TrendUp,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { CompanyMark } from "@/components/company-mark";
import { LensContent, LensError, LensSkeleton } from "@/components/lens-state";
import { Localized, useLocale } from "@/components/locale-provider";
import { LocalMockReveal } from "@/components/local-mock-reveal";
import { PageHeader } from "@/components/page-header";
import { AllocationChart } from "@/components/portfolio-charts";
import { StatusChip } from "@/components/status-chip";
import { TimelineCoverage } from "@/components/timeline-coverage";
import {
  gapBridgeSegments,
  latestNaturalDayIntradayPoints,
  naturalCalendarTimeline,
  summarizeTimelineCoverage,
} from "@/lib/chart-domain";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { gbp, pct } from "@/lib/format";
import {
  mockIntradayMoneyNav,
  mockMoneyNav,
  mockOutageIntradayMoneyNav,
} from "@/lib/mock-money-chart";
import type {
  AccountSummary,
  DashboardLens,
  Holding,
  NavPoint,
  OverviewReviewSummary,
} from "@/lib/types";
import { useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import { formatCurrency, formatDate } from "@/ui/formatters";

type PortfolioScope = "invest-isa" | "invest" | "isa" | "with-cfd";
type NavValueKey = "total" | "invest" | "isa" | "household";
type MetricTone = "negative" | "positive";
type HeroMetric = { label: React.ReactNode; tone?: MetricTone; value: string };
type OverviewAccountRow = Pick<AccountSummary, "cashGbp" | "dailyReturn" | "name" | "totalValueGbp" | "twr" | "unrealizedPnlGbp"> & { code: "A" | "B" };
type CfdStatus = { accountStatus: "active" | "retired"; isStale: boolean };

const portfolioScopes: PortfolioScope[] = ["invest-isa", "invest", "isa", "with-cfd"];

function usePortfolioScope(includeCfd: boolean) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const requestedScope = searchParams.get("scope");
  const scope = portfolioScopes.includes(requestedScope as PortfolioScope)
    && (includeCfd || requestedScope !== "with-cfd")
    ? requestedScope as PortfolioScope
    : "invest-isa";
  const setScope = useCallback((nextScope: PortfolioScope) => {
    const nextParams = new URLSearchParams(search);
    if (nextScope === "invest-isa") nextParams.delete("scope");
    else nextParams.set("scope", nextScope);
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, search]);

  return [scope, setScope] as const;
}

export function OverviewPageView() {
  const params = useSearchParams();
  const mockVariant = params.get("mock");
  const mockMode = process.env.NODE_ENV !== "production"
    && ["hero-v2", "hero-single", "hero-gap"].includes(mockVariant ?? "");
  const lens = useDashboardLens("overview", undefined, !mockMode);

  return (
    <Stack className="tm-overview-page" gap="xl">
      <PageHeader
        actions={mockMode ? (
          <Badge color="blue">Synthetic mock · local only</Badge>
        ) : lens.data ? (
          <Group>
            <StatusChip label={<Localized zh="账户" en="Accounts" />} tone="good" value={lens.data.brokerAsOf} />
            <StatusChip label={<Localized zh="研究" en="Research" />} tone="warn" value={lens.data.researchAsOf} />
          </Group>
        ) : undefined}
        description={<Localized zh="账户价值、持仓与近期变化。" en="Account value, holdings, and recent changes." />}
        title={<Localized zh="账户概览" en="Portfolio overview" />}
      />
      {mockMode ? (
        <LocalMockReveal>
          <OverviewHeroMock
            outage={mockVariant === "hero-gap"}
            singlePoint={mockVariant === "hero-single"}
          />
        </LocalMockReveal>
      ) : null}
      {!mockMode && lens.isPending ? <LensSkeleton cards={2} height={420} /> : null}
      {!mockMode && lens.isError ? <LensError retry={() => void lens.refetch()} /> : null}
      {!mockMode && lens.data ? <LensContent><OverviewLens data={lens.data} /></LensContent> : null}
    </Stack>
  );
}

function OverviewHeroMock({
  outage = false,
  singlePoint = false,
}: {
  outage?: boolean;
  singlePoint?: boolean;
}) {
  const [scope, setScope] = usePortfolioScope(true);
  const { locale } = useLocale();
  const latest = mockMoneyNav.at(-1)!;
  const value = Number(latest.total ?? 0);
  const cash = 915;
  const mockHoldings: Holding[] = [
    { account: "A", allocationPct: 0.218, costGbp: 4_820, currentPrice: 124, currentValueGbp: 5_270, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "Global equity", pnlGbp: 450, pnlPct: 0.093, priceCurrency: "GBP", quantity: 42.5, snapshotFxRateNativePerGbp: 1, ticker: "EQGB" },
    { account: "B", allocationPct: 0.189, costGbp: 4_260, currentPrice: 91.38, currentValueGbp: 4_569, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "US equity", pnlGbp: 309, pnlPct: 0.073, priceCurrency: "GBP", quantity: 50, snapshotFxRateNativePerGbp: 1, ticker: "XUSE" },
    { account: "B", allocationPct: 0.083, costGbp: 1_860, currentPrice: 40.14, currentValueGbp: 2_007, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "Semiconductors", pnlGbp: 147, pnlPct: 0.079, priceCurrency: "GBP", quantity: 50, snapshotFxRateNativePerGbp: 1, ticker: "SEMI" },
    { account: "B", allocationPct: 0.06, costGbp: 1_350, currentPrice: 29, currentValueGbp: 1_450, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "Momentum factor", pnlGbp: 100, pnlPct: 0.074, priceCurrency: "GBP", quantity: 50, snapshotFxRateNativePerGbp: 1, ticker: "IUMF" },
    { account: "A", allocationPct: 0.05, costGbp: 1_050, currentPrice: 201.5, currentValueGbp: 1_209, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "Alphabet", pnlGbp: 159, pnlPct: 0.151, priceCurrency: "USD", quantity: 8, snapshotFxRateNativePerGbp: 1.33, ticker: "GOOGL" },
    { account: "A", allocationPct: 0.24, costGbp: 5_320, currentPrice: 58.02, currentValueGbp: 5_802, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "World equity", pnlGbp: 482, pnlPct: 0.091, priceCurrency: "GBP", quantity: 100, snapshotFxRateNativePerGbp: 1, ticker: "VWRP" },
    { account: "B", allocationPct: 0.16, costGbp: 3_650, currentPrice: 38.7, currentValueGbp: 3_870, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "Short gilts", pnlGbp: 220, pnlPct: 0.06, priceCurrency: "GBP", quantity: 100, snapshotFxRateNativePerGbp: 1, ticker: "IGLS" },
    { account: "A", allocationPct: 0.034, costGbp: 946, currentPrice: 392.68, currentValueGbp: 891, dilutedCostCurrency: "GBP", dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null, fxImpactGbp: null, name: "Broadcom", pnlGbp: -54, pnlPct: -0.057, priceCurrency: "USD", quantity: 3.3, snapshotFxRateNativePerGbp: 1.35, ticker: "AVGO" },
  ];
  const mockIntraday = outage ? mockOutageIntradayMoneyNav : mockIntradayMoneyNav;
  const visibleIntraday = singlePoint ? mockIntraday.slice(-1) : mockIntraday;
  const mockAsOf = visibleIntraday.at(-1)?.date ?? "2026-08-17T21:50:00Z";
  const mockAccounts: OverviewAccountRow[] = [
    { cashGbp: 420, code: "A", dailyReturn: -0.0042, name: "Invest", totalValueGbp: 11_000, twr: 0.932, unrealizedPnlGbp: 890 },
    { cashGbp: 495, code: "B", dailyReturn: -0.0035, name: "Stocks ISA", totalValueGbp: value - 11_000, twr: 0.045, unrealizedPnlGbp: Number(latest.totalNetPnlGbp ?? 0) - 890 },
  ];
  const mockCfdValue = 4_806.49;
  const activeAccount = scope === "invest"
    ? mockAccounts[0]
    : scope === "isa"
      ? mockAccounts[1]
      : null;
  const selectedHoldings = scope === "invest"
    ? mockHoldings.filter((holding) => holding.account === "A")
    : scope === "isa"
      ? mockHoldings.filter((holding) => holding.account === "B")
      : mockHoldings;
  const selectedValue = activeAccount?.totalValueGbp
    ?? (scope === "with-cfd" ? value + mockCfdValue : value);
  const navValueKey: NavValueKey = scope === "invest"
    ? "invest"
    : scope === "isa"
      ? "isa"
      : scope === "with-cfd"
        ? "household"
        : "total";
  const latestDaily = mockMoneyNav.at(-1);
  const selectedDrawdown = scope === "invest"
    ? latestDaily?.investDrawdown ?? null
    : scope === "isa"
      ? latestDaily?.isaDrawdown ?? null
      : latestDaily?.totalDrawdown ?? -0.084;
  const heroMetrics: HeroMetric[] = scope === "with-cfd"
    ? [
        { label: <Localized zh="Invest + ISA 已投资" en="Invest + ISA invested" />, value: gbp(value - cash, 0) },
        { label: <Localized zh="Invest + ISA 现金" en="Invest + ISA cash" />, value: gbp(cash, 0) },
        { label: <Localized zh="CFD 权益代理" en="CFD equity proxy" />, value: gbp(mockCfdValue, 0) },
        { label: <Localized zh="当前盈亏回撤" en="Current P&L drawdown" />, tone: "negative", value: gbp(-1_118, 0) },
      ]
    : [
        { label: <Localized zh="已投资" en="Invested" />, value: gbp(activeAccount ? activeAccount.totalValueGbp - activeAccount.cashGbp : value - cash, 0) },
        { label: <Localized zh="现金" en="Cash" />, value: gbp(activeAccount?.cashGbp ?? cash, 0) },
        { label: <Localized zh="浮动盈亏" en="Unrealized P&L" />, value: gbp(activeAccount?.unrealizedPnlGbp ?? Number(latest.totalNetPnlGbp ?? 0), 0) },
        { label: <Localized zh="当前回撤" en="Current drawdown" />, tone: selectedDrawdown != null && selectedDrawdown < 0 ? "negative" : undefined, value: pct(selectedDrawdown) },
      ];
  return (
    <Stack gap="md">
      <Alert className="tm-local-mock-alert" color="blue" title={<Localized zh="本地主资产卡样稿" en="Local portfolio hero prototype" />}>
        <Localized
          zh="以下金额、时间和曲线全部是 synthetic mock，不读取或修改真实账户。"
          en="All amounts, times, and chart points below are synthetic mock data; no real account data is read or changed."
        />
      </Alert>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <PortfolioHeroCard
          brokerAsOf={mockAsOf}
          dayReturn={activeAccount?.dailyReturn ?? 0.0016}
          metrics={heroMetrics}
          intradayNav={visibleIntraday}
          modelDayAsOf="2026-08-17"
          navValueKey={navValueKey}
          onScopeChange={setScope}
          scope={scope}
          scopeNote={scope === "with-cfd" ? (
            <Localized
              zh="CFD 已停用 · 权益代理数据至 2026年6月1日"
              en="CFD retired · equity proxy through 1 Jun 2026"
            />
          ) : undefined}
          scopeOptions={portfolioScopeOptions(locale, true)}
          title={portfolioScopeTitle(scope)}
          totalValueGbp={selectedValue}
        />
        <AllocationOverviewCard holdings={selectedHoldings} />
      </SimpleGrid>
      <OverviewLowerDeck
        accounts={mockAccounts}
        holdings={mockHoldings}
        nav={mockMoneyNav}
        reviewSummaries={[
          { account: "A", coverageEnd: "2026-08-17", coverageStart: "2024-07-01", eventCount: 212, maxPnlDrawdownGbp: -430, name: "Invest", netPnlGbp: 1_347, netPnlRate: 1.322, phaseCount: 5 },
          { account: "B", coverageEnd: "2026-08-17", coverageStart: "2024-07-01", eventCount: 168, maxPnlDrawdownGbp: -589, name: "Stocks ISA", netPnlGbp: 260, netPnlRate: 0.045, phaseCount: 4 },
          { account: "C", coverageEnd: "2026-06-01", coverageStart: "2025-06-01", eventCount: 94, maxPnlDrawdownGbp: -490, name: "CFD", netPnlGbp: -490, netPnlRate: null, phaseCount: 3 },
        ]}
        technical={[
          { score: 26, ticker: "AVGO" },
          { score: 61, ticker: "GOOGL" },
          { score: 72, ticker: "SEMI" },
        ]}
        valuations={[
          { ev5Upside: -0.185, ticker: "AVGO" },
          { ev5Upside: 0.12, ticker: "GOOGL" },
          { ev5Upside: 0.07, ticker: "SEMI" },
        ]}
        cfdStatus={{ accountStatus: "retired", isStale: false }}
        researchAsOf="2026-08-17"
      />
    </Stack>
  );
}

function portfolioScopeOptions(locale: "zh" | "en", includeCfd: boolean) {
  const options: Array<{ label: string; value: PortfolioScope }> = [
    { label: "Invest + ISA", value: "invest-isa" },
    { label: "Invest", value: "invest" },
    { label: "Stocks ISA", value: "isa" },
  ];
  if (includeCfd) {
    options.push({
      label: locale === "zh" ? "Invest + ISA + CFD" : "Invest + ISA + CFD",
      value: "with-cfd",
    });
  }
  return options;
}

function portfolioScopeTitle(scope: PortfolioScope) {
  if (scope === "invest") return <Localized zh="Invest 券商净值" en="Invest broker value" />;
  if (scope === "isa") return <Localized zh="Stocks ISA 券商净值" en="Stocks ISA broker value" />;
  if (scope === "with-cfd") return <Localized zh="Invest + ISA + CFD 代理总值" en="Invest + ISA + CFD proxy" />;
  return <Localized zh="Invest + ISA 券商净值" en="Invest + ISA broker value" />;
}

function PortfolioHeroCard({
  brokerAsOf,
  dayReturn,
  intradayNav,
  metrics,
  modelDayAsOf,
  navValueKey,
  onScopeChange,
  scope,
  scopeNote,
  scopeOptions,
  title,
  totalValueGbp,
}: {
  brokerAsOf: string | null;
  dayReturn: number | null;
  intradayNav: NavPoint[];
  metrics: HeroMetric[];
  modelDayAsOf: string | null;
  navValueKey: NavValueKey;
  onScopeChange: (scope: PortfolioScope) => void;
  scope: PortfolioScope;
  scopeNote?: React.ReactNode;
  scopeOptions: Array<{ label: string; value: PortfolioScope }>;
  title: React.ReactNode;
  totalValueGbp: number | null;
}) {
  const { locale, timeZone } = useLocale();
  const chartColours = useChartColours();
  const anchors = useMemo(
    () => latestNaturalDayIntradayPoints(intradayNav, (point) => point[navValueKey]),
    [intradayNav, navValueKey],
  );
  const firstAnchor = anchors.at(0) ?? null;
  const latestAnchor = anchors.at(-1) ?? null;
  const firstValue = Number(firstAnchor?.[navValueKey]);
  const dtdValues = useMemo(
    () => Number.isFinite(firstValue)
      ? anchors.map((point) => Number(point[navValueKey]) - firstValue)
      : [],
    [anchors, firstValue, navValueKey],
  );
  const dtdChange = anchors.length >= 2 ? dtdValues.at(-1) ?? null : null;
  const dtdChangeRate = dtdChange != null && firstValue > 0
    ? dtdChange / firstValue
    : null;
  const dtdTimeline = useMemo(
    () => naturalCalendarTimeline(anchors, 10, 1, true),
    [anchors],
  );
  const dtdTimelineValues = useMemo(
    () => dtdTimeline.rowIndexes.map(
      (index) => index == null ? null : dtdValues[index],
    ),
    [dtdTimeline.rowIndexes, dtdValues],
  );
  const coverage = useMemo(
    () => summarizeTimelineCoverage(dtdTimeline.categories, dtdTimeline.rowIndexes),
    [dtdTimeline.categories, dtdTimeline.rowIndexes],
  );
  const focusedTimeline = useMemo(() => {
    if (coverage.firstObservedIndex == null || coverage.lastObservedIndex == null) {
      return {
        categories: dtdTimeline.categories,
        rowIndexes: dtdTimeline.rowIndexes,
        values: dtdTimelineValues,
      };
    }
    const start = coverage.firstObservedIndex === 0
      ? 0
      : Math.max(coverage.firstObservedIndex - 1, 0);
    const end = coverage.lastObservedIndex + 1;
    return {
      categories: dtdTimeline.categories.slice(start, end),
      rowIndexes: dtdTimeline.rowIndexes.slice(start, end),
      values: dtdTimelineValues.slice(start, end),
    };
  }, [
    coverage.firstObservedIndex,
    coverage.lastObservedIndex,
    dtdTimeline.categories,
    dtdTimeline.rowIndexes,
    dtdTimelineValues,
  ]);
  const dtdGapBridges = useMemo(
    () => gapBridgeSegments(
      focusedTimeline.rowIndexes,
      anchors,
      (_point, index) => dtdValues[index] ?? null,
    ),
    [anchors, dtdValues, focusedTimeline.rowIndexes],
  );
  const firstObservedTime = firstAnchor
    ? formatDate(firstAnchor.date, locale, { hour: "2-digit", minute: "2-digit", timeZone })
    : null;
  const lastObservedTime = latestAnchor
    ? formatDate(latestAnchor.date, locale, { hour: "2-digit", minute: "2-digit", timeZone })
    : null;
  const startsAtMidnight = coverage.firstObservedIndex === 0;
  const dtdLabel = anchors.length < 2
    ? locale === "zh" ? "今日变化暂不可用" : "Today’s change unavailable"
    : startsAtMidnight
      ? locale === "zh" ? "今日价值变化" : "Today’s value change"
      : locale === "zh" ? `自 ${firstObservedTime} 起价值变化` : `Value change since ${firstObservedTime}`;
  const positiveDtd = (dtdChange ?? 0) >= 0;
  const positiveModelDay = (dayReturn ?? 0) >= 0;
  const option = useMemo<EChartsOption | null>(() => {
    if (!anchors.length) return null;
    const singleValue = dtdValues.length === 1 ? dtdValues[0] : null;
    const singleValuePadding = singleValue == null
      ? null
      : Math.max(Math.abs(singleValue) * 0.002, 1);
    return {
      animationDuration: 240,
      grid: { bottom: 4, left: 2, right: 2, top: 4 },
      tooltip: {
        borderColor: chartColours.border,
        trigger: anchors.length === 1 ? "item" : "axis",
        valueFormatter: (value) => formatCurrency(Number(value), locale, "GBP", 2),
      },
      xAxis: {
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        data: focusedTimeline.categories,
        splitLine: { show: false },
        type: "category",
      },
      yAxis: {
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        max: singleValue != null && singleValuePadding != null
          ? singleValue + singleValuePadding
          : undefined,
        min: singleValue != null && singleValuePadding != null
          ? singleValue - singleValuePadding
          : undefined,
        scale: true,
        splitLine: { show: false },
        type: "value",
      },
      series: [
        ...(dtdGapBridges.length ? [{
          animation: false,
          data: Array.from<number | null>({ length: focusedTimeline.categories.length }).fill(null),
          emphasis: { disabled: true },
          markLine: {
            data: dtdGapBridges.map((bridge) => ([
              { coord: [focusedTimeline.categories[bridge.fromIndex], bridge.fromValue] },
              { coord: [focusedTimeline.categories[bridge.toIndex], bridge.toValue] },
            ] as [
              { coord: [string, number] },
              { coord: [string, number] },
            ])),
            label: { show: false },
            lineStyle: {
              color: chartColours.canvas,
              opacity: 0.68,
              type: "dashed" as const,
              width: 1.6,
            },
            silent: true,
            symbol: ["none", "none"] as [string, string],
          },
          showSymbol: false,
          silent: true,
          type: "line" as const,
          z: 1,
        }] : []),
        {
          areaStyle: { color: chartColours.canvas, opacity: 0.04 },
          connectNulls: false,
          data: focusedTimeline.values,
          lineStyle: { color: chartColours.canvas, width: 2.2 },
          name: dtdLabel,
          itemStyle: { borderColor: chartColours.canvas, borderWidth: 2, color: chartColours.brand },
          showSymbol: anchors.length === 1,
          smooth: 0.16,
          symbol: "circle",
          symbolSize: 9,
          type: "line",
          z: 2,
        },
      ],
    };
  }, [
    anchors,
    chartColours,
    dtdGapBridges,
    dtdLabel,
    dtdValues,
    focusedTimeline.categories,
    focusedTimeline.values,
    locale,
  ]);
  const chartRef = useECharts(option);

  return (
    <Card
      className="tm-portfolio-hero"
      h="100%"
      mih={{ base: 0, lg: 410 }}
      p={{ base: "md", sm: "lg" }}
      radius="xl"
      shadow="xs"
      withBorder={false}
    >
      <Stack gap="md" h="100%">
        <Group align="flex-start" justify="space-between" wrap="nowrap">
          <div>
            <Title c="white" order={2} size="h3">
              {title}
            </Title>
            <Text c="brand.1" mt={2} size="xs">
              {locale === "zh" ? "截至" : "Through"} {brokerAsOf ? formatDate(brokerAsOf, locale, { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short", timeZone, timeZoneName: "short" }) : "—"}
            </Text>
            {scopeNote ? <Text c="brand.1" mt={2} size="xs">{scopeNote}</Text> : null}
          </div>
          <Select
            allowDeselect={false}
            aria-label={locale === "zh" ? "选择账户范围" : "Choose account scope"}
            comboboxProps={{ withinPortal: true }}
            data={scopeOptions}
            maxDropdownHeight={220}
            onChange={(next) => next && onScopeChange(next as PortfolioScope)}
            size="xs"
            className="tm-portfolio-scope"
            styles={{
              input: {
                background: "rgba(255, 255, 255, 0.12)",
                borderColor: "rgba(255, 255, 255, 0.18)",
                color: "white",
                fontWeight: 700,
              },
            }}
            value={scope}
            w={{ base: 138, sm: 158 }}
          />
        </Group>

        <Text c="white" className="tm-portfolio-value" fw={700}>
          {totalValueGbp == null ? "—" : gbp(totalValueGbp, 2)}
        </Text>

        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <div>
            <Text c="brand.1" fw={700} size="xs">{dtdLabel}</Text>
            <Group gap="xs" mt={3} wrap="nowrap">
              {dtdChange == null ? null : positiveDtd ? <TrendUp aria-hidden="true" size={18} /> : <TrendDown aria-hidden="true" size={18} />}
              <Text className={dtdChange == null ? undefined : `tm-tone-inverse-${positiveDtd ? "positive" : "negative"}`} c={dtdChange == null ? "brand.1" : undefined} fw={750}>
                {dtdChange == null ? "—" : <>{gbp(dtdChange, 0)} · {pct(dtdChangeRate, 2)}</>}
              </Text>
            </Group>
          </div>
          <div>
            <Text c="brand.1" fw={700} size="xs"><Localized zh="上一交易日" en="Previous trading day" /></Text>
            <Group gap="xs" mt={3} wrap="nowrap">
              {positiveModelDay ? <TrendUp aria-hidden="true" size={18} /> : <TrendDown aria-hidden="true" size={18} />}
              <Text className={`tm-tone-inverse-${positiveModelDay ? "positive" : "negative"}`} fw={750}>{pct(dayReturn, 2)}</Text>
              <Text c="brand.1" size="xs">{modelDayAsOf ? formatDate(modelDayAsOf, locale, { day: "numeric", month: "short" }) : "—"}</Text>
            </Group>
          </div>
        </SimpleGrid>

        <SimpleGrid className="tm-hero-metrics" cols={{ base: 2, sm: 4 }}>
          {metrics.map((metric, index) => (
            <Metric
              inverse
              key={index}
              label={metric.label}
              tone={metric.tone}
              value={metric.value}
            />
          ))}
        </SimpleGrid>

        <Paper className="tm-hero-trend" p="sm" radius="lg">
          {option ? (
            <div
              aria-label={locale === "zh"
                ? `${dtdLabel}：${dtdChange == null ? "暂无变化值" : `${gbp(dtdChange, 0)}，${pct(dtdChangeRate, 2)}`}；观测 ${firstObservedTime ?? "—"} 至 ${lastObservedTime ?? "—"}`
                : `${dtdLabel}: ${dtdChange == null ? "change unavailable" : `${gbp(dtdChange, 0)}, ${pct(dtdChangeRate, 2)}`}; observed ${firstObservedTime ?? "—"} to ${lastObservedTime ?? "—"}`}
              className="tm-hero-trend-chart"
              ref={chartRef}
              role="img"
            />
          ) : (
            <Text c="brand.1" py="lg" size="sm"><Localized zh="今日暂无价值变化记录" en="No value-change observation is available today" /></Text>
          )}
          <TimelineCoverage context="day" inverse summary={coverage} />
          <Group justify="space-between">
            {anchors.length ? (
              <Text c="brand.1" size="xs">{firstObservedTime}</Text>
            ) : <span />}
            <Text c="brand.1" size="xs">{lastObservedTime ?? "—"}</Text>
          </Group>
        </Paper>
      </Stack>
    </Card>
  );
}

function OverviewLens({ data }: { data: DashboardLens }) {
  const { locale } = useLocale();
  const holdings = data.holdings ?? [];
  const accounts = (data.accounts ?? []).filter(
    (account): account is AccountSummary & { code: "A" | "B" } => account.isInvestable && account.code !== "C",
  );
  const cfdAvailable = Boolean(data.cfd && data.householdTotalValueGbp != null);
  const [scope, setScope] = usePortfolioScope(cfdAvailable);
  const activeAccount = scope === "invest"
    ? accounts.find((account) => account.code === "A") ?? null
    : scope === "isa"
      ? accounts.find((account) => account.code === "B") ?? null
      : null;
  const latestDaily = (data.nav ?? []).at(-1) ?? null;
  const selectedHoldings = scope === "invest"
    ? holdings.filter((holding) => holding.account === "A")
    : scope === "isa"
      ? holdings.filter((holding) => holding.account === "B")
      : holdings;
  const navValueKey: NavValueKey = scope === "invest"
    ? "invest"
    : scope === "isa"
      ? "isa"
      : scope === "with-cfd"
        ? "household"
        : "total";
  const currentDrawdown = scope === "invest"
    ? latestDaily?.investDrawdown ?? null
    : scope === "isa"
      ? latestDaily?.isaDrawdown ?? null
      : latestDaily?.totalDrawdown ?? null;
  const totalValue = activeAccount?.totalValueGbp
    ?? (scope === "with-cfd" ? data.householdTotalValueGbp : data.totalValueGbp)
    ?? null;
  const heroMetrics: HeroMetric[] = scope === "with-cfd" && data.cfd
    ? [
        { label: <Localized zh="Invest + ISA 已投资" en="Invest + ISA invested" />, value: data.totalInvestedGbp == null ? "—" : gbp(data.totalInvestedGbp, 0) },
        { label: <Localized zh="Invest + ISA 现金" en="Invest + ISA cash" />, value: data.totalCashGbp == null ? "—" : gbp(data.totalCashGbp, 0) },
        { label: <Localized zh="CFD 权益代理" en="CFD equity proxy" />, value: gbp(data.cfd.endingValueGbp, 0) },
        {
          label: <Localized zh="当前盈亏回撤" en="Current P&L drawdown" />,
          tone: (latestDaily?.householdPnlDrawdownGbp ?? 0) < 0 ? "negative" : undefined,
          value: latestDaily?.householdPnlDrawdownGbp == null ? "—" : gbp(latestDaily.householdPnlDrawdownGbp, 0),
        },
      ]
    : [
        { label: <Localized zh="已投资" en="Invested" />, value: activeAccount ? gbp(activeAccount.investedGbp, 0) : data.totalInvestedGbp == null ? "—" : gbp(data.totalInvestedGbp, 0) },
        { label: <Localized zh="现金" en="Cash" />, value: activeAccount ? gbp(activeAccount.cashGbp, 0) : data.totalCashGbp == null ? "—" : gbp(data.totalCashGbp, 0) },
        { label: <Localized zh="浮动盈亏" en="Unrealized P&L" />, value: activeAccount ? gbp(activeAccount.unrealizedPnlGbp, 0) : data.totalUnrealizedPnlGbp == null ? "—" : gbp(data.totalUnrealizedPnlGbp, 0) },
        { label: <Localized zh="当前回撤" en="Current drawdown" />, tone: currentDrawdown != null && currentDrawdown < 0 ? "negative" : undefined, value: pct(currentDrawdown) },
      ];

  return (
    <Stack gap="xl">
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <PortfolioHeroCard
          brokerAsOf={data.brokerAsOf}
          dayReturn={activeAccount?.dailyReturn ?? data.latestModelDayReturn ?? null}
          intradayNav={data.intradayNav ?? []}
          metrics={heroMetrics}
          modelDayAsOf={data.researchAsOf}
          navValueKey={navValueKey}
          onScopeChange={setScope}
          scope={scope}
          scopeNote={scope === "with-cfd" && data.cfd ? (() => {
            const cfdDate = data.cfd.coverageEndDate || data.cfd.asOf;
            const formattedDate = cfdDate ? formatDate(cfdDate, locale, { day: "numeric", month: "short", year: "numeric" }) : "—";
            const state = data.cfd.accountStatus === "retired"
              ? locale === "zh" ? "已停用" : "retired"
              : data.cfd.isStale
                ? locale === "zh" ? "已陈旧" : "stale"
                : locale === "zh" ? "手动导入" : "manually imported";
            return locale === "zh"
              ? `CFD ${state} · 权益代理数据至 ${formattedDate}`
              : `CFD ${state} · equity proxy through ${formattedDate}`;
          })() : undefined}
          scopeOptions={portfolioScopeOptions(locale, cfdAvailable)}
          title={portfolioScopeTitle(scope)}
          totalValueGbp={totalValue}
        />

        <AllocationOverviewCard holdings={selectedHoldings} />
      </SimpleGrid>

      <OverviewLowerDeck
        accounts={accounts}
        holdings={holdings}
        nav={data.nav ?? []}
        reviewSummaries={data.reviewSummaries ?? []}
        cfdStatus={data.cfd ? { accountStatus: data.cfd.accountStatus, isStale: data.cfd.isStale } : undefined}
        researchAsOf={data.researchAsOf}
        technical={data.technical ?? []}
        valuations={data.valuations ?? []}
      />
    </Stack>
  );
}

function AllocationOverviewCard({ holdings }: { holdings: Holding[] }) {
  return (
    <Card className="tm-allocation-card" h="100%" mih={{ base: 0, lg: 410 }} p={{ base: "md", sm: "lg" }} radius="xl" shadow="md" withBorder={false}>
      <Box visibleFrom="sm">
        <Group justify="space-between" wrap="nowrap">
          <Title order={2} size="h3"><Localized zh="持仓分布" en="Holdings breakdown" /></Title>
          <ChartDonut aria-hidden="true" size={22} />
        </Group>
        <div className="tm-allocation-content">
          <AllocationChart embedded height={220} holdings={holdings} showLegend={false} />
        </div>
      </Box>
      <Box hiddenFrom="sm">
        <details className="tm-allocation-disclosure">
          <summary>
            <Group justify="space-between" wrap="nowrap">
              <Title order={2} size="h3"><Localized zh="持仓分布" en="Holdings breakdown" /></Title>
              <Group className="tm-allocation-mobile-cue" gap={5} wrap="nowrap">
                <Text c="dimmed" fw={700} size="sm"><Localized zh="查看明细" en="View details" /></Text>
                <CaretDown aria-hidden="true" className="tm-allocation-caret" size={18} />
              </Group>
            </Group>
          </summary>
          <div className="tm-allocation-content">
            <AllocationChart embedded height={220} holdings={holdings} showLegend={false} />
          </div>
        </details>
      </Box>
    </Card>
  );
}

function OverviewLowerDeck({
  accounts,
  holdings,
  nav,
  reviewSummaries,
  cfdStatus,
  researchAsOf,
  technical,
  valuations,
}: {
  accounts: OverviewAccountRow[];
  holdings: Holding[];
  nav: NavPoint[];
  reviewSummaries: OverviewReviewSummary[];
  cfdStatus?: CfdStatus;
  researchAsOf: string | null;
  technical: Array<{ score: number; ticker: string }>;
  valuations: Array<{ ev5Upside: number | null; ticker: string }>;
}) {
  const { locale } = useLocale();
  const heldTickers = new Set(holdings.map((holding) => holding.ticker));
  const holdingsByTicker = new Map(holdings.map((holding) => [holding.ticker, holding]));
  const weakest = technical
    .filter((row) => heldTickers.has(row.ticker))
    .sort((left, right) => left.score - right.score)[0];
  const valuationRisk = valuations
    .filter((row) => heldTickers.has(row.ticker) && row.ev5Upside !== null)
    .sort((left, right) => (left.ev5Upside ?? Infinity) - (right.ev5Upside ?? Infinity))[0];
  const valuationOpportunity = valuations
    .filter((row) => heldTickers.has(row.ticker) && row.ev5Upside !== null && row.ticker !== valuationRisk?.ticker)
    .sort((left, right) => (right.ev5Upside ?? -Infinity) - (left.ev5Upside ?? -Infinity))[0];
  const signalCompany = (ticker?: string) => ticker
    ? { name: holdingsByTicker.get(ticker)?.name ?? ticker, ticker }
    : undefined;
  const investableValue = accounts.reduce((sum, account) => sum + account.totalValueGbp, 0);

  return (
    <Stack gap="xl">
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {accounts.map((account) => (
          <Card
            className="tm-interactive-card tm-account-card"
            component={Link}
            data-account={account.code}
            href={`/holdings?account=${account.code}`}
            key={account.code}
            radius="lg"
            withBorder
          >
            <Stack gap="md">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon color={account.code === "A" ? "orange" : "cyan"} radius="md" size="lg" variant="light">
                    {account.code}
                  </ThemeIcon>
                  <div>
                    <Text fw={750}>{account.name}</Text>
                    <Text size="sm">
                      {account.code === "A" ? <Localized zh="普通投资账户" en="General investment account" /> : <Localized zh="免税投资账户" en="Tax-free investment account" />}
                    </Text>
                  </div>
                </Group>
                <ArrowRight aria-hidden="true" size={18} />
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <Stack gap={5} justify="center">
                  <Text className="tm-account-value" fw={750}>{gbp(account.totalValueGbp, 2)}</Text>
                  <Group gap="xs">
                    <Badge className="tm-account-share" variant="light">
                      <Localized zh="占 Invest + ISA" en="Share of Invest + ISA" /> {pct(investableValue > 0 ? account.totalValueGbp / investableValue : null)}
                    </Badge>
                  </Group>
                </Stack>
                <AccountTrend account={account.code} nav={nav} />
              </SimpleGrid>
              <SimpleGrid cols={3}>
                <Metric
                  label={<Localized zh="今日" en="Today" />}
                  tone={(account.dailyReturn ?? 0) >= 0 ? "positive" : "negative"}
                  value={pct(account.dailyReturn, 2)}
                />
                <Metric
                  label={<Localized zh="浮动盈亏" en="Unrealized P&L" />}
                  tone={account.unrealizedPnlGbp >= 0 ? "positive" : "negative"}
                  value={gbp(account.unrealizedPnlGbp, 0)}
                />
                <Metric label={<Localized zh="现金" en="Cash" />} value={gbp(account.cashGbp, 0)} />
              </SimpleGrid>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <section aria-labelledby="review-entry-title">
          <Group justify="space-between" mb="sm">
            <Title id="review-entry-title" order={2} size="h3">
              <Localized zh="账户复盘" en="Account review" />
            </Title>
            <ClockCounterClockwise aria-hidden="true" size={22} />
          </Group>
          <Paper className="tm-overview-review-list" radius="lg" withBorder>
            {reviewSummaries.length ? reviewSummaries.map((summary) => (
              <OverviewReviewRow cfdStatus={cfdStatus} key={summary.account} summary={summary} />
            )) : (
              <Link className="tm-overview-review-empty" href="/review">
                <Text fw={680} size="sm"><Localized zh="查看历史复盘" en="View account history" /></Text>
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            )}
          </Paper>
        </section>

        <section aria-labelledby="signals-title">
          <Group align="flex-end" justify="space-between" mb="sm">
            <div>
              <Title id="signals-title" order={2} size="h3">
                <Localized zh="研究信号" en="Research signals" />
              </Title>
              <Text c="dimmed" mt={2} size="xs">
                {researchAsOf
                  ? <><Localized zh="证据截至" en="Evidence through" /> {formatDate(researchAsOf, locale, { day: "numeric", month: "short", year: "numeric" })}</>
                  : <Localized zh="暂无研究覆盖" en="No research coverage" />}
              </Text>
            </div>
            <Pulse aria-hidden="true" size={22} />
          </Group>
          <Paper className="tm-overview-signal-list" radius="lg" withBorder>
            <OverviewSignalRow
              company={signalCompany(weakest?.ticker)}
              href={weakest ? `/research?ticker=${weakest.ticker}&view=technical` : undefined}
              icon={<Pulse aria-hidden="true" size={18} />}
              label={weakest
                ? <Localized zh="技术评分最低" en="Lowest technical score" />
                : <Localized zh="技术信号不可用" en="Technical signal unavailable" />}
              tone="orange"
              value={weakest ? `${weakest.ticker} · ${weakest.score}/100` : <Localized zh="无覆盖持仓" en="No covered holding" />}
            />
            <OverviewSignalRow
              company={signalCompany(valuationRisk?.ticker)}
              href={valuationRisk ? `/research?ticker=${valuationRisk.ticker}&view=valuation` : undefined}
              icon={<Flask aria-hidden="true" size={18} />}
              label={valuationRisk?.ev5Upside != null
                ? valuationRisk.ev5Upside < 0
                  ? <Localized zh="现价高于模型基准" en="Price above model base" />
                  : <Localized zh="现价最接近模型基准" en="Price closest to model base" />
                : <Localized zh="估值信号不可用" en="Valuation signal unavailable" />}
              tone="grape"
              value={valuationRisk?.ev5Upside != null ? `${valuationRisk.ticker} · ${pct(valuationRisk.ev5Upside)}` : <Localized zh="无覆盖持仓" en="No covered holding" />}
            />
            <OverviewSignalRow
              company={signalCompany(valuationOpportunity?.ticker)}
              href={valuationOpportunity ? `/research?ticker=${valuationOpportunity.ticker}&view=valuation` : undefined}
              icon={<TrendUp aria-hidden="true" size={18} />}
              label={valuationOpportunity?.ev5Upside != null
                ? <Localized zh="模型上行空间最高" en="Highest model upside" />
                : <Localized zh="上行信号不可用" en="Upside signal unavailable" />}
              tone="teal"
              value={valuationOpportunity?.ev5Upside != null ? `${valuationOpportunity.ticker} · ${pct(valuationOpportunity.ev5Upside)}` : <Localized zh="无其他覆盖持仓" en="No other covered holding" />}
            />
          </Paper>
        </section>
      </SimpleGrid>
    </Stack>
  );
}

function AccountTrend({ account, nav }: { account: "A" | "B"; nav: NavPoint[] }) {
  const { locale } = useLocale();
  const chartColours = useChartColours();
  const key = account === "A" ? "invest" : "isa";
  const points = useMemo(
    () => nav
      .filter((point) => !point.intraday && Number.isFinite(Number(point[key])))
      .slice(-30),
    [key, nav],
  );
  const values = useMemo(() => points.map((point) => Number(point[key])), [key, points]);
  const colour = account === "A" ? chartColours.accent : chartColours.secondary;
  const option = useMemo<EChartsOption | null>(() => {
    if (points.length < 2) return null;
    return {
      animationDuration: 220,
      grid: { bottom: 2, left: 2, right: 2, top: 3 },
      tooltip: {
        borderColor: chartColours.border,
        trigger: "axis",
        formatter: (raw) => {
          const item = Array.isArray(raw) ? raw[0] : raw;
          const index = Number(item?.dataIndex ?? 0);
          return `${formatDate(points[index]?.date ?? "", locale, { day: "numeric", month: "short" })}<br/>${formatCurrency(values[index] ?? 0, locale, "GBP", 0)}`;
        },
      },
      xAxis: { axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, data: points.map((point) => point.date), type: "category" },
      yAxis: { axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, scale: true, splitLine: { show: false }, type: "value" },
      series: [{
        areaStyle: { color: colour, opacity: 0.08 },
        data: values,
        lineStyle: { color: colour, width: 2 },
        showSymbol: false,
        smooth: 0.18,
        type: "line",
      }],
    };
  }, [chartColours, colour, locale, points, values]);
  const chartRef = useECharts(option);
  const start = values.at(0);
  const end = values.at(-1);
  const change = start != null && end != null && start !== 0 ? end / start - 1 : null;

  return (
    <Paper className="tm-account-trend" p="sm" radius="md">
      <Group justify="space-between" mb={4} wrap="nowrap">
        <Text fw={680} size="xs"><Localized zh="近 30 日" en="Last 30 days" /></Text>
        <Text className={`tm-tone-${(change ?? 0) >= 0 ? "positive" : "negative"}`} fw={730} size="xs">{pct(change, 1)}</Text>
      </Group>
      {option ? <div aria-label={locale === "zh" ? `${account} 账户近 30 日价值轨迹` : `${account} account value over 30 days`} className="tm-account-trend-chart" ref={chartRef} role="img" /> : (
        <Group className="tm-account-trend-empty" justify="center"><Text size="xs"><Localized zh="暂无足够记录" en="Not enough history yet" /></Text></Group>
      )}
    </Paper>
  );
}

function OverviewReviewRow({ cfdStatus, summary }: { cfdStatus?: CfdStatus; summary: OverviewReviewSummary }) {
  const { locale } = useLocale();
  const colour = summary.account === "A" ? "orange" : summary.account === "B" ? "cyan" : "indigo";
  const label = summary.account === "A" ? "Invest" : summary.account === "B" ? "Stocks ISA" : "CFD";
  const coverageEnd = summary.coverageEnd
    ? formatDate(summary.coverageEnd, locale, { day: "numeric", month: "short" })
    : "—";
  const coverageLabel = summary.account === "C"
    ? cfdStatus?.accountStatus === "retired"
      ? locale === "zh" ? `已停用权益代理至 ${coverageEnd}` : `retired proxy through ${coverageEnd}`
      : cfdStatus?.isStale
        ? locale === "zh" ? `陈旧权益代理至 ${coverageEnd}` : `stale proxy through ${coverageEnd}`
        : locale === "zh" ? `导入权益代理至 ${coverageEnd}` : `imported proxy through ${coverageEnd}`
    : locale === "zh" ? `数据至 ${coverageEnd}` : `data through ${coverageEnd}`;
  return (
    <Link className="tm-overview-review-row" href={`/account-analysis?account=${summary.account}`}>
      <Group gap="sm" miw={0} wrap="nowrap">
        <ThemeIcon color={colour} radius="md" size="lg" variant="light">{summary.account}</ThemeIcon>
        <div className="tm-overview-review-copy">
          <Group gap={6} wrap="nowrap">
            <Text fw={720} size="sm">{label}</Text>
            <Text size="xs">· {coverageLabel}</Text>
          </Group>
          <Text size="xs">
            <Localized zh="最大盈亏回撤" en="Max P&L drawdown" /> {summary.maxPnlDrawdownGbp == null ? "—" : gbp(summary.maxPnlDrawdownGbp, 0)}
          </Text>
        </div>
      </Group>
      <Group gap="sm" wrap="nowrap">
        <div>
          <Text className={`tm-tone-${(summary.netPnlGbp ?? 0) >= 0 ? "positive" : "negative"}`} fw={740} size="sm" ta="right">{summary.netPnlGbp == null ? "—" : gbp(summary.netPnlGbp, 0)}</Text>
          <Text className="tm-review-pnl-label" size="xs" ta="right"><Localized zh="区间净盈亏" en="Period net P&L" /></Text>
        </div>
        <ArrowRight aria-hidden="true" size={16} />
      </Group>
    </Link>
  );
}

function OverviewSignalRow({
  company,
  href,
  icon,
  label,
  tone,
  value,
}: {
  company?: { name: string; ticker: string };
  href?: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  tone: string;
  value: React.ReactNode;
}) {
  const content = (
    <>
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon color={tone} radius="md" size="lg" variant="light">{icon}</ThemeIcon>
        <Text fw={680} size="sm">{label}</Text>
      </Group>
      <Group gap={6} style={{ flexShrink: 0 }} wrap="nowrap">
        {company ? <CompanyMark name={company.name} size={30} ticker={company.ticker} /> : null}
        <Text fw={750} size="sm" ta="right">{value}</Text>
        {href ? <ArrowRight aria-hidden="true" size={16} /> : null}
      </Group>
    </>
  );
  return href
    ? <Link className="tm-overview-signal-row" href={href}>{content}</Link>
    : <div className="tm-overview-signal-row tm-overview-signal-row--unavailable">{content}</div>;
}

function Metric({ inverse = false, label, tone, value }: { inverse?: boolean; label: React.ReactNode; tone?: MetricTone; value: string }) {
  const toneClass = tone ? `tm-tone-${inverse ? "inverse-" : ""}${tone}` : undefined;
  return <Stack gap={2}><Text c={inverse ? "brand.1" : "dimmed"} size="xs">{label}</Text><Text className={toneClass} c={tone ? undefined : inverse ? "white" : undefined} fw={700}>{value}</Text></Stack>;
}
