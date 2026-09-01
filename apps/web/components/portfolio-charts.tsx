"use client";

import {
  Accordion,
  Alert,
  Badge,
  Button,
  Grid,
  Group,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Info } from "@phosphor-icons/react";
import type { EChartsOption } from "echarts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Localized, useLocale, useMessages } from "@/components/locale-provider";
import { TimelineCoverage } from "@/components/timeline-coverage";
import {
  axisTimestampLabels,
  cropCumulativeMoneyOutcome,
  detailedTimestampLabel,
  gapBridgeSegments,
  latestNaturalDayIntradayPoints,
  naturalCalendarTimeline,
  netPnlRate,
  omitPortfolioWeekendDisplayWindow,
  portfolioCalendarDateKey,
  portfolioIntradayDisplayIntervalMinutes,
  relativeMoneyRate,
  stableMoneyRateBase,
  summarizeTimelineCoverage,
} from "@/lib/chart-domain";
import type { BenchmarkPricePoint, CfdSummary, Holding, NavPoint } from "@/lib/types";
import { replaceUrlState } from "@/lib/url-state";
import { ChartShell } from "@/ui/charts/chart-shell";
import {
  categoricalChartColours,
  type ChartColours,
  useChartColours,
} from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import {
  formatCompactCurrency,
  formatCurrency,
  formatDate,
  formatDeltaPercent,
  formatPercent,
} from "@/ui/formatters";

export const performanceAccountViews = [
  { key: "household", zh: "全部账户", en: "All accounts" },
  { key: "total", zh: "Invest + ISA", en: "Invest + ISA" },
  { key: "invest", zh: "Invest", en: "Invest" },
  { key: "isa", zh: "ISA", en: "ISA" },
  { key: "cfd", zh: "CFD", en: "CFD" },
] as const;
export type AccountView = (typeof performanceAccountViews)[number]["key"];

export const strategyViews = [
  { key: "total", zh: "Invest + ISA", en: "Invest + ISA" },
  { key: "invest", zh: "Invest", en: "Invest" },
  { key: "isa", zh: "ISA", en: "ISA" },
] as const;
export type StrategyView = (typeof strategyViews)[number]["key"];
export type MoneyView = AccountView;

export const performanceRanges = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "MAX"] as const;
const strategyRanges = ["1W", "1M", "3M", "6M", "YTD", "1Y", "MAX"] as const;
export type RangeKey = (typeof performanceRanges)[number];
export type PnlDisplayMode = "money" | "rate";

const monthlyIntradayCalendarDays = 31;

const twrKeys = { total: "totalTwr", invest: "investTwr", isa: "isaTwr" } as const;
const moneyKeys = {
  total: {
    contributions: "totalNetContributionsGbp",
    drawdown: "totalPnlDrawdownGbp",
    nav: "total",
    pnl: "totalNetPnlGbp",
  },
  invest: {
    contributions: "investNetContributionsGbp",
    drawdown: "investPnlDrawdownGbp",
    nav: "invest",
    pnl: "investNetPnlGbp",
  },
  isa: {
    contributions: "isaNetContributionsGbp",
    drawdown: "isaPnlDrawdownGbp",
    nav: "isa",
    pnl: "isaNetPnlGbp",
  },
  cfd: {
    contributions: "cfdNetContributionsGbp",
    drawdown: "cfdPnlDrawdownGbp",
    nav: "cfd",
    pnl: "cfdNetPnlGbp",
  },
  household: {
    contributions: "householdNetContributionsGbp",
    drawdown: "householdPnlDrawdownGbp",
    nav: "household",
    pnl: "householdNetPnlGbp",
  },
} as const;

function lineColour(view: AccountView, colours: ChartColours) {
  if (view === "cfd") return colours.negative;
  if (view === "invest") return colours.accent;
  if (view === "isa") return colours.secondary;
  return colours.brandDark;
}

function formatDetailedMoneyAxis(value: number, locale: "zh" | "en") {
  const absolute = Math.abs(value);
  if (absolute >= 1_000 && absolute < 1_000_000) {
    return `${formatCurrency(value / 1_000, locale, "GBP", 1)}k`;
  }
  return formatCompactCurrency(value, locale, "GBP");
}

function dateLabel(value: string, locale: "zh" | "en", timeZone: string) {
  const intraday = value.includes("T");
  return formatDate(value, locale, intraday
    ? { hour: "2-digit", minute: "2-digit", timeZone }
    : { day: "numeric", month: "short", timeZone: "UTC" });
}

