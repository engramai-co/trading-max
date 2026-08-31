"use client";

import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { ArrowLeft, ChartLineUp, Info } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  AccountHistoricalReview,
  CfdHistoricalReview,
} from "@/components/account-historical-review";
import { LensContent, LensError, LensSkeleton } from "@/components/lens-state";
import { Localized, useLocale } from "@/components/locale-provider";
import { PageHeader } from "@/components/page-header";
import { ViewSwitch } from "@/components/view-switch";
import {
  MoneyPerformanceChart,
  StrategyPerformanceChart,
} from "@/components/portfolio-charts";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { deltaPct, gbp, money, pct, ratio, shortDate } from "@/lib/format";
import type {
  AccountAnalysisMetrics,
  AccountCode,
  AccountReportRow,
  DashboardLens,
  Holding,
} from "@/lib/types";

function metric(metrics: AccountAnalysisMetrics | null | undefined, key: keyof AccountAnalysisMetrics) {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reportRows(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>)[key];
  return Array.isArray(rows)
    ? rows.filter((row): row is AccountReportRow => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function reportText(row: AccountReportRow, key: string) {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}

function reportNumber(row: AccountReportRow, key: string) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

export function AccountAnalysisPageView({ selected }: { selected: AccountCode }) {
  const lens = useDashboardLens("account-analysis", selected);

  return (
    <Stack gap="xl">
      <PageHeader
        description={<Localized zh="资金结果、账户阶段、交易质量和当前风险。" en="Money results, account phases, trade quality, and current risk." />}
        title={<Localized zh="账户复盘" en="Account review" />}
      />
      {lens.isPending ? <LensSkeleton cards={2} height={320} /> : null}
      {lens.isError ? <LensError retry={() => void lens.refetch()} /> : null}
      {lens.data ? <LensContent><AccountAnalysisLens data={lens.data} selected={selected} /></LensContent> : null}
    </Stack>
  );
}

function AccountAnalysisLens({ data, selected }: { data: DashboardLens; selected: AccountCode }) {
  const router = useRouter();
  const { locale } = useLocale();
  const account = data.selectedAccount;
  const cfd = selected === "C" ? data.cfd : null;
  const metrics = data.selectedAccountAnalysis;
  const accountName = account?.name ?? cfd?.name ?? metrics?.name ?? selected;

  return (
    <Stack gap="xl">
      <Group justify="space-between" wrap="wrap">
        <Anchor className="tm-brand-link" component={Link} href="/review">
          <Group gap={6}><ArrowLeft size={16} /><Localized zh="返回账户复盘" en="Back to account review" /></Group>
        </Anchor>
        <ViewSwitch
          data={[
            { label: "Invest", value: "A" },
            { label: "ISA", value: "B" },
            { label: "CFD", value: "C" },
          ]}
          label={locale === "zh" ? "切换复盘账户" : "Switch review account"}
          onChange={(account) => router.push(`/account-analysis?account=${account}`)}
          value={selected}
        />
      </Group>

      {selected === "C" && data.selectedCfdReview ? (
        <CfdHistoricalReview
          accountName={accountName}
          review={data.selectedCfdReview}
          summary={cfd ?? null}
        />
      ) : selected !== "C" && data.selectedAccountReview ? (
        <AccountHistoricalReview
          accountCode={selected}
          accountName={accountName}
          intradayNav={data.intradayNav ?? []}
          nav={data.nav ?? []}
          review={data.selectedAccountReview}
        />
      ) : (
        <LegacyAccountAnalysis data={data} selected={selected} />
      )}
    </Stack>
  );
}

function LegacyAccountAnalysis({ data, selected }: { data: DashboardLens; selected: AccountCode }) {
  const account = data.selectedAccount;
  const cfd = selected === "C" ? data.cfd : null;
  const metrics = data.selectedAccountAnalysis;
  const accountName = account?.name ?? cfd?.name ?? metrics?.name ?? selected;
  const risk = data.selectedRisk;
  const holdings = [...(data.holdings ?? [])]
    .sort((left, right) => right.currentValueGbp - left.currentValueGbp);
  const report = data.selectedAccountReport;
  const contribution = reportRows(report, selected === "C" ? "bySymbol" : "byTicker");

  return (
    <Stack gap="xl">
      <Alert color="gray" icon={<Info size={18} />} title={<Localized zh="复盘数据尚未更新" en="Review data needs an update" />}>
        <Localized zh="当前显示上一版复盘。账户刷新完成后会自动更新。" en="Showing the previous review. It will update after the next account refresh." />
      </Alert>
      <Card className="tm-review-money-hero">
        <Stack gap="lg">
          <Group justify="space-between">
            <div>
              <Text c="dimmed" fw={700} size="xs" tt="uppercase">
                {selected === "C"
                  ? <Localized zh="CFD 已实现记录" en="CFD realised records" />
                  : metrics?.metricQuality ?? <Localized zh="暂无复盘" en="No review yet" />}
              </Text>
              <Title order={2}>{accountName}</Title>
              <Text c="dimmed" size="sm">
                {metrics?.start
                  ? shortDate(metrics.start, "en")
                  : cfd?.asOf
                    ? shortDate(cfd.asOf, "en")
                    : "—"}
                {metrics?.end ? ` → ${shortDate(metrics.end, "en")}` : ""}
              </Text>
            </div>
            {selected === "C" ? <Badge color="blue"><Localized zh="导入数据" en="Imported data" /></Badge> : null}
          </Group>
          <Text c="dimmed" size="xs">{selected === "C" ? <Localized zh="已实现现金权益代理值" en="Realised cash-equity proxy" /> : <Localized zh="期末账户值" en="Ending account value" />}</Text>
          <Title order={2} size="clamp(2.4rem, 7vw, 4.75rem)">
            {account
              ? gbp(account.totalValueGbp, 2)
              : cfd
                ? gbp(cfd.endingValueGbp, 2)
                : "—"}
          </Title>
          <Text c="dimmed">
            {selected === "C"
              ? <Localized zh="此值只包含导入记录中的已实现结果，不代表当前券商权益。" en="This value contains realised imported results only and is not current broker equity." />
              : <Localized zh="期末金额来自 Trading 212 账户数据。" en="The ending value comes from Trading 212 account data." />}
          </Text>
        </Stack>
      </Card>


      {selected === "C" ? (
        <CfdMetrics metrics={metrics} />
      ) : risk ? (
        <>
          <section aria-labelledby="account-money-title">
            <Stack gap="md">
              <div>
                <Text c="dimmed" fw={700} size="xs" tt="uppercase">
                  <Localized zh="资金结果" en="Money result" />
                </Text>
                <Title id="account-money-title" order={2} size="h3">
                  <Localized zh="净值、净入金与净盈亏" en="NAV, contributions & net P&L" />
                </Title>
              </div>
              <MoneyPerformanceChart
                data={data.nav ?? []}
                fixedView={selected === "A" ? "invest" : "isa"}
                intradayData={data.intradayNav ?? []}
              />
            </Stack>
          </section>
          <section aria-labelledby="risk-title">
            <Stack gap="md">
              <Group justify="space-between">
                <div>
                  <Text c="dimmed" fw={700} size="xs" tt="uppercase">Synthetic NAV · risk</Text>
                  <Title id="risk-title" order={2} size="h3"><Localized zh="账户净值风险" en="Account NAV risk" /></Title>
                </div>
                <Badge variant="outline">{risk.benchmark}</Badge>
              </Group>
              <StrategyPerformanceChart
                data={data.nav ?? []}
                fixedView={selected === "A" ? "invest" : "isa"}
              />
              <SimpleGrid cols={{ base: 2, md: 4 }}>
                <Metric label="TWR" value={deltaPct(risk.twr)} />
                <Metric label="Sharpe" value={ratio(risk.sharpe)} />
                <Metric label="Sortino" value={ratio(risk.sortino)} />
                <Metric label="Calmar" value={ratio(risk.calmar)} />
                <Metric label="IR" value={ratio(risk.informationRatio)} />
                <Metric label={<Localized zh="年化波动" en="Annual volatility" />} value={pct(risk.volatility)} />
                <Metric label={<Localized zh="最大回撤" en="Max drawdown" />} tone="red" value={deltaPct(risk.maxDrawdown)} />
                <Metric label={<Localized zh="当前回撤" en="Current drawdown" />} tone="red" value={deltaPct(risk.currentDrawdown)} />
              </SimpleGrid>
            </Stack>
          </section>
          <section aria-labelledby="trading-quality-title">
            <Group justify="space-between" mb="md">
              <Title id="trading-quality-title" order={2} size="h3"><Localized zh="已实现交易质量" en="Realized trading quality" /></Title>
              <ChartLineUp size={22} />
            </Group>
            <SimpleGrid cols={{ base: 2, md: 3 }}>
              <Metric label={<Localized zh="期间净结果" en="Period net result" />} value={metric(metrics, "period_net") == null ? "—" : gbp(metric(metrics, "period_net")!, 2)} />
              <Metric label={<Localized zh="胜率" en="Win rate" />} value={metric(metrics, "win_rate") == null ? "—" : pct(metric(metrics, "win_rate")!)} />
              <Metric label="Profit factor" value={metric(metrics, "profit_factor") == null ? "—" : ratio(metric(metrics, "profit_factor")!)} />
              <Metric label={<Localized zh="盈亏比" en="Payoff ratio" />} value={metric(metrics, "payoff") == null ? "—" : ratio(metric(metrics, "payoff")!)} />
              <Metric label={<Localized zh="每笔期望" en="Expectancy / trade" />} value={metric(metrics, "expectancy") == null ? "—" : gbp(metric(metrics, "expectancy")!, 2)} />
              <Metric label={<Localized zh="中位持仓" en="Median holding" />} value={metric(metrics, "median_hold") == null ? "—" : `${metric(metrics, "median_hold")!.toFixed(1)} days`} />
            </SimpleGrid>
          </section>
          <HoldingsSnapshot accountValue={account?.totalValueGbp ?? 0} holdings={holdings} />
        </>
      ) : null}

      {contribution.length ? <ContributionTable cfd={selected === "C"} rows={contribution} /> : null}
    </Stack>
  );
}

function Metric({ label, tone, value }: { label: React.ReactNode; tone?: "green" | "red"; value: string }) {
  return <div><Text c="dimmed" size="xs">{label}</Text><Text c={tone} fw={700} size="lg">{value}</Text></div>;
}

function CfdMetrics({ metrics }: { metrics: AccountAnalysisMetrics | null | undefined }) {
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric label={<Localized zh="已实现净损益" en="Realized net P&L" />} tone="red" value={metric(metrics, "net") == null ? "—" : gbp(metric(metrics, "net")!, 2)} />
        <Metric label={<Localized zh="关闭仓位" en="Closed positions" />} value={metric(metrics, "trades")?.toLocaleString("en-GB") ?? "—"} />
        <Metric label={<Localized zh="胜率" en="Win rate" />} value={metric(metrics, "win_rate") == null ? "—" : pct(metric(metrics, "win_rate")!)} />
        <Metric label="Profit factor" value={metric(metrics, "profit_factor") == null ? "—" : ratio(metric(metrics, "profit_factor")!)} />
        <Metric label={<Localized zh="隔夜利息" en="Overnight interest" />} tone="red" value={metric(metrics, "overnight") == null ? "—" : gbp(metric(metrics, "overnight")!, 2)} />
        <Metric label={<Localized zh="总名义金额" en="Total notional" />} value={metric(metrics, "total_notional") == null ? "—" : gbp(metric(metrics, "total_notional")!, 0)} />
        <Metric label={<Localized zh="最大现金回撤" en="Max cash drawdown" />} tone="red" value={metric(metrics, "max_dd_gbp") == null ? "—" : gbp(metric(metrics, "max_dd_gbp")!, 2)} />
        <Metric label={<Localized zh="损益 Sharpe（估算）" en="P&L Sharpe (estimated)" />} value={metric(metrics, "pnl_sharpe") == null ? "—" : ratio(metric(metrics, "pnl_sharpe")!)} />
      </SimpleGrid>
    </Stack>
  );
}

function HoldingsSnapshot({
  accountValue,
  holdings,
}: {
  accountValue: number;
  holdings: Holding[];
}) {
  return (
    <section aria-labelledby="ending-holdings-title">
      <Title id="ending-holdings-title" mb="md" order={2} size="h3"><Localized zh="期末持仓与当前风险" en="Ending holdings & current risk" /></Title>
      <Table.ScrollContainer
        minWidth={760}
        scrollAreaProps={{
          viewportProps: { "aria-label": "Ending holdings table", tabIndex: 0 },
        }}
      >
        <Table highlightOnHover>
          <Table.Thead><Table.Tr><Table.Th>Ticker</Table.Th><Table.Th><Localized zh="名称" en="Name" /></Table.Th><Table.Th ta="right"><Localized zh="市值" en="Value" /></Table.Th><Table.Th ta="right"><Localized zh="权重" en="Weight" /></Table.Th><Table.Th ta="right">P&L</Table.Th><Table.Th ta="right"><Localized zh="摊薄成本 / 现价" en="Diluted cost / spot" /></Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {holdings.map((holding) => (
              <Table.Tr key={holding.ticker}>
                <Table.Td fw={700}>{holding.ticker}</Table.Td><Table.Td>{holding.name}</Table.Td>
                <Table.Td ta="right">{gbp(holding.currentValueGbp, 0)}</Table.Td>
                <Table.Td ta="right">{pct(accountValue ? holding.currentValueGbp / accountValue : null)}</Table.Td>
                <Table.Td c={holding.pnlGbp >= 0 ? "green" : "red"} ta="right">{gbp(holding.pnlGbp, 0)} · {deltaPct(holding.pnlPct)}</Table.Td>
                <Table.Td ta="right">{holding.dilutedCostPerShareNative == null ? "—" : `${money(holding.dilutedCostPerShareNative, holding.priceCurrency, 2)} / ${money(holding.currentPrice, holding.priceCurrency, 2)}`}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </section>
  );
}

function ContributionTable({ cfd, rows }: { cfd: boolean; rows: AccountReportRow[] }) {
  return (
    <section aria-labelledby="contribution-title">
      <Title id="contribution-title" mb="md" order={2} size="h3"><Localized zh="标的贡献" en="Contribution by instrument" /></Title>
      <Table.ScrollContainer
        minWidth={700}
        scrollAreaProps={{
          viewportProps: { "aria-label": "Instrument contribution table", tabIndex: 0 },
        }}
      >
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th>Ticker</Table.Th><Table.Th><Localized zh="名称" en="Name" /></Table.Th><Table.Th ta="right"><Localized zh="交易数" en="Trades" /></Table.Th><Table.Th ta="right"><Localized zh="净结果" en="Net" /></Table.Th><Table.Th ta="right"><Localized zh="胜率" en="Win rate" /></Table.Th>{cfd ? <Table.Th ta="right"><Localized zh="隔夜" en="Overnight" /></Table.Th> : null}</Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((row, index) => (
              <Table.Tr key={`${reportText(row, "ticker")}-${index}`}>
                <Table.Td fw={700}>{reportText(row, "ticker")}</Table.Td><Table.Td>{reportText(row, "name")}</Table.Td>
                <Table.Td ta="right">{reportText(row, "trades")}</Table.Td>
                <Table.Td ta="right">{reportNumber(row, "net") == null ? "—" : gbp(reportNumber(row, "net")!, 0)}</Table.Td>
                <Table.Td ta="right">{reportNumber(row, "winRate") == null ? "—" : pct(reportNumber(row, "winRate")!)}</Table.Td>
                {cfd ? <Table.Td ta="right">{reportNumber(row, "overnight") == null ? "—" : gbp(reportNumber(row, "overnight")!, 0)}</Table.Td> : null}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </section>
  );
}
