"use client";

import {
  Accordion,
  Alert,
  Badge,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ContextHelp } from "@/components/context-help";
import { LensContent, LensError, LensSkeleton } from "@/components/lens-state";
import { Localized, useLocale } from "@/components/locale-provider";
import { LocalMockReveal } from "@/components/local-mock-reveal";
import { PageHeader } from "@/components/page-header";
import {
  MoneyPerformanceChart,
  type StrategyView,
  StrategyPerformanceChart,
} from "@/components/portfolio-charts";
import { ViewSwitch } from "@/components/view-switch";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { pct, ratio } from "@/lib/format";
import {
  mockIntradayMoneyNav,
  mockMoneyNav,
  mockOutageIntradayMoneyNav,
  mockRetiredCfdStatus,
} from "@/lib/mock-money-chart";
import type { DashboardLens, RiskMetrics } from "@/lib/types";
import { replaceUrlState } from "@/lib/url-state";
import { formatDateTime } from "@/ui/formatters";

export function AnalyticsPageView() {
  const params = useSearchParams();
  const mockVariant = params.get("mock");
  const mockMode = process.env.NODE_ENV !== "production"
    && ["money-v2", "money-gap"].includes(mockVariant ?? "");
  const lens = useDashboardLens("analytics", undefined, !mockMode);

  return (
    <Stack gap="xl">
      <PageHeader
        actions={mockMode ? <Badge color="blue">Synthetic mock · local only</Badge> : null}
        description={<Localized zh="账户价值、净入金、净盈亏和风险。" en="Account value, net contributions, net P&L, and risk." />}
        title={<Localized zh="绩效与风险" en="Performance & risk" />}
      />

      {mockMode ? (
        <LocalMockReveal>
          <MockMoneyChartPreview outage={mockVariant === "money-gap"} />
        </LocalMockReveal>
      ) : null}
      {!mockMode && lens.isPending ? <LensSkeleton cards={2} height={340} /> : null}
      {!mockMode && lens.isError ? <LensError retry={() => void lens.refetch()} /> : null}
      {!mockMode && lens.data ? <LensContent><AnalyticsLens data={lens.data} /></LensContent> : null}
    </Stack>
  );
}

function MockMoneyChartPreview({ outage = false }: { outage?: boolean }) {
  const { locale } = useLocale();
  return (
    <Stack gap="md">
      <Alert color="blue" title={locale === "zh" ? "本地交互样稿" : "Local interactive prototype"}>
        {locale === "zh"
          ? `以下全部金额、日期和 CFD 状态均为 synthetic mock；${outage ? "包含历史未采集和当日恢复采集场景；" : ""}不读取或修改任何真实账户数据。`
          : `All amounts, dates, and CFD states below are synthetic mock data. ${outage ? "This variant includes historical gaps and same-day collection recovery. " : ""}No real account data is read or changed.`}
      </Alert>
      <section aria-labelledby="mock-money-result-title">
        <Stack gap="md">
          <Group gap="xs" wrap="nowrap">
            <Title id="mock-money-result-title" order={2} size="h3">
              <Localized zh="资金轨迹交互样稿" en="Money history interaction prototype" />
            </Title>
            <ContextHelp
              content={<Localized zh="先确认区间重算、百分比、CFD 停用状态和 Tooltip，再接入真实数据。" en="Validate period rebasing, percentages, retired CFD state, and the tooltip before connecting real data." />}
              label={locale === "zh" ? "样稿说明" : "About this prototype"}
              title={<Localized zh="资金轨迹样稿" en="Money history prototype" />}
            />
          </Group>
          <MoneyPerformanceChart
            cfdStatus={mockRetiredCfdStatus}
            data={mockMoneyNav}
            intradayData={outage ? mockOutageIntradayMoneyNav : mockIntradayMoneyNav}
          />
        </Stack>
      </section>
    </Stack>
  );
}