export function PortfolioChart({
  data,
  fixedView,
}: {
  data: NavPoint[];
  fixedView?: AccountView;
}) {
  const { locale, timeZone } = useLocale();
  const chartColours = useChartColours();
  const messages = useMessages();
  const searchParams = useSearchParams();
  const requested = searchParams.get("navAccount") as AccountView | null;
  const [selected, setSelected] = useState<AccountView>(
    performanceAccountViews.some((item) => item.key === requested) ? requested! : "household",
  );
  const view = fixedView ?? selected;
  const rows = useMemo(
    () => data.filter((point) => !point.intraday && typeof point[view] === "number"),
    [data, view],
  );
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const colour = lineColour(view, chartColours);
    return {
      animationDuration: 240,
      grid: { bottom: 34, containLabel: true, left: 8, right: 14, top: 16 },
      tooltip: {
        trigger: "axis",
        valueFormatter: (value) => formatCurrency(Number(value), locale, "GBP", 0),
      },
      xAxis: {
        axisLabel: { color: chartColours.axis, formatter: (value: string) => dateLabel(value, locale, timeZone), hideOverlap: true },
        axisLine: { show: false },
        axisTick: { show: false },
        data: rows.map((point) => point.date),
        type: "category",
      },
      yAxis: {
        axisLabel: {
          color: chartColours.axis,
          formatter: (value: number) =>
            formatCurrency(value, locale, "GBP", 0).replace(/,000$/, "k"),
        },
        splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } },
        type: "value",
      },
      series: [{
        areaStyle: { color: colour, opacity: 0.12 },
        data: rows.map((point) => point[view]),
        lineStyle: { color: colour, width: 2 },
        showSymbol: false,
        smooth: 0.18,
        type: "line",
      }],
    };
  }, [chartColours, locale, rows, timeZone, view]);
  const chartRef = useECharts(option);
  const label = performanceAccountViews.find((item) => item.key === view)?.[locale] ?? view;

  return (
    <Stack gap="sm">
      {!fixedView ? (
        <Group justify="flex-end">
          <SegmentedControl
            aria-label={locale === "zh" ? "选择账户" : "Select account"}
            data={performanceAccountViews.map((item) => ({ label: item[locale], value: item.key }))}
            onChange={(value) => {
              const next = value as AccountView;
              setSelected(next);
              replaceUrlState({ navAccount: next === "household" ? null : next });
            }}
            value={view}
          />
        </Group>
      ) : null}
      <ChartShell
        ariaLabel={`${label} ${locale === "zh" ? "账户价值轨迹" : "account value history"}`}
        description={
          view === "cfd"
            ? messages.charts.cfdNote
            : view === "household"
              ? messages.charts.householdNote
              : messages.charts.combinedNote
        }
        empty={!rows.length}
        emptyMessage={locale === "zh" ? "没有可绘制的净值历史" : "No account history available"}
        height={420}
        title={locale === "zh" ? "账户价值轨迹" : "Account value history"}
      >
        <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
      </ChartShell>
      {rows.length ? (
        <Table.ScrollContainer
          minWidth={460}
          scrollAreaProps={{
            viewportProps: { "aria-label": locale === "zh" ? "净值历史表" : "Portfolio value history", tabIndex: 0 },
          }}
        >
          <Table aria-label={`${label} data`} striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{locale === "zh" ? "日期" : "Date"}</Table.Th>
                <Table.Th ta="right">{locale === "zh" ? "净值" : "Value"}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.slice(-5).reverse().map((point) => (
                <Table.Tr key={point.date}>
                  <Table.Td>{formatDate(point.date, locale)}</Table.Td>
                  <Table.Td ta="right">{formatCurrency(Number(point[view]), locale)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
    </Stack>
  );
}

function rangeStart(latestDate: string, range: RangeKey) {
  if (range === "MAX" || range === "1D") return null;
  const latest = new Date(latestDate.includes("T") ? latestDate : `${latestDate}T00:00:00Z`);
  if (range === "1W") latest.setUTCDate(latest.getUTCDate() - 7);
  else if (range === "YTD") return `${latest.getUTCFullYear()}-01-01`;
  else {
    const months = range === "1M" ? 1 : range === "3M" ? 3 : range === "6M" ? 6 : 12;
    latest.setUTCMonth(latest.getUTCMonth() - months);
  }
  return latest.toISOString().slice(0, 10);
}

export function MoneyPerformanceChart({
  cfdStatus = null,
  data,
  fixedDisplayMode,
  fixedRange,
  intradayData = [],
  fixedView,
  hideControls = false,
  onRangeChange,
}: {
  cfdStatus?: CfdSummary | null;
  data: NavPoint[];
  fixedDisplayMode?: PnlDisplayMode;
  fixedRange?: RangeKey;
  intradayData?: NavPoint[];
  fixedView?: MoneyView;
  hideControls?: boolean;
  onRangeChange?: (range: RangeKey) => void;
}) {
  const { locale, timeZone } = useLocale();
  const mobile = useMediaQuery("(max-width: 48em)");
  const chartColours = useChartColours();
  const messages = useMessages();
  const params = useSearchParams();
  const requestedView = params.get("performanceAccount") as MoneyView | null;
  const requestedRange = params.get("range") as RangeKey | null;
  const [selectedView, setSelectedView] = useState<MoneyView>(
    performanceAccountViews.some((item) => item.key === requestedView) ? requestedView! : "household",
  );
  const [selectedRange, setSelectedRange] = useState<RangeKey>(
    performanceRanges.includes(requestedRange as RangeKey) ? requestedRange! : "YTD",
  );
  const requestedDisplayMode = params.get("performanceUnit") as PnlDisplayMode | null;
  const [selectedDisplayMode, setSelectedDisplayMode] = useState<PnlDisplayMode>(
    requestedDisplayMode === "rate" ? "rate" : "money",
  );
  const view = fixedView ?? selectedView;
  const range = fixedRange ?? selectedRange;
  const pnlDisplayMode = fixedDisplayMode ?? selectedDisplayMode;
  const updateView = (next: MoneyView) => {
    setSelectedView(next);
    if (!fixedView) {
      replaceUrlState({ performanceAccount: next === "household" ? null : next });
    }
  };
  const updateRange = (next: RangeKey) => {
    setSelectedRange(next);
    onRangeChange?.(next);
    if (!fixedRange) replaceUrlState({ range: next === "YTD" ? null : next });
  };
  const updateDisplayMode = (next: PnlDisplayMode) => {
    setSelectedDisplayMode(next);
    if (!fixedDisplayMode) {
      replaceUrlState({ performanceUnit: next === "money" ? null : next });
    }
  };
  const cfdCutoffDate = (
    cfdStatus?.coverageEndDate
    ?? cfdStatus?.latestEventAt
    ?? cfdStatus?.asOf
    ?? ""
  ).slice(0, 10) || null;
  const cfdRetired = cfdStatus?.accountStatus === "retired";
  const carriedCfdValue = useMemo(() => {
    const latest = [...data]
      .reverse()
      .find((point) => !point.intraday && typeof point.cfd === "number");
    return typeof latest?.cfd === "number" ? latest.cfd : null;
  }, [data]);
  const {
    rows: rawRows,
    anchors,
    displayIntervalMinutes,
    intraday,
    valueChangeMode,
  } = useMemo(() => {
    const keys = moneyKeys[view];
    const valueOf = (point: NavPoint) => {
      if (
        view === "household"
        && point.intraday
        && typeof point.total === "number"
        && typeof carriedCfdValue === "number"
      ) {
        return point.total + carriedCfdValue;
      }
      return point[keys.nav];
    };
    const latestIntraday = latestNaturalDayIntradayPoints(intradayData, valueOf);
    const daily = data.filter(
      (point) =>
        !point.intraday &&
        typeof point[keys.nav] === "number" &&
        typeof point[keys.contributions] === "number" &&
        typeof point[keys.pnl] === "number" &&
        typeof point[keys.drawdown] === "number",
    );
    if (range === "1D") {
      if (latestIntraday.length < 2) {
        return {
          anchors: latestIntraday.length,
          displayIntervalMinutes: portfolioIntradayDisplayIntervalMinutes["1D"],
          intraday: true,
          rows: [],
          valueChangeMode: false,
        };
      }
      const openingNav = Number(valueOf(latestIntraday[0]));
      let valuePeak = openingNav;
      const rows = latestIntraday.map((point) => {
        const nav = Number(valueOf(point));
        valuePeak = Math.max(valuePeak, nav);
        return {
          contributions: openingNav,
          date: point.date,
          drawdown: nav - valuePeak,
          nav,
          overnight: null,
          pnl: nav - openingNav,
        };
      });
      return {
        anchors: latestIntraday.length,
        displayIntervalMinutes: portfolioIntradayDisplayIntervalMinutes["1D"],
        intraday: true,
        rows,
        valueChangeMode: true,
      };
    }
    if (range === "1W") {
      const available = [...intradayData]
        .filter((point) => point.intraday === true && typeof valueOf(point) === "number")
        .sort((left, right) => left.date.localeCompare(right.date));
      const timeline = omitPortfolioWeekendDisplayWindow(
        naturalCalendarTimeline(
          available,
          portfolioIntradayDisplayIntervalMinutes["1W"],
          7,
          false,
        ),
      );
      const visibleIndexes = timeline.rowIndexes.filter(
        (index): index is number => index !== null,
      );
      const sampled = visibleIndexes.map((index) => available[index]);
      const windowStart = timeline.categories.at(0) ?? null;
      const visible = windowStart
        ? available.filter((point) => point.date >= windowStart)
        : available;
      if (sampled.length >= 2) {
        const openingNav = Number(valueOf(sampled[0]));
        let valuePeak = openingNav;
        return {
          anchors: visible.length,
          displayIntervalMinutes: portfolioIntradayDisplayIntervalMinutes["1W"],
          intraday: true,
          rows: sampled.map((point) => {
            const nav = Number(valueOf(point));
            valuePeak = Math.max(valuePeak, nav);
            return {
              contributions: openingNav,
              date: point.date,
              drawdown: nav - valuePeak,
              nav,
              overnight: null,
              pnl: nav - openingNav,
            };
          }),
          valueChangeMode: true,
        };
      }
    }
    if (range === "1M") {
      const available = [...intradayData]
        .filter((point) => point.intraday === true && typeof valueOf(point) === "number")
        .sort((left, right) => left.date.localeCompare(right.date));
      const timeline = omitPortfolioWeekendDisplayWindow(
        naturalCalendarTimeline(
          available,
          portfolioIntradayDisplayIntervalMinutes["1M"],
          monthlyIntradayCalendarDays,
          false,
          true,
        ),
      );
      const visibleIndexes = timeline.rowIndexes.filter(
        (index): index is number => index !== null,
      );
      const sampled = visibleIndexes.map((index) => available[index]);
      const windowStart = timeline.categories.at(0) ?? null;
      const visible = windowStart
        ? available.filter((point) => point.date >= windowStart)
        : available;
      if (sampled.length >= 2) {
        const openingNav = Number(valueOf(sampled[0]));
        let valuePeak = openingNav;
        return {
          anchors: visible.length,
          displayIntervalMinutes: portfolioIntradayDisplayIntervalMinutes["1M"],
          intraday: true,
          rows: sampled.map((point) => {
            const nav = Number(valueOf(point));
            valuePeak = Math.max(valuePeak, nav);
            return {
              contributions: openingNav,
              date: point.date,
              drawdown: nav - valuePeak,
              nav,
              overnight: null,
              pnl: nav - openingNav,
            };
          }),
          valueChangeMode: true,
        };
      }
    }
    const source = daily;
    const start = source.at(-1) ? rangeStart(source.at(-1)!.date, range) : null;
    const visible = cropCumulativeMoneyOutcome(source.map((point) => ({
      contributions: Number(point[keys.contributions]),
      date: point.date,
      drawdown: Number(point[keys.drawdown]),
      nav: Number(point[keys.nav]),
      overnight: view === "cfd" && typeof point.cfdOvernightInterestGbp === "number"
        ? point.cfdOvernightInterestGbp
        : null,
      pnl: Number(point[keys.pnl]),
    })), start);
    if (visible.length < 2) {
      return {
        anchors: latestIntraday.length,
        displayIntervalMinutes: null,
        intraday: false,
        rows: [],
        valueChangeMode: false,
      };
    }
    return {
      anchors: latestIntraday.length,
      displayIntervalMinutes: null,
      intraday: false,
      rows: visible,
      valueChangeMode: false,
    };
  }, [carriedCfdValue, data, intradayData, range, view]);
  // Daily ranges crop the visible timeline, but the money result remains the
  // actual cumulative account outcome. Rebasing here would erase gains or
  // losses that pre-date the selected window, including carried CFD P&L from
  // the all-account view. Short intraday ranges build value-change rows above.
  const rows = rawRows;
  const rateBase = useMemo(
    () => view === "cfd" ? stableMoneyRateBase(rawRows, false) : null,
    [rawRows, view],
  );
  const rateFor = (value: number, contributions: number) =>
    rateBase == null
      ? netPnlRate(value, contributions)
      : relativeMoneyRate(value, rateBase);
  const latest = rows.at(-1) ?? null;
  const maxDrawdown = rows.reduce((minimum, point) => Math.min(minimum, point.drawdown), 0);
  const latestNetPnlRate = latest
    ? rateFor(latest.pnl, latest.contributions)
    : null;
  const latestDrawdownRate = latest
    ? rateFor(latest.drawdown, latest.contributions)
    : null;
  const maxDrawdownRate = rows.reduce<number | null>((minimum, point) => {
    const rate = rateFor(point.drawdown, point.contributions);
    return rate == null ? minimum : minimum == null ? rate : Math.min(minimum, rate);
  }, null);
  const displayedContributions = latest?.contributions ?? null;
  const firstCarriedIndex = view === "household" && cfdCutoffDate
    ? rows.findIndex((row) => row.date.slice(0, 10) > cfdCutoffDate)
    : -1;
  const carriesCfdForward = firstCarriedIndex >= 0 && typeof carriedCfdValue === "number";
  const showCarryTransition = carriesCfdForward && !cfdRetired;
  const carriedLineStartIndex = firstCarriedIndex > 0 ? firstCarriedIndex - 1 : 0;
  const intradayTimeline = useMemo(
    () => {
      if (!intraday) return null;
      const timeline = naturalCalendarTimeline(
        rows,
        displayIntervalMinutes ?? portfolioIntradayDisplayIntervalMinutes["1D"],
        range === "1W"
          ? 7
          : range === "1M"
            ? monthlyIntradayCalendarDays
            : 1,
        range === "1D",
        range === "1M",
      );
      return range === "1W" || range === "1M"
        ? omitPortfolioWeekendDisplayWindow(timeline)
        : timeline;
    },
    [displayIntervalMinutes, intraday, range, rows],
  );
  const timelineCoverage = useMemo(
    () => intradayTimeline
      ? summarizeTimelineCoverage(intradayTimeline.categories, intradayTimeline.rowIndexes)
      : null,
    [intradayTimeline],
  );
  const displayTimeline = useMemo(() => {
    if (!intradayTimeline) return null;
    if (
      range !== "1D"
      || timelineCoverage?.firstObservedIndex == null
      || timelineCoverage.lastObservedIndex == null
    ) {
      return { ...intradayTimeline, startIndex: 0 };
    }
    const startIndex = timelineCoverage.firstObservedIndex;
    const endIndex = timelineCoverage.lastObservedIndex + 1;
    return {
      categories: intradayTimeline.categories.slice(startIndex, endIndex),
      rowIndexes: intradayTimeline.rowIndexes.slice(startIndex, endIndex),
      startIndex,
    };
  }, [intradayTimeline, range, timelineCoverage]);
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const colour = lineColour(view, chartColours);
    const labels = axisTimestampLabels(rows.map((row) => row.date), locale, timeZone);
    const navLabel = view === "cfd"
      ? locale === "zh" ? "CFD 已实现权益" : "CFD realised equity"
      : view === "household"
        ? locale === "zh" ? "全部账户价值" : "All-account value"
        : locale === "zh" ? "原始净值" : "Raw NAV";
    const carriedNavLabel = locale === "zh"
      ? "全部账户价值（CFD 沿用最后导入值）"
      : "All-account value (CFD carried forward)";
    const contributionLabel = valueChangeMode
      ? locale === "zh" ? "区间起始价值" : "Opening period value"
      : view === "cfd"
        ? locale === "zh" ? "账户累计资金流" : "Cumulative account cash flow"
        : view === "household"
          ? locale === "zh" ? "家庭累计外部净入金" : "Household external contributions"
          : locale === "zh" ? "累计净入金" : "Net contributions";
    const accountLabel = performanceAccountViews.find((item) => item.key === view)?.[locale] ?? view;
    const pnlLabel = pnlDisplayMode === "money"
      ? valueChangeMode
        ? locale === "zh" ? "区间价值变化" : "Period value change"
        : locale === "zh" ? "净盈亏" : "Net P&L"
      : valueChangeMode
        ? locale === "zh" ? "区间价值变化率" : "Period value-change rate"
        : locale === "zh" ? "净盈亏率" : "Net P&L rate";
    const drawdownLabel = pnlDisplayMode === "money"
      ? valueChangeMode
        ? locale === "zh" ? "价值变化回撤" : "Value-change drawdown"
        : locale === "zh" ? "盈亏回撤" : "P&L drawdown"
      : valueChangeMode
        ? locale === "zh" ? "价值变化回撤率" : "Value-change drawdown rate"
        : locale === "zh" ? "盈亏回撤率" : "P&L drawdown rate";
    const overnightLabel = locale === "zh" ? "累计隔夜融资" : "Cumulative overnight financing";
    const currencyTooltip = (value: unknown) =>
      formatCurrency(Number(value), locale, "GBP", 2);
    const pnlTooltip = pnlDisplayMode === "money"
      ? currencyTooltip
      : (value: unknown) => formatDeltaPercent(Number(value), locale, 2);
    const rateValue = (value: number, contributions: number) =>
      rateBase == null
        ? netPnlRate(value, contributions)
        : relativeMoneyRate(value, rateBase);
    const pnlRates = rows.map((row) => rateValue(row.pnl, row.contributions));
    const drawdownRates = rows.map((row) => rateValue(row.drawdown, row.contributions));
    const openingContributions = rawRows.at(0)?.contributions ?? 0;
    const rowIndex = new Map(rows.map((row, index) => [row.date, index]));
    const compactCategories = displayTimeline?.categories ?? rows.map((row) => row.date);
    const compactRowIndexes = displayTimeline?.rowIndexes ?? rows.map((_, index) => index);
    const seriesData = (valueOf: (row: (typeof rows)[number], index: number) => number | null) => intraday
      ? compactRowIndexes.map((index) => index == null ? null : valueOf(rows[index], index))
      : rows.map(valueOf);
    const navValue = (row: (typeof rows)[number], index: number) =>
      showCarryTransition && index >= firstCarriedIndex ? null : row.nav;
    const contributionValue = (row: (typeof rows)[number]) => row.contributions;
    const pnlValue = (row: (typeof rows)[number], index: number) =>
      pnlDisplayMode === "money" ? row.pnl : pnlRates[index];
    const drawdownValue = (row: (typeof rows)[number], index: number) =>
      pnlDisplayMode === "money" ? row.drawdown : drawdownRates[index];
    const navData = seriesData(navValue);
    const contributionData = seriesData(contributionValue);
    const pnlData = seriesData(pnlValue);
    const drawdownData = seriesData(drawdownValue);
    const bridgeSeries = (
      data: ReturnType<typeof gapBridgeSegments<(typeof rows)[number]>>,
      color: string,
      xAxisIndex: number,
      yAxisIndex: number,
      width: number,
    ) => data.length ? [{
      animation: false,
      data: Array.from<number | null>({ length: compactCategories.length }).fill(null),
      emphasis: { disabled: true },
      markLine: {
        data: data.map((bridge) => ([
          { coord: [compactCategories[bridge.fromIndex], bridge.fromValue] },
          { coord: [compactCategories[bridge.toIndex], bridge.toValue] },
        ] as [
          { coord: [string, number] },
          { coord: [string, number] },
        ])),
        label: { show: false },
        lineStyle: { color, opacity: 0.68, type: "dashed" as const, width },
        silent: true,
        symbol: ["none", "none"] as [string, string],
      },
      silent: true,
      showSymbol: false,
      tooltip: { show: false },
      type: "line" as const,
      xAxisIndex,
      yAxisIndex,
      z: 1,
    }] : [];
    const internalGapBridges = intraday ? {
      contributions: gapBridgeSegments(compactRowIndexes, rows, contributionValue),
      drawdown: gapBridgeSegments(compactRowIndexes, rows, drawdownValue),
      nav: gapBridgeSegments(compactRowIndexes, rows, navValue),
      pnl: gapBridgeSegments(compactRowIndexes, rows, pnlValue),
    } : { contributions: [], drawdown: [], nav: [], pnl: [] };
    const compactAxisLabel = (value: string, index: number) => {
      if (range === "1D") {
        return formatDate(value, locale, { hour: "2-digit", minute: "2-digit", timeZone });
      }
      const previous = index > 0 ? compactCategories[index - 1] : null;
      return !previous || portfolioCalendarDateKey(previous) !== portfolioCalendarDateKey(value)
        ? formatDate(value, locale, { day: "numeric", month: "short", timeZone })
        : "";
    };
    return {
      animationDuration: 240,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: [
        { containLabel: true, height: "32%", left: 8, right: 14, top: 52 },
        { containLabel: true, height: "22%", left: 8, right: 14, top: "49%" },
        { bottom: 30, containLabel: true, height: "13%", left: 8, right: 14 },
      ],
      legend: {
        data: [navLabel, ...(showCarryTransition ? [carriedNavLabel] : []), contributionLabel],
        itemGap: 24,
        itemHeight: 10,
        itemWidth: 20,
        left: 8,
        textStyle: { color: chartColours.axis },
        top: 4,
      },
      tooltip: {
        backgroundColor: chartColours.tooltip,
        borderColor: chartColours.border,
        borderWidth: 1,
        confine: true,
        extraCssText: "box-shadow: 0 18px 48px rgba(17, 24, 39, 0.16); border-radius: 12px;",
        formatter: (params: unknown) => {
          const items = Array.isArray(params)
            ? params as Array<{ axisValue?: number | string; dataIndex?: number }>
            : [];
          const dataIndex = Number(items.at(0)?.dataIndex ?? -1);
          const compactRowIndex = compactRowIndexes[dataIndex];
          const row = intraday
            ? compactRowIndex == null ? null : rows[compactRowIndex]
            : rows[dataIndex];
          if (!row) return "";

          const rowPosition = rowIndex.get(row.date) ?? dataIndex;
          const pnlRate = pnlRates[rowPosition] ?? null;
          const drawdownRate = drawdownRates[rowPosition] ?? null;
          const flow = valueChangeMode
            ? openingContributions
            : row.contributions;
          const flowLabel = valueChangeMode
            ? locale === "zh" ? "区间起始价值" : "Opening period value"
            : contributionLabel;
          const pnlTone = row.pnl < 0 ? chartColours.negative : chartColours.positive;
          const resultLabel = valueChangeMode
            ? locale === "zh" ? "区间价值变化" : "Period value change"
            : locale === "zh" ? "累计净盈亏" : "Cumulative net P&L";
          const resultRate = formatDeltaPercent(pnlRate, locale, 2);
          const drawdownRateText = formatDeltaPercent(drawdownRate, locale, 2);
          const basis = rateBase == null
            ? ""
            : `<div style="display:flex;justify-content:space-between;gap:24px;color:${chartColours.axis};font-size:12px"><span>${locale === "zh" ? "百分比资金基准" : "Percentage capital base"}</span><span>${formatCurrency(rateBase, locale, "GBP", 0)}</span></div>`;
          const overnight = view === "cfd" && row.overnight != null
            ? `<div style="display:flex;justify-content:space-between;gap:24px;color:${chartColours.axis};font-size:12px"><span>${overnightLabel}</span><span>${formatCurrency(row.overnight, locale, "GBP", 2)}</span></div>`
            : "";
          return `<div style="min-width:300px;color:${chartColours.canvas};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:4px">
              <div style="display:flex;align-items:center;gap:8px"><span style="padding:4px 8px;border-radius:6px;background:${chartColours.brand};color:${chartColours.canvas};font-size:12px;font-weight:750">${accountLabel}</span><strong style="font-size:14px">${range}</strong></div>
              <span style="color:${chartColours.axis};font-size:12px">${pnlDisplayMode === "money" ? "£" : "%"}</span>
            </div>
            <div style="margin-bottom:12px;color:${chartColours.axis};font-size:13px">${detailedTimestampLabel(row.date, locale, timeZone)}</div>
            <div style="display:grid;gap:8px;padding:10px;border-radius:10px;background:${chartColours.grid}">
              <div style="display:flex;justify-content:space-between;gap:24px;align-items:baseline"><strong>${resultLabel}</strong><strong style="color:${pnlTone};font-size:16px">${formatCurrency(row.pnl, locale, "GBP", 2)} · ${resultRate}</strong></div>
              <div style="display:flex;justify-content:space-between;gap:24px;align-items:baseline"><span>${valueChangeMode ? locale === "zh" ? "价值变化回撤" : "Value-change drawdown" : locale === "zh" ? "当前盈亏回撤" : "Current P&L drawdown"}</span><strong style="color:${chartColours.negative}">${formatCurrency(row.drawdown, locale, "GBP", 2)} · ${drawdownRateText}</strong></div>
            </div>
            <div style="display:grid;gap:6px;margin-top:10px">
              <div style="display:flex;justify-content:space-between;gap:24px;color:${chartColours.axis};font-size:12px"><span>${navLabel}</span><span>${formatCurrency(row.nav, locale, "GBP", 2)}</span></div>
              <div style="display:flex;justify-content:space-between;gap:24px;color:${chartColours.axis};font-size:12px"><span>${flowLabel}</span><span>${formatCurrency(flow, locale, "GBP", 2)}</span></div>
              ${basis}
              ${overnight}
            </div>
          </div>`;
        },
        trigger: "axis",
      },
      xAxis: intraday ? [
        { axisLabel: { color: chartColours.axis, show: false }, axisLine: { show: false }, axisTick: { show: false }, boundaryGap: false, data: compactCategories, gridIndex: 0, type: "category" },
        { axisLabel: { color: chartColours.axis, show: false }, axisLine: { show: false }, axisTick: { show: false }, boundaryGap: false, data: compactCategories, gridIndex: 1, type: "category" },
        { axisLabel: { color: chartColours.axis, formatter: compactAxisLabel, hideOverlap: true, interval: 0 }, axisLine: { show: false }, axisTick: { show: false }, boundaryGap: false, data: compactCategories, gridIndex: 2, type: "category" },
      ] : [
        { axisLabel: { color: chartColours.axis, show: false }, axisLine: { show: false }, data: rows.map((row) => row.date), gridIndex: 0, type: "category" },
        { axisLabel: { color: chartColours.axis, show: false }, axisLine: { show: false }, data: rows.map((row) => row.date), gridIndex: 1, type: "category" },
        { axisLabel: { color: chartColours.axis, formatter: (value: string) => labels.get(value) ?? dateLabel(value, locale, timeZone), hideOverlap: true }, axisLine: { show: false }, data: rows.map((row) => row.date), gridIndex: 2, type: "category" },
      ],
      yAxis: [
        { axisLabel: { color: chartColours.axis, formatter: (value: number) => valueChangeMode ? formatDetailedMoneyAxis(value, locale) : formatCompactCurrency(value, locale, "GBP") }, gridIndex: 0, name: valueChangeMode ? locale === "zh" ? "账户价值 / 起始值" : "Account value / opening value" : locale === "zh" ? "净值 / 净入金" : "NAV / contributions", nameGap: 8, nameTextStyle: { color: chartColours.axis, fontSize: 11 }, scale: true, splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } }, type: "value" },
        { axisLabel: { color: chartColours.axis, formatter: (value: number) => pnlDisplayMode === "money" ? formatCompactCurrency(value, locale, "GBP") : formatDeltaPercent(value, locale, 1) }, gridIndex: 1, name: pnlLabel, nameGap: 8, nameTextStyle: { color: chartColours.axis, fontSize: 11 }, splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } }, type: "value" },
        { axisLabel: { color: chartColours.axis, formatter: (value: number) => pnlDisplayMode === "money" ? formatCompactCurrency(value, locale, "GBP") : formatDeltaPercent(value, locale, 1) }, gridIndex: 2, max: 0, name: drawdownLabel, nameGap: 8, nameTextStyle: { color: chartColours.axis, fontSize: 11 }, splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } }, type: "value" },
      ],
      series: [
        ...bridgeSeries(internalGapBridges.nav, colour, 0, 0, 1.5),
        ...bridgeSeries(internalGapBridges.contributions, chartColours.axis, 0, 0, 1.2),
        ...bridgeSeries(internalGapBridges.pnl, chartColours.positive, 1, 1, 1.5),
        ...bridgeSeries(internalGapBridges.drawdown, chartColours.negative, 2, 2, 1.35),
        {
          areaStyle: { color: colour, opacity: intraday ? 0.04 : 0.08 },
          data: navData,
          lineStyle: { color: colour, width: 2 },
          markArea: intraday && displayTimeline && timelineCoverage?.gaps.length ? {
            data: timelineCoverage.gaps.flatMap((gap) => {
              const start = Math.max(gap.startIndex - displayTimeline.startIndex, 0);
              const end = Math.min(
                gap.endIndex - displayTimeline.startIndex,
                displayTimeline.categories.length - 1,
              );
              if (end < 0 || start >= displayTimeline.categories.length || start > end) return [];
              return [[
                { xAxis: displayTimeline.categories[start] },
                { xAxis: displayTimeline.categories[end] },
              ]];
            }),
            itemStyle: { color: "rgba(100, 116, 139, 0.07)" },
            label: { show: false },
            silent: true,
          } : undefined,
          markLine: showCarryTransition && firstCarriedIndex > 0 ? {
            data: [{ xAxis: rows[firstCarriedIndex - 1].date }],
            label: {
              formatter: locale === "zh"
                ? `CFD 数据截至 ${cfdCutoffDate}`
                : `CFD data through ${cfdCutoffDate}`,
              position: "insideEndTop",
            },
            lineStyle: {
              color: cfdStatus?.isStale ? chartColours.warning : chartColours.axis,
              type: "dashed",
              width: 1.5,
            },
            symbol: ["none", "none"],
          } : undefined,
          name: navLabel,
          showSymbol: intraday && (timelineCoverage?.status === "single" || rows.length <= 24),
          smooth: intraday ? false : 0.12,
          tooltip: { valueFormatter: currencyTooltip },
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
        },
        ...(showCarryTransition ? [{
          data: seriesData((row, index) => index >= carriedLineStartIndex ? row.nav : null),
          lineStyle: { color: colour, type: "dashed" as const, width: 2 },
          name: carriedNavLabel,
          showSymbol: false,
          smooth: intraday ? false : 0.12,
          tooltip: { valueFormatter: currencyTooltip },
          type: "line" as const,
          xAxisIndex: 0,
          yAxisIndex: 0,
        }] : []),
        { data: contributionData, lineStyle: { color: chartColours.axis, type: "dashed", width: 1.6 }, name: contributionLabel, showSymbol: false, smooth: intraday ? false : 0.08, tooltip: { valueFormatter: currencyTooltip }, type: "line", xAxisIndex: 0, yAxisIndex: 0 },
        { areaStyle: { color: chartColours.positive, opacity: intraday ? 0.04 : 0.1 }, data: pnlData, lineStyle: { color: chartColours.positive, width: 2 }, name: pnlLabel, showSymbol: false, smooth: intraday ? false : 0.12, tooltip: { valueFormatter: pnlTooltip }, type: "line", xAxisIndex: 1, yAxisIndex: 1 },
        { areaStyle: { color: chartColours.negative, opacity: intraday ? 0.05 : 0.12 }, data: drawdownData, lineStyle: { color: chartColours.negative, width: 1.6 }, name: drawdownLabel, showSymbol: false, smooth: intraday ? false : 0.1, tooltip: { valueFormatter: pnlTooltip }, type: "line", xAxisIndex: 2, yAxisIndex: 2 },
      ],
    };
  }, [carriedLineStartIndex, cfdCutoffDate, cfdStatus?.isStale, chartColours, displayTimeline, firstCarriedIndex, intraday, locale, pnlDisplayMode, range, rateBase, rawRows, rows, showCarryTransition, timeZone, timelineCoverage, valueChangeMode, view]);
  const chartRef = useECharts(option);
  const valueMetricLabel = view === "cfd"
    ? locale === "zh" ? "当前已实现权益" : "Current realised equity"
    : view === "household"
      ? locale === "zh" ? "当前全部账户价值" : "Current all-account value"
      : locale === "zh" ? "当前净值" : "Current NAV";
  const contributionMetricLabel = valueChangeMode
    ? locale === "zh" ? "日内现金流" : "Intraday cash flow"
    : view === "cfd"
      ? locale === "zh" ? "账户累计资金流" : "Account cash flow"
    : view === "household"
      ? locale === "zh" ? "家庭外部净入金" : "Household external contributions"
      : locale === "zh" ? "累计净入金" : "Net contributions";
  const pnlMetricLabel = valueChangeMode
    ? locale === "zh" ? "区间价值变化" : "Period value change"
    : view === "cfd"
      ? locale === "zh" ? "累计净已实现损益" : "Net realised P&L"
    : locale === "zh" ? "净盈亏" : "Net P&L";
  const rateBasisLabel = valueChangeMode
    ? locale === "zh" ? "相对首个可用锚点" : "vs first available anchor"
    : view === "cfd"
      ? locale === "zh" ? "相对稳定资金基准" : "vs stable capital base"
      : locale === "zh" ? "相对累计净入金" : "vs net contributions";
  const currentDrawdownLabel = valueChangeMode
    ? locale === "zh" ? "当前价值变化回撤" : "Current value-change drawdown"
    : locale === "zh" ? "当前盈亏回撤" : "Current P&L drawdown";
  const maxDrawdownLabel = valueChangeMode
    ? locale === "zh" ? "最大价值变化回撤" : "Max value-change drawdown"
    : locale === "zh" ? "最大盈亏回撤" : "Max P&L drawdown";

  return (
    <Stack gap="md">
      {!hideControls ? mobile ? (
        <SimpleGrid cols={fixedView ? 1 : 2}>
          {!fixedView ? (
            <Select
              allowDeselect={false}
              aria-label={locale === "zh" ? "选择账户" : "Select account"}
              data={performanceAccountViews.map((item) => ({
                label: item.key === "household"
                  ? locale === "zh" ? "全部账户（含 CFD）" : "All accounts (incl. CFD)"
                  : item[locale],
                value: item.key,
              }))}
              label={locale === "zh" ? "账户" : "Account"}
              onChange={(value) => value && updateView(value as MoneyView)}
              value={view}
            />
          ) : null}
          <Select
            allowDeselect={false}
            aria-label={locale === "zh" ? "选择区间" : "Select range"}
            data={[...performanceRanges]}
            label={locale === "zh" ? "区间" : "Range"}
            onChange={(value) => value && updateRange(value as RangeKey)}
            value={range}
          />
        </SimpleGrid>
      ) : (
        <Group align="flex-end" className="tm-performance-filters" justify="flex-end" wrap="wrap">
          {!fixedView ? (
            <Stack align="flex-start" gap={4}>
              <Text c="dimmed" fw={700} size="xs">
                {locale === "zh" ? "账户" : "Account"}
              </Text>
              <SegmentedControl
                aria-label={locale === "zh" ? "选择账户" : "Select account"}
                className="tm-performance-selector"
                color="brand"
                data={performanceAccountViews.map((item) => ({ label: item[locale], value: item.key }))}
                onChange={(value) => updateView(value as MoneyView)}
                value={view}
              />
            </Stack>
          ) : null}
          <Stack align="flex-start" gap={4}>
            <Text c="dimmed" fw={700} size="xs">
              {locale === "zh" ? "区间" : "Range"}
            </Text>
            <SegmentedControl
              aria-label={locale === "zh" ? "选择区间" : "Select range"}
              className="tm-performance-selector"
              color="brand"
              data={[...performanceRanges]}
              onChange={(value) => updateRange(value as RangeKey)}
              value={range}
            />
          </Stack>
        </Group>
      ) : null}
      {!rows.length ? (
        <Alert color="gray" icon={<Info size={18} />} title={locale === "zh" ? "数据不足" : "Not enough data"}>
          <Stack gap="sm">
            <Text size="sm">
              {range === "1D"
                ? messages.charts.intradayCollectingTitle.replace("{count}", String(Math.min(anchors, 2)))
                : locale === "zh" ? "所选范围没有足够的资金轨迹。" : "Not enough money history is available for this range."}
            </Text>
            <Group gap="xs">
              <Button onClick={() => updateRange("YTD")} size="xs" variant="light">
                {locale === "zh" ? "查看今年" : "View YTD"}
              </Button>
              <Button component={Link} href="/health" size="xs" variant="subtle">
                {locale === "zh" ? "检查数据状态" : "Check data status"}
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : (
        <Stack gap="md">
          <Grid className="tm-performance-metrics" gap="md">
            <Grid.Col span={{ base: 6, md: "auto" }}>
              <MoneyMetric onDark label={valueMetricLabel} value={latest?.nav ?? null} />
            </Grid.Col>
            {!valueChangeMode ? (
              <Grid.Col span={{ base: 6, md: "auto" }}>
                <MoneyMetric onDark label={contributionMetricLabel} value={displayedContributions} />
              </Grid.Col>
            ) : null}
            <Grid.Col span={{ base: 6, md: "auto" }}>
              <MoneyMetric
                label={pnlMetricLabel}
                onDark
                secondaryLabel={rateBasisLabel}
                secondaryValue={latestNetPnlRate}
                tone
                value={latest?.pnl ?? null}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, md: "auto" }}>
              <MoneyMetric onDark label={currentDrawdownLabel} secondaryLabel={rateBasisLabel} secondaryValue={latestDrawdownRate} tone value={latest?.drawdown ?? null} />
            </Grid.Col>
            <Grid.Col
              span={{ base: !valueChangeMode && view !== "cfd" ? 12 : 6, md: "auto" }}
              ta={{ base: !valueChangeMode && view !== "cfd" ? "center" : "left", md: "left" }}
            >
              <MoneyMetric onDark label={maxDrawdownLabel} secondaryLabel={rateBasisLabel} secondaryValue={maxDrawdownRate} tone value={maxDrawdown} />
            </Grid.Col>
            {view === "cfd" ? (
              <Grid.Col span={{ base: 6, md: "auto" }}>
                <MoneyMetric
                  label={locale === "zh" ? "累计隔夜融资" : "Overnight financing"}
                  onDark
                  tone
                  value={latest?.overnight ?? null}
                />
              </Grid.Col>
            ) : null}
          </Grid>
          {carriesCfdForward && !cfdRetired && cfdStatus?.isStale ? (
            <Alert
              color="yellow"
              icon={<Info size={18} />}
              title={<Localized zh="CFD 数据可能过时" en="CFD data may be stale" />}
            >
              {locale === "zh"
                ? `CFD 数据截至 ${cfdCutoffDate}；此后的全部账户轨迹继续更新 Invest 与 ISA，CFD 固定为 ${formatCurrency(carriedCfdValue, locale, "GBP", 2)}。`
                : `CFD data runs through ${cfdCutoffDate}. After that point, Invest and ISA continue updating while CFD remains fixed at ${formatCurrency(carriedCfdValue, locale, "GBP", 2)}.`}
            </Alert>
          ) : null}
          <ChartShell
            ariaLabel={valueChangeMode
              ? locale === "zh" ? "账户价值、区间价值变化与回撤图" : "Account value, period value change, and drawdown chart"
              : locale === "zh" ? "净值、净入金、净盈亏与回撤图" : "NAV, contributions, net P&L, and drawdown chart"}
            description={valueChangeMode
              ? locale === "zh"
                ? `${range === "1D" ? "1 日" : range === "1W" ? "1 周" : "1 月"}图基于已保存的券商价值记录；日内现金流未经核对，因此这里显示价值变化而非 TWR 或净盈亏。横轴按自然日连续排列，真实缺失的采集时段保留为空白。`
                : `The ${range === "1D" ? "one-day" : range === "1W" ? "one-week" : "one-month"} chart uses retained broker-value observations. Intraday cash flows are unverified, so this is value change rather than TWR or net P&L. The axis follows continuous calendar days and preserves genuine collection gaps as blanks.`
              : intraday ? messages.charts.intradayMoneyFootnote : messages.charts.moneyFootnote}
            height="clamp(500px, 72vw, 650px)"
            headerAction={(
              <Group align="center" gap="sm" wrap="wrap">
                {valueChangeMode ? (
                  <Badge color="gray" variant="light">
                    <Localized zh="未现金流调整" en="Not cash-flow adjusted" />
                  </Badge>
                ) : null}
                {!hideControls ? <Group align="center" gap="xs" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {valueChangeMode
                      ? locale === "zh" ? "变化与回撤单位" : "Change and drawdown unit"
                      : locale === "zh" ? "盈亏与回撤单位" : "P&L and drawdown unit"}
                  </Text>
                  <SegmentedControl
                    aria-label={valueChangeMode
                      ? locale === "zh" ? "选择价值变化与回撤单位" : "Select value change and drawdown unit"
                      : locale === "zh" ? "选择盈亏与回撤单位" : "Select P&L and drawdown unit"}
                    className="tm-performance-selector"
                    color="brand"
                    data={[
                      { label: "£", value: "money" },
                      { label: "%", value: "rate" },
                    ]}
                    onChange={(value) => updateDisplayMode(value as PnlDisplayMode)}
                    size="sm"
                    value={pnlDisplayMode}
                  />
                </Group> : null}
              </Group>
            )}
            title={locale === "zh" ? "账户资金轨迹" : "Account money history"}
          >
            <div className="tm-money-chart-content">
              {intraday && timelineCoverage ? (
                <TimelineCoverage
                  context={range === "1W" ? "week" : range === "1M" ? "month" : "day"}
                  summary={timelineCoverage}
                />
              ) : null}
              <div className="tm-money-chart-plot" ref={chartRef} />
            </div>
          </ChartShell>
          <Accordion variant="contained">
            <Accordion.Item value="recent-money-data">
              <Accordion.Control>
                {locale === "zh" ? "最近数据" : "Recent data"}
              </Accordion.Control>
              <Accordion.Panel>
                <Table.ScrollContainer minWidth={520}>
                  <Table aria-label={locale === "zh" ? "最近资金数据" : "Recent money data"} striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{locale === "zh" ? "日期" : "Date"}</Table.Th>
                        <Table.Th ta="right">{locale === "zh" ? "账户价值" : "Account value"}</Table.Th>
                        <Table.Th ta="right">{pnlMetricLabel}</Table.Th>
                        <Table.Th ta="right">{currentDrawdownLabel}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rows.slice(-5).reverse().map((row) => (
                        <Table.Tr key={row.date}>
                          <Table.Td>{formatDate(row.date, locale)}</Table.Td>
                          <Table.Td ta="right">{formatCurrency(row.nav, locale, "GBP", 0)}</Table.Td>
                          <Table.Td ta="right">
                            {pnlDisplayMode === "money"
                              ? formatCurrency(row.pnl, locale, "GBP", 0)
                              : formatDeltaPercent(rateFor(row.pnl, row.contributions), locale, 1)}
                          </Table.Td>
                          <Table.Td ta="right">
                            {pnlDisplayMode === "money"
                              ? formatCurrency(row.drawdown, locale, "GBP", 0)
                              : formatDeltaPercent(rateFor(row.drawdown, row.contributions), locale, 1)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
      )}
    </Stack>
  );
}

function MoneyMetric({
  label,
  onDark = false,
  secondaryLabel,
  secondaryValue,
  tone = false,
  value,
}: {
  label: string;
  onDark?: boolean;
  secondaryLabel?: string;
  secondaryValue?: number | null;
  tone?: boolean;
  value: number | null;
}) {
  const { locale } = useLocale();
  let colour: "green" | "red" | undefined;
  if (tone && value != null && value !== 0) {
    colour = value < 0 ? "red" : "green";
  }
  return (
    <div>
      <Text c={onDark ? "brand.1" : "dimmed"} size="xs">{label}</Text>
      <Text c={colour ?? (onDark ? "white" : undefined)} fw={750} size="lg">
        {formatCurrency(value, locale, "GBP", 0)}
      </Text>
      {secondaryLabel ? (
        <Text c={colour ?? (onDark ? "brand.1" : "dimmed")} size="xs">
          {secondaryLabel} · {formatDeltaPercent(secondaryValue, locale, 1)}
        </Text>
      ) : null}
    </div>
  );
}

export function StrategyPerformanceChart({
  benchmarkSeries = {},
  data,
  embedded = false,
  fixedRange,
  fixedView,
  hideControls = false,
  onRangeChange,
  onViewChange,
}: {
  benchmarkSeries?: Record<string, BenchmarkPricePoint[]>;
  data: NavPoint[];
  embedded?: boolean;
  fixedRange?: RangeKey;
  fixedView?: StrategyView;
  hideControls?: boolean;
  onRangeChange?: (range: RangeKey) => void;
  onViewChange?: (view: StrategyView) => void;
}) {
  const { locale, timeZone } = useLocale();
  const mobile = useMediaQuery("(max-width: 48em)");
  const chartColours = useChartColours();
  const messages = useMessages();
  const params = useSearchParams();
  const requestedView = params.get("strategyAccount") as StrategyView | null;
  const requestedRange = params.get("strategyRange") as RangeKey | null;
  const [selectedView, setSelectedView] = useState<StrategyView>(
    strategyViews.some((item) => item.key === requestedView) ? requestedView! : "total",
  );
  const [selectedRange, setSelectedRange] = useState<RangeKey>(
    strategyRanges.includes(requestedRange as (typeof strategyRanges)[number])
      ? requestedRange!
      : "YTD",
  );
  const view = fixedView ?? selectedView;
  const range = fixedRange ?? selectedRange;
  const requestedBenchmarks = Object.keys(benchmarkSeries);
  const updateView = (next: StrategyView) => {
    setSelectedView(next);
    onViewChange?.(next);
    if (!fixedView) {
      replaceUrlState({ strategyAccount: next === "total" ? null : next });
    }
  };
  const updateRange = (next: RangeKey) => {
    setSelectedRange(next);
    onRangeChange?.(next);
    if (!fixedRange) {
      replaceUrlState({ strategyRange: next === "YTD" ? null : next });
    }
  };
  const rows = useMemo(() => {
    if (range === "1D") return [];
    const twrKey = twrKeys[view];
    const source = data.filter(
      (point) => !point.intraday && typeof point[twrKey] === "number",
    );
    const start = source.at(-1) ? rangeStart(source.at(-1)!.date, range) : null;
    const visible = start ? source.filter((point) => point.date >= start) : source;
    if (visible.length < 2) return [];
    const benchmarkMaps = Object.entries(benchmarkSeries)
      .map(([label, points]) => [
        label,
        new Map(
          points
            .filter((point) => Number.isFinite(point.close))
            .map((point) => [point.date.slice(0, 10), point.close]),
        ),
      ] as const)
      .filter(([, points]) => points.size >= 2);
    const aligned = benchmarkMaps.length
      ? visible.filter((point) => benchmarkMaps.every(([, points]) => (
          points.has(point.date.slice(0, 10))
        )))
      : [];
    const comparisonReady = benchmarkMaps.length > 0 && aligned.length >= 2;
    const selected = comparisonReady ? aligned : visible;
    const first = Number(selected[0][twrKey]);
    const firstBenchmarks = comparisonReady
      ? Object.fromEntries(benchmarkMaps.map(([label, points]) => [
          label,
          points.get(selected[0].date.slice(0, 10)) ?? null,
        ]))
      : {};
    if (!Number.isFinite(first)) return [];
    let peak = 1;
    return selected.map((point) => {
      const wealth = (1 + Number(point[twrKey])) / (1 + first);
      peak = Math.max(peak, wealth);
      const benchmarks = comparisonReady
        ? Object.fromEntries(benchmarkMaps.map(([label, points]) => {
            const firstClose = firstBenchmarks[label];
            const close = points.get(point.date.slice(0, 10)) ?? null;
            return [
              label,
              close != null && firstClose != null && firstClose !== 0
                ? close / firstClose - 1
                : null,
            ];
          }))
        : {};
      return {
        benchmarks,
        date: point.date,
        drawdown: wealth / peak - 1,
        value: wealth - 1,
      };
    });
  }, [benchmarkSeries, data, range, view]);
  const latest = rows.at(-1)?.value ?? null;
  const activeBenchmarks = requestedBenchmarks.filter((label) => (
    rows.length >= 2 && rows.every((row) => row.benchmarks[label] != null)
  ));
  const missingBenchmarks = requestedBenchmarks.filter((label) => !activeBenchmarks.includes(label));
  const maxDrawdown = rows.reduce((minimum, point) => Math.min(minimum, point.drawdown), 0);
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const colour = lineColour(view, chartColours);
    const labels = axisTimestampLabels(rows.map((row) => row.date), locale, timeZone);
    return {
      animationDuration: 240,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: [
        { bottom: "36%", containLabel: true, left: 8, right: 14, top: 48 },
        { bottom: 30, containLabel: true, height: "22%", left: 8, right: 14 },
      ],
      legend: {
        data: ["TWR", ...activeBenchmarks],
        itemGap: 28,
        itemHeight: 10,
        itemWidth: 24,
        left: 8,
        selectedMode: true,
        textStyle: { color: chartColours.axis },
        top: 4,
      },
      tooltip: {
        trigger: "axis",
        valueFormatter: (value) => formatDeltaPercent(Number(value), locale, 2),
      },
      xAxis: [
        { axisLabel: { color: chartColours.axis, show: false }, axisLine: { show: false }, data: rows.map((row) => row.date), gridIndex: 0, type: "category" },
        { axisLabel: { color: chartColours.axis, formatter: (value: string) => labels.get(value) ?? dateLabel(value, locale, timeZone), hideOverlap: true }, axisLine: { show: false }, data: rows.map((row) => row.date), gridIndex: 1, type: "category" },
      ],
      yAxis: [
        { axisLabel: { color: chartColours.axis, formatter: (value: number) => formatDeltaPercent(value, locale, 1) }, gridIndex: 0, splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } }, type: "value" },
        { axisLabel: { color: chartColours.axis, formatter: (value: number) => formatDeltaPercent(value, locale, 1) }, gridIndex: 1, max: 0, splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } }, type: "value" },
      ],
      series: [
        { areaStyle: { color: colour, opacity: 0.1 }, data: rows.map((row) => row.value), lineStyle: { color: colour, width: 2 }, name: "TWR", showSymbol: false, smooth: 0.16, type: "line", xAxisIndex: 0, yAxisIndex: 0 },
        ...activeBenchmarks.map((label, index) => ({
          data: rows.map((row) => row.benchmarks[label]),
          lineStyle: {
            color: [chartColours.positive, chartColours.secondary, chartColours.accent][index],
            width: 2,
          },
          name: label,
          showSymbol: false,
          smooth: 0.16,
          type: "line" as const,
          xAxisIndex: 0,
          yAxisIndex: 0,
        })),
        { areaStyle: { color: chartColours.negative, opacity: 0.12 }, data: rows.map((row) => row.drawdown), lineStyle: { color: chartColours.negative, width: 1.6 }, name: locale === "zh" ? "回撤" : "Drawdown", showSymbol: false, smooth: 0.12, type: "line", xAxisIndex: 1, yAxisIndex: 1 },
      ],
    };
  }, [activeBenchmarks, chartColours, locale, rows, timeZone, view]);
  const chartRef = useECharts(option);

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Group gap="lg" wrap="wrap">
          <Text fw={700}>TWR <Text c={(latest ?? 0) >= 0 ? "green" : "red"} component="span">{formatDeltaPercent(latest, locale)}</Text></Text>
          {activeBenchmarks.map((label) => {
            const latestBenchmark = rows.at(-1)?.benchmarks[label] ?? null;
            return (
              <Text fw={700} key={label}>
                {label} <Text c={(latestBenchmark ?? 0) >= 0 ? "green" : "red"} component="span">{formatDeltaPercent(latestBenchmark, locale)}</Text>
              </Text>
            );
          })}
          <Text fw={700}>{locale === "zh" ? "最大回撤" : "Max drawdown"} <Text c="red" component="span">{formatDeltaPercent(maxDrawdown, locale)}</Text></Text>
        </Group>
        {!hideControls && !mobile ? (
          <Stack align="flex-end" gap="xs">
            {!fixedView ? (
              <SegmentedControl
                aria-label={locale === "zh" ? "选择 TWR 账户" : "Select TWR account"}
                data={strategyViews.map((item) => ({ label: item[locale], value: item.key }))}
                onChange={(value) => updateView(value as StrategyView)}
                value={view}
              />
            ) : null}
            <SegmentedControl
              aria-label={locale === "zh" ? "选择 TWR 区间" : "Select TWR range"}
              data={[...strategyRanges]}
              onChange={(value) => updateRange(value as RangeKey)}
              value={range}
            />
          </Stack>
        ) : null}
      </Group>
      {!hideControls && mobile ? (
        <SimpleGrid cols={fixedView ? 1 : 2}>
          {!fixedView ? (
            <Select
              allowDeselect={false}
              aria-label={locale === "zh" ? "选择 TWR 账户" : "Select TWR account"}
              data={strategyViews.map((item) => ({ label: item[locale], value: item.key }))}
              label={locale === "zh" ? "账户" : "Account"}
              onChange={(value) => value && updateView(value as StrategyView)}
              value={view}
            />
          ) : null}
          <Select
            allowDeselect={false}
            aria-label={locale === "zh" ? "选择 TWR 区间" : "Select TWR range"}
            data={[...strategyRanges]}
            label={locale === "zh" ? "区间" : "Range"}
            onChange={(value) => value && updateRange(value as RangeKey)}
            value={range}
          />
        </SimpleGrid>
      ) : null}
      {!rows.length ? (
        <Alert color="gray" icon={<Info size={18} />} title={locale === "zh" ? "数据不足" : "Not enough data"}>
          <Stack gap="sm">
            <Text size="sm">
              {range === "1D"
                ? locale === "zh" ? "TWR 按日计算，1 日区间没有足够的日终数据。" : "TWR is calculated daily, so a one-day range has too few closing observations."
                : locale === "zh" ? "所选范围没有可用的 TWR 数据。" : "No TWR data is available for this range."}
            </Text>
            <Group gap="xs">
              <Button onClick={() => updateRange(range === "1D" ? "1W" : "MAX")} size="xs" variant="light">
                {range === "1D"
                  ? locale === "zh" ? "查看 1 周" : "View 1W"
                  : locale === "zh" ? "查看完整历史" : "View full history"}
              </Button>
              <Button component={Link} href="/health" size="xs" variant="subtle">
                {locale === "zh" ? "检查数据状态" : "Check data status"}
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : (
        <Stack gap="md">
          {missingBenchmarks.length ? (
            <Alert color="yellow" icon={<Info size={18} />} title={locale === "zh" ? `${missingBenchmarks.join("、")} 历史等待刷新` : `${missingBenchmarks.join(", ")} history is waiting for refresh`}>
              {locale === "zh"
                ? `当前快照还没有这些基准的日序列；下一次完整刷新后会自动加入真实同期曲线。`
                : `This snapshot does not yet include daily series for these benchmarks. Their real aligned lines will appear after the next full refresh.`}
            </Alert>
          ) : null}
          <ChartShell
            ariaLabel={activeBenchmarks.length
              ? locale === "zh" ? `TWR、${activeBenchmarks.join("、")} 与回撤图` : `TWR, ${activeBenchmarks.join(", ")}, and drawdown chart`
              : locale === "zh" ? "策略收益与回撤图" : "Strategy return and drawdown chart"}
            description={activeBenchmarks.length
              ? locale === "zh"
                ? `TWR 与 ${activeBenchmarks.join("、")} 均从所选区间首个共同交易日归零；点击图例可隐藏或显示任一曲线。${messages.charts.twrFootnote}`
                : `TWR and ${activeBenchmarks.join(", ")} are rebased to zero on their first shared session in the selected range. Use the legend to show or hide any line. ${messages.charts.twrFootnote}`
              : messages.charts.twrFootnote}
            embedded={embedded}
            height="clamp(360px, 58vw, 500px)"
            title={embedded ? undefined : locale === "zh" ? "策略表现（TWR）" : "Strategy performance (TWR)"}
          >
            <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
          </ChartShell>
          <Accordion variant="contained">
            <Accordion.Item value="recent-twr-data">
              <Accordion.Control>
                {locale === "zh" ? "最近数据" : "Recent data"}
              </Accordion.Control>
              <Accordion.Panel>
                <Table aria-label={locale === "zh" ? "最近 TWR 数据" : "Recent TWR data"} striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{locale === "zh" ? "日期" : "Date"}</Table.Th>
                      <Table.Th ta="right">TWR</Table.Th>
                      {activeBenchmarks.map((label) => <Table.Th key={label} ta="right">{label}</Table.Th>)}
                      <Table.Th ta="right">{locale === "zh" ? "回撤" : "Drawdown"}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.slice(-5).reverse().map((row) => (
                      <Table.Tr key={row.date}>
                        <Table.Td>{formatDate(row.date, locale)}</Table.Td>
                        <Table.Td ta="right">{formatDeltaPercent(row.value, locale, 2)}</Table.Td>
                        {activeBenchmarks.map((label) => (
                          <Table.Td key={label} ta="right">{formatDeltaPercent(row.benchmarks[label], locale, 2)}</Table.Td>
                        ))}
                        <Table.Td ta="right">{formatDeltaPercent(row.drawdown, locale, 2)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
      )}
    </Stack>
  );
}

export function AllocationChart({
  embedded = false,
  height = 340,
  holdings,
  showLegend = true,
}: {
  embedded?: boolean;
  height?: number;
  holdings: Holding[];
  showLegend?: boolean;
}) {
  const { locale } = useLocale();
  const rows = useMemo(() => {
    const top = holdings.slice(0, 5);
    const other = holdings.slice(5).reduce((sum, item) => sum + item.currentValueGbp, 0);
    return [
      ...top.map((item) => ({ name: item.ticker, value: item.currentValueGbp })),
      ...(other ? [{ name: locale === "zh" ? "其他" : "Other", value: other }] : []),
    ];
  }, [holdings, locale]);
  const option = useMemo<EChartsOption | null>(() => rows.length ? {
    color: [...categoricalChartColours],
    legend: { bottom: 0, show: showLegend, type: "scroll" },
    series: [{
      data: rows,
      emphasis: { focus: "self" },
      label: { show: false },
      labelLine: { show: false },
      radius: ["52%", "74%"],
      type: "pie",
    }],
    tooltip: {
      trigger: "item",
      valueFormatter: (value) => formatCurrency(Number(value), locale, "GBP", 0),
    },
  } : null, [locale, rows, showLegend]);
  const chartRef = useECharts(option);
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <Stack>
      <ChartShell
        ariaLabel={locale === "zh" ? "当前持仓配置" : "Current allocation"}
        embedded={embedded}
        empty={!rows.length}
        height={height}
      >
        <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
      </ChartShell>
      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        {rows.map((row) => (
          <div key={row.name}>
            <Text c="dimmed" size="xs">{row.name}</Text>
            <Text fw={700}>{total > 0 ? formatPercent(row.value / total, locale) : "—"}</Text>
            <Text c="dimmed" size="xs">{formatCurrency(row.value, locale, "GBP", 0)}</Text>
          </div>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