function AnalyticsLens({ data }: { data: DashboardLens }) {
  const { locale } = useLocale();
  const params = useSearchParams();
  const nav = data.nav ?? [];
  const intradayNav = data.intradayNav ?? [];
  const [activeView, setActiveView] = useState<"money" | "returns">(
    params.get("view") === "returns" ? "returns" : "money",
  );
  const requestedStrategyView = params.get("strategyAccount") as StrategyView | null;
  const [strategyView, setStrategyView] = useState<StrategyView>(
    ["total", "invest", "isa"].includes(requestedStrategyView ?? "")
      ? requestedStrategyView!
      : "total",
  );
  const benchmarkSeries = useMemo(
    () => Object.fromEntries(["VOO", "QQQ", "VT"].map((ticker) => [
      ticker,
      data.benchmarkSeries?.[ticker] ?? [],
    ])),
    [data.benchmarkSeries],
  );

  return (
    <Stack gap="xl">
      <ViewSwitch
        data={[
          { label: locale === "zh" ? "实际盈亏" : "Money", value: "money" },
          { label: locale === "zh" ? "收益对比" : "Returns", value: "returns" },
        ]}
        label={locale === "zh" ? "绩效视图" : "Performance view"}
        onChange={(value) => {
          const next = value === "returns" ? "returns" : "money";
          setActiveView(next);
          replaceUrlState({ view: next === "money" ? null : next });
        }}
        value={activeView}
      />

      {activeView === "money" ? (
        <section aria-labelledby="money-result-title">
          <Stack gap="md">
            <Group gap="xs" wrap="nowrap">
              <Title id="money-result-title" order={2} size="h3">
                <Localized zh="账户价值与盈亏" en="Account value and P&L" />
              </Title>
              <ContextHelp
                content={
                  <Localized
                    zh="回答账户现在有多少钱、实际投入了多少，以及扣除净入金后赚亏多少。净盈亏率不是 TWR。"
                    en="See how much the account holds, how much was contributed, and the profit or loss after contributions. Net P&L rate is not TWR."
                  />
                }
                label={locale === "zh" ? "资金结果说明" : "Money result help"}
                title={<Localized zh="资金结果" en="Money result" />}
              />
            </Group>
            <MoneyPerformanceChart
              cfdStatus={data.cfd}
              data={nav}
              intradayData={intradayNav}
            />
          </Stack>
        </section>
      ) : (
        <section aria-labelledby="strategy-performance-title">
          <Stack gap="lg">
            <Group gap="xs" wrap="nowrap">
              <div>
                <Title id="strategy-performance-title" order={2} size="h3">
                  <Localized zh="收益对比" en="Return comparison" />
                </Title>
                <Text c="dimmed" mt={4} size="sm">
                  <Localized zh="剔除入金和出金后的投资表现" en="Investment performance excluding deposits and withdrawals" />
                </Text>
              </div>
              <ContextHelp
                content={
                  <Localized
                    zh="TWR 剔除入金和出金的影响，用于判断投资本身的表现；实际赚亏金额请看“资金与盈亏”。"
                    en="TWR removes the effect of deposits and withdrawals to show investment performance. Use Money & P&L for actual gains or losses."
                  />
                }
                label={locale === "zh" ? "TWR 使用说明" : "TWR help"}
                title={<Localized zh="如何使用 TWR" en="How to use TWR" />}
              />
            </Group>
            <StrategyPerformanceChart
              benchmarkSeries={benchmarkSeries}
              data={nav}
              embedded
              onViewChange={setStrategyView}
            />
            <RiskOverview data={data} selectedView={strategyView} />
          </Stack>
        </section>
      )}
    </Stack>
  );
}

function RiskOverview({ data, selectedView }: { data: DashboardLens; selectedView: StrategyView }) {
  const { locale, timeZone } = useLocale();
  const accounts = [
    { code: "A", color: "orange", name: "Invest" },
    { code: "B", color: "cyan", name: "Stocks ISA" },
  ] as const;
  const visibleAccounts = accounts.filter(({ code }) => (
    selectedView === "invest" ? code === "A"
      : selectedView === "isa" ? code === "B"
        : true
  ));
  return (
    <Stack gap="md">
      <Group align="flex-start" justify="space-between" wrap="wrap">
        <div>
        <Title order={3} size="h4">
          <Localized zh="完整历史风险指标" en="Full-history risk metrics" />
        </Title>
          <Text c="dimmed" mt={4} size="sm">
            <Localized zh="不随上方区间变化" en="Not affected by the selected range above" />
          </Text>
        </div>
        <Text c="dimmed" size="xs">
          <Localized zh="券商数据更新至" en="Broker data updated" /> {formatDateTime(data.brokerAsOf, locale, timeZone)}
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 1, lg: visibleAccounts.length }}>
        {visibleAccounts.map(({ code, color, name }) => (
          <RiskAccountCard
            code={code}
            color={color}
            key={code}
            metrics={data.risk?.[code]}
            name={name}
          />
        ))}
      </SimpleGrid>
      <Accordion variant="contained">
        <Accordion.Item value="risk-definitions">
          <Accordion.Control>
            <Localized zh="指标说明" en="Metric definitions" />
          </Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <RiskDefinition label="TWR" zh="剔除入金和出金影响后的累计收益。" en="Cumulative return after removing the effect of deposits and withdrawals." />
              <RiskDefinition label="Sharpe" zh="每承担一单位总波动获得的超额收益。" en="Excess return earned per unit of total volatility." />
              <RiskDefinition label="Sortino" zh="与 Sharpe 类似，但只把下行波动计作风险。" en="Similar to Sharpe, but counts only downside volatility as risk." />
              <RiskDefinition label="Calmar" zh="年化收益相对最大回撤的比率。" en="Annualised return relative to maximum drawdown." />
              <RiskDefinition label="IR" zh="相对基准的超额收益稳定性；没有同步的基准日序列时显示 —。" en="Consistency of excess return versus the benchmark; shown as — without an aligned daily benchmark series." />
              <RiskDefinition label={locale === "zh" ? "波动与回撤" : "Volatility & drawdown"} zh="波动衡量收益起伏；回撤衡量从历史高点下跌多少。" en="Volatility measures return variation; drawdown measures the fall from a previous peak." />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function RiskAccountCard({
  code,
  color,
  metrics,
  name,
}: {
  code: "A" | "B";
  color: "orange" | "cyan";
  metrics: RiskMetrics | undefined;
  name: string;
}) {
  const { locale } = useLocale();
  const summary = metrics?.annualizedReturn != null && metrics.maxDrawdown != null
    ? locale === "zh"
      ? `完整历史年化收益 ${pct(metrics.annualizedReturn)}，最大回撤 ${pct(metrics.maxDrawdown)}。`
      : `Annualised return ${pct(metrics.annualizedReturn)} with a ${pct(metrics.maxDrawdown)} maximum drawdown over the full history.`
    : locale === "zh" ? "完整历史风险概览。" : "Full-history risk overview.";
  const metricsRows = [
    { label: "TWR", kind: "pct" as const, tone: true, value: metrics?.twr },
    { label: locale === "zh" ? "年化收益" : "Annualised return", kind: "pct" as const, tone: true, value: metrics?.annualizedReturn },
    { label: "Sharpe", kind: "ratio" as const, value: metrics?.sharpe },
    { label: "Sortino", kind: "ratio" as const, value: metrics?.sortino },
    { label: "Calmar", kind: "ratio" as const, value: metrics?.calmar },
    { label: "IR", kind: "ratio" as const, note: metrics?.informationRatio == null ? locale === "zh" ? "基准日序列不足" : "Daily benchmark series unavailable" : undefined, value: metrics?.informationRatio },
    { label: locale === "zh" ? "年化波动" : "Annual volatility", kind: "pct" as const, value: metrics?.volatility },
    { label: locale === "zh" ? "最大回撤" : "Max drawdown", kind: "pct" as const, negative: true, value: metrics?.maxDrawdown },
    { label: locale === "zh" ? "当前回撤" : "Current drawdown", kind: "pct" as const, negative: true, value: metrics?.currentDrawdown },
  ];
  return (
    <Paper p="lg" radius="lg" withBorder>
      <Stack gap="lg">
        <Group align="flex-start" justify="space-between">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon color={color} size="lg" variant="light">{code}</ThemeIcon>
            <div>
              <Text fw={750}>{name}</Text>
            </div>
          </Group>
          <Badge color="gray" variant="light">
            <Localized zh="完整历史" en="Full history" />
          </Badge>
        </Group>
        <Text fw={650} size="sm">{summary}</Text>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
          {metricsRows.map((item) => <RiskMetric key={item.label} {...item} />)}
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

function RiskMetric({
  kind,
  label,
  negative = false,
  note,
  tone = false,
  value,
}: {
  kind: "pct" | "ratio";
  label: string;
  negative?: boolean;
  note?: string;
  tone?: boolean;
  value: number | null | undefined;
}) {
  const colour = value == null
    ? "dimmed"
    : negative && value < 0
      ? "red"
      : tone && value !== 0
        ? value > 0 ? "green" : "red"
        : undefined;
  return (
    <div>
      <Text c="dimmed" size="xs">{label}</Text>
      <Text c={colour} fw={700} size="lg">
        {kind === "pct" ? pct(value) : ratio(value)}
      </Text>
      {note ? <Text c="dimmed" size="xs">{note}</Text> : null}
    </div>
  );
}

function RiskDefinition({ en, label, zh }: { en: string; label: string; zh: string }) {
  return (
    <div>
      <Text fw={700} size="sm">{label}</Text>
      <Text c="dimmed" size="sm"><Localized en={en} zh={zh} /></Text>
    </div>
  );
}
