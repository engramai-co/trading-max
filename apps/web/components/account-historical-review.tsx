"use client";

import {
  Accordion,
  Alert,
  Badge,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import {
  Info,
  ShieldWarning,
} from "@phosphor-icons/react/dist/ssr";

import { ContextHelp } from "@/components/context-help";
import { Localized, useLocale } from "@/components/locale-provider";
import {
  MoneyPerformanceChart,
  StrategyPerformanceChart,
} from "@/components/portfolio-charts";
import { deltaPct, gbp, pct, ratio, shortDate } from "@/lib/format";
import type {
  AccountReview,
  CfdAccountReview,
  CfdSummary,
  InvestableAccountCode,
  NavPoint,
} from "@/lib/types";

type ReviewStatus = "available" | "partial" | "unavailable";
type ReviewBucket = NonNullable<
  AccountReview["attribution"]["by_instrument"]["buckets"]
>[number];
type ReviewTrade = NonNullable<
  AccountReview["realisedTradeQuality"]["best_trades"]
>[number];
type ReviewPhase = NonNullable<AccountReview["phases"]["items"]>[number];
type ReviewHolding = NonNullable<AccountReview["endingRisk"]["holdings"]>[number];
type CfdBucket = NonNullable<CfdAccountReview["attribution"]["byInstrument"]>[number];
type CfdPhase = NonNullable<CfdAccountReview["phases"]["items"]>[number];
type UnknownRecord = Record<string, unknown>;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalGbp(value: unknown, digits = 2) {
  const parsed = finite(value);
  return parsed == null ? "—" : gbp(parsed, digits);
}

function optionalPct(value: unknown, digits = 1) {
  return pct(finite(value), digits);
}

function optionalDeltaPct(value: unknown, digits = 1) {
  return deltaPct(finite(value), digits);
}

function optionalRatio(value: unknown, digits = 2) {
  return ratio(finite(value), digits);
}

function count(value: unknown) {
  const parsed = finite(value);
  return parsed == null ? "—" : new Intl.NumberFormat("en-GB").format(parsed);
}

function dateLabel(value: string | null | undefined, locale: "zh" | "en") {
  return value ? shortDate(value, locale) : "—";
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function records(value: unknown, key: string): UnknownRecord[] {
  const source = record(value)?.[key];
  return Array.isArray(source)
    ? source.filter((item): item is UnknownRecord => Boolean(record(item)))
    : [];
}

function textValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function humanize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function tone(value: number | null | undefined): "green" | "red" | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return value >= 0 ? "green" : "red";
}

function effectiveStrategyStatus(section: AccountReview["strategyRisk"]): ReviewStatus {
  const metrics = section.metrics;
  if (!metrics) return section.status;
  const coreMetrics = [
    metrics.twr_total_return,
    metrics.annualized_return,
    metrics.annualized_volatility,
    metrics.sharpe_sonia,
    metrics.sortino_sonia,
    metrics.calmar_ratio,
    metrics.max_drawdown,
    metrics.current_drawdown,
  ];
  return coreMetrics.every((value) => finite(value) != null) ? "available" : section.status;
}

function Metric({
  label,
  tone: metricTone,
  value,
}: {
  label: React.ReactNode;
  tone?: "green" | "red";
  value: string;
}) {
  return (
    <div>
      <Text c="dimmed" size="xs">{label}</Text>
      <Text c={metricTone} fw={700} size="lg">{value}</Text>
    </div>
  );
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  const color = status === "available" ? "green" : "gray";
  return (
    <Badge color={color} variant="light">
      {status === "available" ? (
        <Localized zh="可用" en="Available" />
      ) : status === "partial" ? (
        <Localized zh="数据不完整" en="Incomplete data" />
      ) : (
        <Localized zh="不可用" en="Unavailable" />
      )}
    </Badge>
  );
}

function SectionState({
  reason,
  status,
}: {
  reason?: string | null;
  status: ReviewStatus;
}) {
  if (status === "available") return null;
  return (
    <Alert
      color="gray"
      icon={<Info size={18} />}
      title={
        status === "partial"
          ? <Localized zh="部分结果缺少数据" en="Some results are missing data" />
          : <Localized zh="暂无数据" en="No data available" />
      }
    >
      {reason || <Localized zh="当前数据不足，无法计算本节。" en="There is not enough data to calculate this section." />}
    </Alert>
  );
}

function compactWarnings(warnings: string[]) {
  return warnings.filter(
    (warning) => !warning.match(/^CFD internal transfer on \d{4}-\d{2}-\d{2} could not be matched exactly/)
      && !warning.startsWith("CFD exports do not provide daily broker equity"),
  );
}

function WarningSummary({ warnings }: { warnings: Array<string | null | undefined> }) {
  const unique = [...new Set(warnings.filter((item): item is string => Boolean(item?.trim())))];
  if (!unique.length) return null;
  const visible = compactWarnings(unique);
  if (!visible.length) return null;
  return (
    <Accordion variant="contained">
      <Accordion.Item value="data-boundaries">
        <Accordion.Control icon={<Info size={18} />}>
          <Group gap="sm" wrap="wrap">
            <Text fw={700}><Localized zh="数据说明" en="Data notes" /></Text>
            <Badge color="gray" variant="light">{visible.length}</Badge>
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            {visible.map((warning) => <Text c="dimmed" key={warning} size="sm">{warning}</Text>)}
            {unique.length > visible.length ? (
              <Text c="dimmed" size="xs">
                <Localized
                  zh={`另有 ${unique.length - visible.length} 条导入明细未在此显示。`}
                  en={`${unique.length - visible.length} additional import details are not shown here.`}
                />
              </Text>
            ) : null}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function SectionControl({
  status,
  title,
}: {
  description?: React.ReactNode;
  status?: ReviewStatus;
  title: React.ReactNode;
}) {
  return (
    <Group gap="md" justify="space-between" pr="md" wrap="wrap">
      <Text fw={700}>{title}</Text>
      {status && status !== "available" ? <StatusBadge status={status} /> : null}
    </Group>
  );
}

function ReviewHero({
  accountName,
  accountCode,
  review,
}: {
  accountName: string;
  accountCode: InvestableAccountCode;
  review: AccountReview;
}) {
  const { locale } = useLocale();
  const money = review.moneyOutcome;
  const coverage = review.coverage;
  const endingValue = finite(money.ending_value_gbp);
  const netPnl = finite(money.net_pnl_gbp);
  return (
    <Card className="tm-review-money-hero" data-account={accountCode}>
      <Stack gap="lg">
        <Group align="flex-start" justify="space-between" wrap="wrap">
          <div>
            <Title order={2}>{accountName}</Title>
            <Text c="dimmed" size="sm">
              {dateLabel(coverage.start_date, locale)} → {dateLabel(coverage.end_date, locale)} · {coverage.currency}
            </Text>
          </div>
          {coverage.status !== "available" ? <StatusBadge status={coverage.status} /> : null}
        </Group>
        <div>
          <Text c="dimmed" size="xs"><Localized zh="期末账户值" en="Ending account value" /></Text>
          <Title order={2} size="clamp(2.4rem, 7vw, 4.75rem)">
            {endingValue == null ? "—" : gbp(endingValue, 2)}
          </Title>
        </div>
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Metric label={<Localized zh="累计净入金" en="Net external flows" />} value={optionalGbp(money.net_external_flows_gbp)} />
          <Metric label={<Localized zh="净盈亏" en="Net P&L" />} tone={tone(netPnl)} value={optionalGbp(netPnl)} />
          <Metric label={<Localized zh="净盈亏率" en="Net P&L rate" />} tone={tone(finite(money.net_pnl_rate))} value={optionalDeltaPct(money.net_pnl_rate)} />
          <Metric label={<Localized zh="最大英镑回撤" en="Max money drawdown" />} tone="red" value={optionalGbp(money.max_pnl_drawdown_gbp)} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function ReviewDiagnosis({ review }: { review: AccountReview }) {
  const { locale } = useLocale();
  const rows = [...(review.attribution.by_instrument.buckets ?? [])];
  const contributor = rows.filter((row) => row.netResultGbp > 0).sort((left, right) => right.netResultGbp - left.netResultGbp)[0];
  const detractor = rows.filter((row) => row.netResultGbp < 0).sort((left, right) => left.netResultGbp - right.netResultGbp)[0];
  const phase = [...(review.phases.items ?? [])].sort((left, right) => {
    const leftImpact = Math.abs(left.netPnlGbp) + Math.abs(left.netExternalFlowsGbp);
    const rightImpact = Math.abs(right.netPnlGbp) + Math.abs(right.netExternalFlowsGbp);
    return rightImpact - leftImpact;
  })[0];
  const netPnl = finite(review.moneyOutcome.net_pnl_gbp);
  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Title order={3}><Localized zh="本次结论" en="Review summary" /></Title>
        </div>
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Metric label={<Localized zh="净盈亏" en="Net P&L" />} tone={tone(netPnl)} value={optionalGbp(netPnl)} />
          <Metric label={<Localized zh="首要贡献" en="Top contributor" />} tone="green" value={contributor ? `${contributor.label} · ${gbp(contributor.netResultGbp, 2)}` : "—"} />
          <Metric label={<Localized zh="主要拖累" en="Top detractor" />} tone="red" value={detractor ? `${detractor.label} · ${gbp(detractor.netResultGbp, 2)}` : "—"} />
          <Metric label={<Localized zh="影响最大的阶段" en="Most impactful phase" />} tone={tone(phase?.netPnlGbp)} value={phase ? `${gbp(phase.netPnlGbp, 2)} · ${dateLabel(phase.startDate, locale)}` : "—"} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function CoveragePanel({ coverage }: { coverage: AccountReview["coverage"] }) {
  return (
    <SimpleGrid cols={{ base: 2, sm: 4 }}>
      <Metric label={<Localized zh="净值记录" en="Account-value records" />} value={count(coverage.nav_observation_count)} />
      <Metric label={<Localized zh="交易记录" en="Transactions" />} value={count(coverage.transaction_count)} />
      <Metric label={<Localized zh="已完成交易" en="Closed campaigns" />} value={count(coverage.closed_campaign_count)} />
      <Metric label={<Localized zh="期末持仓" en="Ending holdings" />} value={count(coverage.ending_holding_count)} />
    </SimpleGrid>
  );
}

export function AccountHistoricalReview({
  accountCode,
  accountName,
  intradayNav,
  nav,
  review,
}: {
  accountCode: InvestableAccountCode;
  accountName: string;
  intradayNav: NavPoint[];
  nav: NavPoint[];
  review: AccountReview;
}) {
  const strategyStatus = effectiveStrategyStatus(review.strategyRisk);
  const topWarnings = [
    ...(review.warnings ?? []),
    review.coverage.unavailable_reason,
    review.moneyOutcome.unavailable_reason,
    review.strategyRisk.unavailable_reason,
    review.phases.unavailable_reason,
    review.realisedTradeQuality.unavailable_reason,
    review.attribution.unavailable_reason,
    review.structuralDiagnostics.unavailable_reason,
    review.endingRisk.unavailable_reason,
    ...(review.endingRisk.warnings ?? []),
  ];
  return (
    <Stack gap="xl">
      <ReviewHero accountCode={accountCode} accountName={accountName} review={review} />
      <ReviewDiagnosis review={review} />
      <WarningSummary warnings={topWarnings} />

      <section aria-labelledby="review-evidence-title">
        <Title id="review-evidence-title" mb={4} order={2} size="h3"><Localized zh="查看证据" en="Review the evidence" /></Title>
      <Accordion multiple variant="contained">
        <Accordion.Item value="money">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="区分现金流与投资盈亏" en="Separates cash flows from investment P&L" />}
              status={review.moneyOutcome.status}
              title={<Localized zh="资金结果" en="Money result" />}
            />
          </Accordion.Control>
          <Accordion.Panel>
            <MoneyOutcomePanel accountCode={accountCode} intradayNav={intradayNav} nav={nav} review={review} />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="strategy-risk">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="收益表现、回撤和风险指标" en="Returns, drawdowns, and risk metrics" />}
              status={strategyStatus}
              title={<Localized zh="策略与风险" en="Strategy and risk" />}
            />
          </Accordion.Control>
          <Accordion.Panel>
            <StrategyRiskPanel accountCode={accountCode} nav={nav} review={review} />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="phases">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="阶段变化、关键事件与主要贡献/拖累" en="Phase changes, key events, contributors, and detractors" />}
              status={review.phases.status}
              title={<Localized zh="账户阶段" en="Account phases" />}
            />
          </Accordion.Control>
          <Accordion.Panel><PhasesPanel phases={review.phases} /></Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="trade-quality">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="持有期、连胜连亏、尾部损失，以及是否依赖少数最佳交易" en="Holding periods, streaks, tail losses, and reliance on a few best trades" />}
              status={review.realisedTradeQuality.status}
              title={<Localized zh="已实现交易质量" en="Realised trade quality" />}
            />
          </Accordion.Control>
          <Accordion.Panel><TradeQualityPanel quality={review.realisedTradeQuality} /></Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="attribution">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="按标的、方向、持有期和日历拆解" en="By instrument, direction, holding period and calendar" />}
              status={review.attribution.status}
              title={<Localized zh="盈亏归因" en="Profit and loss attribution" />}
            />
          </Accordion.Control>
          <Accordion.Panel><AttributionPanel attribution={review.attribution} /></Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="structure">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="交易频率、规模与持仓变化" en="Trading frequency, size, and position changes" />}
              status={review.structuralDiagnostics.status}
              title={<Localized zh="交易行为与结构" en="Trading behaviour and structure" />}
            />
          </Accordion.Control>
          <Accordion.Panel><StructuralPanel diagnostics={review.structuralDiagnostics} /></Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="ending-risk">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="持仓、集中度和行业/国家/币种暴露" en="Holdings, concentration and industry/country/currency exposure" />}
              status={review.endingRisk.status}
              title={<Localized zh="期末持仓与当前风险" en="Ending holdings and current risk" />}
            />
          </Accordion.Control>
          <Accordion.Panel><EndingRiskPanel ending={review.endingRisk} /></Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      </section>

      <Accordion variant="contained">
        <Accordion.Item value="data-details">
          <Accordion.Control>
            <SectionControl
              description={<Localized zh="本次复盘使用的时间范围和记录数量" en="Date range and record counts used in this review" />}
              status={review.coverage.status}
              title={<Localized zh="数据详情" en="Data details" />}
            />
          </Accordion.Control>
          <Accordion.Panel><CoveragePanel coverage={review.coverage} /></Accordion.Panel>
        </Accordion.Item>
      </Accordion>

    </Stack>
  );
}

function MoneyOutcomePanel({
  accountCode,
  intradayNav,
  nav,
  review,
}: {
  accountCode: InvestableAccountCode;
  intradayNav: NavPoint[];
  nav: NavPoint[];
  review: AccountReview;
}) {
  const money = review.moneyOutcome;
  return (
    <Stack gap="lg">
      <SectionState reason={money.unavailable_reason} status={money.status} />
      {money.status !== "unavailable" ? (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Metric label={<Localized zh="期初价值" en="Opening value" />} value={optionalGbp(money.opening_value_gbp)} />
            <Metric label={<Localized zh="期末价值" en="Ending value" />} value={optionalGbp(money.ending_value_gbp)} />
            <Metric label={<Localized zh="入金" en="Deposits" />} value={optionalGbp(money.deposits_gbp)} />
            <Metric label={<Localized zh="取款" en="Withdrawals" />} value={optionalGbp(money.withdrawals_gbp)} />
            <Metric label={<Localized zh="累计净入金" en="Net external flows" />} value={optionalGbp(money.net_external_flows_gbp)} />
            <Metric label={<Localized zh="净盈亏" en="Net P&L" />} tone={tone(finite(money.net_pnl_gbp))} value={optionalGbp(money.net_pnl_gbp)} />
            <Metric label={<Localized zh="当前英镑回撤" en="Current money drawdown" />} tone="red" value={optionalGbp(money.current_pnl_drawdown_gbp)} />
            <Metric label={<Localized zh="资本基数" en="Capital base" />} value={optionalGbp(money.capital_base_gbp)} />
          </SimpleGrid>
          <MoneyPerformanceChart
            data={nav}
            fixedView={accountCode === "A" ? "invest" : "isa"}
            intradayData={intradayNav}
          />
        </>
      ) : null}
    </Stack>
  );
}

function StrategyRiskPanel({
  accountCode,
  nav,
  review,
}: {
  accountCode: InvestableAccountCode;
  nav: NavPoint[];
  review: AccountReview;
}) {
  const section = review.strategyRisk;
  const metrics = section.metrics;
  const reasons = metrics?.metric_unavailable_reasons ?? {};
  return (
    <Stack gap="lg">
      {section.status === "unavailable" ? (
        <SectionState reason={section.unavailable_reason} status={section.status} />
      ) : null}
      {metrics ? (
        <>
          <StrategyPerformanceChart
            data={nav}
            fixedView={accountCode === "A" ? "invest" : "isa"}
          />
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Metric label="TWR" value={optionalDeltaPct(metrics.twr_total_return)} />
            <Metric label="Sharpe" value={optionalRatio(metrics.sharpe_sonia)} />
            <Metric label="Sortino" value={optionalRatio(metrics.sortino_sonia)} />
            <Metric label="Calmar" value={optionalRatio(metrics.calmar_ratio)} />
            <Metric label="IR" value={optionalRatio(metrics.information_ratio)} />
            <Metric label={<Localized zh="年化收益" en="Annualized return" />} value={optionalDeltaPct(metrics.annualized_return)} />
            <Metric label={<Localized zh="年化波动" en="Annualized volatility" />} value={optionalPct(metrics.annualized_volatility)} />
            <Metric label={<Localized zh="最大回撤" en="Max drawdown" />} tone="red" value={optionalDeltaPct(metrics.max_drawdown)} />
            <Metric label={<Localized zh="当前回撤" en="Current drawdown" />} tone="red" value={optionalDeltaPct(metrics.current_drawdown)} />
            <Metric label={<Localized zh="有效区间" en="Periods" />} value={count(metrics.periods)} />
            <Metric label={<Localized zh="基准" en="Benchmark" />} value={metrics.benchmark_ticker === "VUAG" ? "VOO" : metrics.benchmark_ticker ?? "—"} />
            <Metric label={<Localized zh="净值质量" en="NAV quality" />} value={metrics.nav_quality ?? "—"} />
          </SimpleGrid>
          {Object.keys(reasons).length ? (
            <Alert color="gray" icon={<Info size={18} />} title={<Localized zh="补充指标说明" en="Supplementary metric notes" />}>
              <Stack gap={4}>
                {Object.entries(reasons).map(([key, value]) => (
                  <Text key={key} size="sm"><Text component="span" fw={700}>{humanize(key)}:</Text> {value}</Text>
                ))}
              </Stack>
            </Alert>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

function phaseName(classification: string) {
  const names: Record<string, React.ReactNode> = {
    drawdown_formation: <Localized zh="回撤形成" en="Drawdown formation" />,
    drawdown_recovery: <Localized zh="回撤恢复" en="Drawdown recovery" />,
    flat_phase: <Localized zh="横盘" en="Flat phase" />,
    large_cash_flow: <Localized zh="大额现金流" en="Large cash flow" />,
    loss_phase: <Localized zh="亏损阶段" en="Loss phase" />,
    profit_phase: <Localized zh="盈利阶段" en="Profit phase" />,
  };
  return names[classification] ?? humanize(classification);
}

function PhasesPanel({ phases }: { phases: AccountReview["phases"] }) {
  const items = phases.items ?? [];
  const featured = [...items]
    .sort((left, right) => {
      const rightImpact = Math.abs(right.netPnlGbp) + Math.abs(right.netExternalFlowsGbp);
      const leftImpact = Math.abs(left.netPnlGbp) + Math.abs(left.netExternalFlowsGbp);
      return rightImpact - leftImpact || left.startDate.localeCompare(right.startDate);
    })
    .slice(0, 4)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  return (
    <Stack gap="md">
      <SectionState reason={phases.unavailable_reason} status={phases.status} />
      {phases.status !== "unavailable" ? (
        <>
          {items.length ? (
            <>
              <div>
                <Text fw={700} mb="xs"><Localized zh="关键阶段（按现金流与净盈亏的绝对影响筛选）" en="Key phases (selected by absolute cash-flow and net-P&L impact)" /></Text>
                <PhaseList phases={featured} />
              </div>
              {items.length > featured.length ? (
                <Accordion variant="separated">
                  <Accordion.Item value="all-account-phases">
                    <Accordion.Control>
                      <Group justify="space-between" pr="md">
                        <Text fw={700}><Localized zh="查看全部阶段" en="View all phases" /></Text>
                        <Badge color="gray" variant="light">{items.length}</Badge>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel><PhaseList phases={items} /></Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              ) : null}
            </>
          ) : <Text c="dimmed"><Localized zh="没有可展示的阶段。" en="No phases are available to display." /></Text>}
        </>
      ) : null}
    </Stack>
  );
}

function PhaseList({ phases }: { phases: ReviewPhase[] }) {
  const { locale } = useLocale();
  return (
    <Accordion multiple variant="separated">
      {phases.map((phase) => {
        const isCashFlow = phase.classification === "large_cash_flow";
        const headlineValue = isCashFlow ? phase.netExternalFlowsGbp : phase.netPnlGbp;
        return (
          <Accordion.Item key={phase.phaseId} value={phase.phaseId}>
            <Accordion.Control>
              <Group gap="md" justify="space-between" pr="md" wrap="wrap">
                <div>
                  <Text fw={700}>{phaseName(phase.classification)}</Text>
                  <Text c="dimmed" size="xs">{dateLabel(phase.startDate, locale)} → {dateLabel(phase.endDate, locale)}</Text>
                </div>
                <Stack align="flex-end" gap={0}>
                  <Text c={tone(headlineValue)} fw={800}>{gbp(headlineValue, 2)}</Text>
                  <Text c="dimmed" size="xs">{isCashFlow ? <Localized zh="净现金流" en="Net cash flow" /> : <Localized zh="净盈亏" en="Net P&L" />}</Text>
                </Stack>
              </Group>
            </Accordion.Control>
            <Accordion.Panel><PhaseDetail phase={phase} /></Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}

function PhaseDetail({ phase }: { phase: ReviewPhase }) {
  const { locale } = useLocale();
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric label={<Localized zh="期初价值" en="Opening value" />} value={gbp(phase.openingValueGbp, 2)} />
        <Metric label={<Localized zh="期末价值" en="Ending value" />} value={gbp(phase.endingValueGbp, 2)} />
        <Metric label={<Localized zh="净外部现金流" en="Net external flows" />} value={gbp(phase.netExternalFlowsGbp, 2)} />
        <Metric label={<Localized zh="阶段净盈亏" en="Phase net P&L" />} tone={tone(phase.netPnlGbp)} value={gbp(phase.netPnlGbp, 2)} />
        <Metric label={<Localized zh="阶段最大回撤" en="Phase max drawdown" />} tone="red" value={gbp(phase.maxPnlDrawdownGbp, 2)} />
        <Metric label={<Localized zh="期末回撤" en="Ending drawdown" />} tone="red" value={gbp(phase.endingPnlDrawdownGbp, 2)} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <PhaseContributors label={<Localized zh="主要贡献" en="Top contributors" />} rows={phase.topContributors ?? []} />
        <PhaseContributors label={<Localized zh="主要拖累" en="Top detractors" />} rows={phase.topDetractors ?? []} />
      </SimpleGrid>
      <div>
        <Text fw={700} mb="xs"><Localized zh="阶段事件" en="Phase events" /></Text>
        <Table.ScrollContainer minWidth={620} scrollAreaProps={{ viewportProps: { "aria-label": "Phase evidence events", tabIndex: 0 } }}>
          <Table striped>
            <Table.Thead><Table.Tr><Table.Th><Localized zh="日期" en="Date" /></Table.Th><Table.Th><Localized zh="类型" en="Type" /></Table.Th><Table.Th><Localized zh="说明" en="Detail" /></Table.Th><Table.Th ta="right"><Localized zh="金额" en="Amount" /></Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {(phase.evidenceEvents ?? []).map((event, index) => (
                <Table.Tr key={`${event.type}-${event.date}-${index}`}>
                  <Table.Td>{dateLabel(event.date, locale)}</Table.Td>
                  <Table.Td>{humanize(event.type)}</Table.Td>
                  <Table.Td>{humanize(event.detail)}</Table.Td>
                  <Table.Td c={tone(event.amountGbp)} ta="right">{optionalGbp(event.amountGbp)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </div>
    </Stack>
  );
}

function PhaseContributors({ label, rows }: { label: React.ReactNode; rows: ReviewBucket[] }) {
  return (
    <Card withBorder>
      <Text fw={700} mb="xs">{label}</Text>
      {rows.length ? rows.map((row) => (
        <Group justify="space-between" key={row.label} py={4} wrap="nowrap">
          <Text size="sm">{row.label}</Text>
          <Text c={tone(row.netResultGbp)} fw={700} size="sm">{gbp(row.netResultGbp, 2)}</Text>
        </Group>
      )) : <Text c="dimmed" size="sm"><Localized zh="该阶段没有可归因的记录。" en="No attributable records are available for this phase." /></Text>}
    </Card>
  );
}

function TradeQualityPanel({ quality }: { quality: AccountReview["realisedTradeQuality"] }) {
  const best = quality.best_trades ?? [];
  const worst = quality.worst_trades ?? [];
  return (
    <Stack gap="lg">
      <SectionState reason={quality.unavailable_reason} status={quality.status} />
      {quality.status !== "unavailable" ? (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Metric label={<Localized zh="交易活动数" en="Trade count" />} value={count(quality.trade_count)} />
            <Metric label={<Localized zh="胜率" en="Win rate" />} value={optionalPct(quality.win_rate)} />
            <Metric label="Profit factor" value={optionalRatio(quality.profit_factor)} />
            <Metric label={<Localized zh="盈亏比" en="Payoff ratio" />} value={optionalRatio(quality.payoff_ratio)} />
            <Metric label={<Localized zh="平均盈利" en="Average win" />} value={optionalGbp(quality.average_win_gbp)} />
            <Metric label={<Localized zh="平均亏损" en="Average loss" />} tone="red" value={optionalGbp(quality.average_loss_gbp)} />
            <Metric label={<Localized zh="每次期望" en="Expectancy / trade" />} tone={tone(finite(quality.expectancy_gbp))} value={optionalGbp(quality.expectancy_gbp)} />
            <Metric label={<Localized zh="净已实现结果" en="Net realised result" />} tone={tone(finite(quality.net_result_gbp))} value={optionalGbp(quality.net_result_gbp)} />
            <Metric label={<Localized zh="平均 / 中位持仓" en="Average / median hold" />} value={`${optionalRatio(quality.average_holding_days, 1)}d / ${optionalRatio(quality.median_holding_days, 1)}d`} />
            <Metric label={<Localized zh="当日 / 短持 / 长持" en="Same-day / short / long" />} value={`${count(quality.same_day_count)} / ${count(quality.short_holding_count)} / ${count(quality.long_holding_count)}`} />
            <Metric label={<Localized zh="最长连胜 / 连亏" en="Longest win / loss streak" />} value={`${count(quality.longest_winning_streak)} / ${count(quality.longest_losing_streak)}`} />
            <Metric label={<Localized zh="左尾损失 P10" en="Left-tail loss P10" />} tone="red" value={optionalGbp(quality.left_tail_loss_p10_gbp)} />
            <Metric label={<Localized zh="最佳交易占总盈利" en="Best trade share of wins" />} value={optionalPct(quality.best_trade_share_of_gross_wins)} />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, lg: 2 }}>
            <TradeTable label={<Localized zh="最佳交易" en="Best trades" />} rows={best} />
            <TradeTable label={<Localized zh="最差交易" en="Worst trades" />} rows={worst} />
          </SimpleGrid>
          <CounterfactualTable rows={quality.top_n_counterfactuals ?? []} />
        </>
      ) : null}
    </Stack>
  );
}

function TradeTable({ label, rows }: { label: React.ReactNode; rows: ReviewTrade[] }) {
  return (
    <div>
      <Text fw={700} mb="xs">{label}</Text>
      <Table.ScrollContainer minWidth={620} scrollAreaProps={{ viewportProps: { "aria-label": "Best and worst trades", tabIndex: 0 } }}>
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th>Ticker</Table.Th><Table.Th><Localized zh="持有" en="Hold" /></Table.Th><Table.Th><Localized zh="方向" en="Direction" /></Table.Th><Table.Th ta="right"><Localized zh="费用" en="Fees" /></Table.Th><Table.Th ta="right"><Localized zh="净结果" en="Net result" /></Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((trade, index) => (
              <Table.Tr key={`${trade.ticker}-${trade.end ?? index}`}>
                <Table.Td><Text fw={700}>{trade.ticker}</Text><Text c="dimmed" size="xs">{trade.name}</Text></Table.Td>
                <Table.Td>{optionalRatio(trade.durationDays, 1)}d</Table.Td>
                <Table.Td>{humanize(trade.direction)}</Table.Td>
                <Table.Td ta="right">{gbp(trade.feesGbp, 2)}</Table.Td>
                <Table.Td c={tone(trade.netResultGbp)} fw={700} ta="right">{gbp(trade.netResultGbp, 2)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </div>
  );
}

function CounterfactualTable({ rows }: { rows: AccountReview["realisedTradeQuality"]["top_n_counterfactuals"] extends infer T ? NonNullable<T> : never }) {
  if (!rows.length) return null;
  return (
    <div>
      <Text fw={700} mb="xs"><Localized zh="如果去掉最佳交易" en="Without the best trades" /></Text>
      <Table.ScrollContainer minWidth={620} scrollAreaProps={{ viewportProps: { "aria-label": "Top trade counterfactuals", tabIndex: 0 } }}>
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th><Localized zh="去掉前 N 笔" en="Remove top N" /></Table.Th><Table.Th ta="right"><Localized zh="去掉笔数" en="Trades removed" /></Table.Th><Table.Th ta="right"><Localized zh="去掉的盈亏" en="Removed P&L" /></Table.Th><Table.Th ta="right"><Localized zh="剩余盈亏" en="Remaining P&L" /></Table.Th><Table.Th><Localized zh="仍然盈利" en="Still profitable" /></Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.removeTopN}>
                <Table.Td>Top {row.removeTopN}</Table.Td>
                <Table.Td ta="right">{count(row.removedTradeCount)}</Table.Td>
                <Table.Td ta="right">{gbp(row.removedResultGbp, 2)}</Table.Td>
                <Table.Td c={tone(row.remainingNetResultGbp)} fw={700} ta="right">{gbp(row.remainingNetResultGbp, 2)}</Table.Td>
                <Table.Td>{row.remainingProfitable ? <Localized zh="是" en="Yes" /> : <Localized zh="否" en="No" />}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </div>
  );
}

function AttributionPanel({ attribution }: { attribution: AccountReview["attribution"] }) {
  const componentRows = records(attribution.components, "buckets");
  return (
    <Stack gap="md">
      <SectionState reason={attribution.unavailable_reason} status={attribution.status} />
      {attribution.status !== "unavailable" ? (
        <Tabs defaultValue="instrument">
          <Tabs.List className="tm-review-tabs">
            <Tabs.Tab value="instrument"><Localized zh="标的" en="Instrument" /></Tabs.Tab>
            <Tabs.Tab value="industry"><Localized zh="行业" en="Industry" /></Tabs.Tab>
            <Tabs.Tab value="country"><Localized zh="国家" en="Country" /></Tabs.Tab>
            <Tabs.Tab value="direction"><Localized zh="方向" en="Direction" /></Tabs.Tab>
            <Tabs.Tab value="holding"><Localized zh="持有期" en="Holding period" /></Tabs.Tab>
            <Tabs.Tab value="calendar"><Localized zh="日历" en="Calendar" /></Tabs.Tab>
            <Tabs.Tab value="components"><Localized zh="收益构成" en="Components" /></Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel pt="md" value="instrument"><BucketSection section={attribution.by_instrument} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="industry"><BucketSection section={attribution.by_industry} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="country"><BucketSection section={attribution.by_country} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="direction"><BucketSection section={attribution.by_direction} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="holding"><BucketSection section={attribution.by_holding_bucket} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="calendar"><CalendarAttribution calendar={attribution.by_calendar} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="components"><ComponentAttribution rows={componentRows} section={attribution.components} /></Tabs.Panel>
        </Tabs>
      ) : null}
    </Stack>
  );
}

function BucketSection({ section }: { section: AccountReview["attribution"]["by_instrument"] }) {
  return (
    <Stack gap="md">
      <SectionState reason={section.unavailable_reason} status={section.status} />
      {section.status !== "unavailable" ? <AttributionTable rows={section.buckets ?? []} /> : null}
    </Stack>
  );
}

function AttributionTable({ rows }: { rows: ReviewBucket[] }) {
  const ordered = [...rows].sort((left, right) => Math.abs(right.netResultGbp) - Math.abs(left.netResultGbp));
  return (
    <>
    <div className="tm-review-desktop-attribution"><Table.ScrollContainer minWidth={820} scrollAreaProps={{ viewportProps: { "aria-label": "Profit and loss attribution", tabIndex: 0 } }}>
      <Table striped>
        <Table.Thead><Table.Tr><Table.Th><Localized zh="分组" en="Bucket" /></Table.Th><Table.Th ta="right"><Localized zh="交易数" en="Trades" /></Table.Th><Table.Th ta="right"><Localized zh="盈利" en="Gross wins" /></Table.Th><Table.Th ta="right"><Localized zh="亏损" en="Gross losses" /></Table.Th><Table.Th ta="right"><Localized zh="费用" en="Fees" /></Table.Th><Table.Th ta="right"><Localized zh="净结果" en="Net result" /></Table.Th><Table.Th ta="right"><Localized zh="绝对贡献占比" en="Share of absolute result" /></Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {ordered.map((row) => (
            <Table.Tr key={row.label}>
              <Table.Th scope="row">{humanize(row.label)}</Table.Th>
              <Table.Td ta="right">{count(row.tradeCount)}</Table.Td>
              <Table.Td c="green" ta="right">{gbp(row.grossWinsGbp, 2)}</Table.Td>
              <Table.Td c="red" ta="right">{gbp(row.grossLossesGbp, 2)}</Table.Td>
              <Table.Td ta="right">{gbp(row.feesGbp, 2)}</Table.Td>
              <Table.Td c={tone(row.netResultGbp)} fw={700} ta="right">{gbp(row.netResultGbp, 2)}</Table.Td>
              <Table.Td ta="right">{optionalPct(row.shareOfAbsoluteResult)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer></div>
    <Stack className="tm-review-mobile-attribution" gap="xs">
      {ordered.map((row) => (
        <Card key={row.label} padding="sm" withBorder>
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text fw={700} size="sm">{humanize(row.label)}</Text>
              <Text c="dimmed" size="xs">{count(row.tradeCount)} <Localized zh="笔交易" en="trades" /> · <Localized zh="绝对贡献" en="absolute share" /> {optionalPct(row.shareOfAbsoluteResult)}</Text>
            </div>
            <Text c={tone(row.netResultGbp)} fw={800}>{gbp(row.netResultGbp, 2)}</Text>
          </Group>
          <Group gap="md" mt={6}>
            <Text c="green" size="xs"><Localized zh="盈利" en="Wins" /> {gbp(row.grossWinsGbp, 2)}</Text>
            <Text c="red" size="xs"><Localized zh="亏损" en="Losses" /> {gbp(row.grossLossesGbp, 2)}</Text>
            <Text c="dimmed" size="xs"><Localized zh="费用" en="Fees" /> {gbp(row.feesGbp, 2)}</Text>
          </Group>
        </Card>
      ))}
    </Stack>
    </>
  );
}

function CalendarAttribution({ calendar }: { calendar: AccountReview["attribution"]["by_calendar"] }) {
  return (
    <Stack gap="lg">
      <SectionState reason={calendar.unavailable_reason} status={calendar.status} />
      {calendar.status !== "unavailable" ? (
        <Tabs defaultValue="year">
          <Tabs.List className="tm-review-tabs"><Tabs.Tab value="year"><Localized zh="年度" en="Year" /></Tabs.Tab><Tabs.Tab value="month"><Localized zh="月份" en="Month" /></Tabs.Tab><Tabs.Tab value="weekday"><Localized zh="星期" en="Weekday" /></Tabs.Tab></Tabs.List>
          <Tabs.Panel pt="md" value="year"><AttributionTable rows={calendar.year ?? []} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="month"><AttributionTable rows={calendar.month ?? []} /></Tabs.Panel>
          <Tabs.Panel pt="md" value="weekday"><AttributionTable rows={calendar.weekday ?? []} /></Tabs.Panel>
        </Tabs>
      ) : null}
    </Stack>
  );
}

function ComponentAttribution({ rows, section }: { rows: UnknownRecord[]; section: AccountReview["attribution"]["components"] }) {
  return (
    <Stack gap="md">
      <SectionState reason={section.unavailable_reason} status={section.status} />
      {section.status !== "unavailable" ? (
        <Table.ScrollContainer minWidth={520} scrollAreaProps={{ viewportProps: { "aria-label": "Return components", tabIndex: 0 } }}>
          <Table striped>
            <Table.Thead><Table.Tr><Table.Th><Localized zh="构成" en="Component" /></Table.Th><Table.Th ta="right"><Localized zh="贡献" en="Contribution" /></Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{rows.map((row, index) => {
              const contribution = finite(row.contribution_gbp);
              return <Table.Tr key={`${textValue(row.label)}-${index}`}><Table.Th scope="row">{humanize(textValue(row.label))}</Table.Th><Table.Td c={tone(contribution)} fw={700} ta="right">{optionalGbp(contribution)}</Table.Td></Table.Tr>;
            })}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
    </Stack>
  );
}

function StructuralPanel({ diagnostics }: { diagnostics: AccountReview["structuralDiagnostics"] }) {
  const observations = (diagnostics.observations ?? []).filter((item): item is UnknownRecord => Boolean(record(item)));
  return (
    <Stack gap="lg">
      <SectionState reason={diagnostics.unavailable_reason} status={diagnostics.status} />
      {diagnostics.status !== "unavailable" ? (
        <>
          <SimpleGrid cols={{ base: 2, md: 3 }}>
            <Metric label={<Localized zh="总交易名义金额" en="Gross traded notional" />} value={optionalGbp(diagnostics.gross_traded_notional_gbp)} />
            <Metric label={<Localized zh="买入 / 卖出订单" en="Buy / sell orders" />} value={`${count(diagnostics.buy_orders)} / ${count(diagnostics.sell_orders)}`} />
            <Metric label={<Localized zh="交易时平均活跃持仓" en="Average active positions" />} value={optionalRatio(diagnostics.average_active_positions_at_trade_events, 1)} />
            <Metric label={<Localized zh="交易时峰值持仓" en="Peak active positions" />} value={count(diagnostics.peak_active_positions_at_trade_events)} />
            <Metric label={<Localized zh="回撤期买入名义金额" en="Buy notional during drawdown" />} value={optionalGbp(diagnostics.drawdown_buy_notional_gbp)} />
          </SimpleGrid>
          <ObservationTable rows={observations} />
          {(diagnostics.partial_reasons ?? []).length ? <WarningSummary warnings={diagnostics.partial_reasons ?? []} /> : null}
        </>
      ) : null}
    </Stack>
  );
}

function ObservationTable({ rows }: { rows: UnknownRecord[] }) {
  return (
    <Table.ScrollContainer minWidth={720} scrollAreaProps={{ viewportProps: { "aria-label": "Observable structural diagnostics", tabIndex: 0 } }}>
      <Table striped>
        <Table.Thead><Table.Tr><Table.Th><Localized zh="观察项" en="Observation" /></Table.Th><Table.Th ta="right"><Localized zh="结果" en="Result" /></Table.Th><Table.Th><Localized zh="依据" en="Basis" /></Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{rows.map((row, index) => {
          const diagnostic = textValue(row.diagnostic);
          const value = finite(row.value);
          const renderedValue = diagnostic.includes("gbp")
            ? optionalGbp(value)
            : diagnostic.includes("days")
              ? `${optionalRatio(value, 1)}d`
              : optionalPct(value);
          const evidence = record(row.evidence);
          return (
            <Table.Tr key={`${diagnostic}-${index}`}>
              <Table.Th scope="row">{humanize(diagnostic)}</Table.Th>
              <Table.Td ta="right">{renderedValue}</Table.Td>
              <Table.Td>{evidence ? Object.entries(evidence).map(([key, item]) => `${humanize(key)}: ${textValue(item)}`).join(" · ") : "—"}</Table.Td>
            </Table.Tr>
          );
        })}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function EndingRiskPanel({ ending }: { ending: AccountReview["endingRisk"] }) {
  const concentration = record(ending.concentration);
  const exposureEntries = Object.entries(ending.exposures ?? {});
  return (
    <Stack gap="lg">
      <SectionState reason={ending.unavailable_reason} status={ending.status} />
      {ending.status !== "unavailable" ? (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Metric label={<Localized zh="账户值" en="Account value" />} value={optionalGbp(ending.account_value_gbp)} />
            <Metric label={<Localized zh="投资市值" en="Invested value" />} value={optionalGbp(ending.invested_value_gbp)} />
            <Metric label={<Localized zh="现金 / 现金权重" en="Cash / cash weight" />} value={`${optionalGbp(ending.cash_gbp)} / ${optionalPct(ending.cash_weight)}`} />
            <Metric label={<Localized zh="未实现损益" en="Unrealised P&L" />} tone={tone(finite(ending.unrealized_pnl_gbp))} value={optionalGbp(ending.unrealized_pnl_gbp)} />
            <Metric label={<Localized zh="持仓数量" en="Positions" />} value={count(ending.position_count)} />
            <Metric label="HHI" value={optionalRatio(concentration?.hhi, 3)} />
            <Metric label={<Localized zh="有效持仓数" en="Effective positions" />} value={optionalRatio(concentration?.effective_positions, 1)} />
            <Metric label={<Localized zh="最大 / 前三权重" en="Largest / top-three weight" />} value={`${optionalPct(concentration?.largest_weight)} / ${optionalPct(concentration?.top_three_weight)}`} />
          </SimpleGrid>
          <HoldingsTable rows={ending.holdings ?? []} />
          {exposureEntries.length ? (
            <div>
              <Text fw={700} mb="xs"><Localized zh="期末暴露" en="Ending exposures" /></Text>
              <Tabs defaultValue={exposureEntries[0]?.[0] ?? null}>
                <Tabs.List className="tm-review-tabs">
                  {exposureEntries.map(([key]) => <Tabs.Tab key={key} value={key}>{humanize(key)}</Tabs.Tab>)}
                </Tabs.List>
                {exposureEntries.map(([key, section]) => (
                  <Tabs.Panel key={key} pt="md" value={key}><ExposureTable section={section} /></Tabs.Panel>
                ))}
              </Tabs>
            </div>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

function HoldingsTable({ rows }: { rows: ReviewHolding[] }) {
  return (
    <div>
      <Text fw={700} mb="xs"><Localized zh="期末持仓" en="Ending holdings" /></Text>
      <Table.ScrollContainer minWidth={760} scrollAreaProps={{ viewportProps: { "aria-label": "Ending review holdings", tabIndex: 0 } }}>
        <Table highlightOnHover>
          <Table.Thead><Table.Tr><Table.Th>Ticker</Table.Th><Table.Th><Localized zh="名称" en="Name" /></Table.Th><Table.Th ta="right"><Localized zh="数量" en="Quantity" /></Table.Th><Table.Th ta="right"><Localized zh="市值" en="Value" /></Table.Th><Table.Th ta="right"><Localized zh="权重" en="Weight" /></Table.Th><Table.Th ta="right"><Localized zh="成本" en="Cost" /></Table.Th><Table.Th ta="right"><Localized zh="未实现损益" en="Unrealised P&L" /></Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{rows.map((holding) => (
            <Table.Tr key={holding.ticker}>
              <Table.Th scope="row">{holding.ticker}</Table.Th>
              <Table.Td>{holding.name}</Table.Td>
              <Table.Td ta="right">{holding.quantity == null ? "—" : optionalRatio(holding.quantity, 4)}</Table.Td>
              <Table.Td ta="right">{gbp(holding.currentValueGbp, 2)}</Table.Td>
              <Table.Td ta="right">{optionalPct(holding.weight)}</Table.Td>
              <Table.Td ta="right">{optionalGbp(holding.totalCostGbp)}</Table.Td>
              <Table.Td c={tone(holding.unrealizedPnlGbp)} fw={700} ta="right">{optionalGbp(holding.unrealizedPnlGbp)}</Table.Td>
            </Table.Tr>
          ))}</Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </div>
  );
}

function ExposureTable({ section }: { section: AccountReview["endingRisk"]["concentration"] }) {
  const rows = records(section, "buckets");
  return (
    <Stack gap="md">
      <SectionState reason={section.unavailable_reason} status={section.status} />
      {section.status !== "unavailable" ? (
        <Table.ScrollContainer minWidth={520} scrollAreaProps={{ viewportProps: { "aria-label": "Ending exposure", tabIndex: 0 } }}>
          <Table striped>
            <Table.Thead><Table.Tr><Table.Th><Localized zh="分类" en="Bucket" /></Table.Th><Table.Th ta="right"><Localized zh="市值" en="Value" /></Table.Th><Table.Th ta="right"><Localized zh="权重" en="Weight" /></Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{rows.map((row, index) => <Table.Tr key={`${textValue(row.label)}-${index}`}><Table.Th scope="row">{textValue(row.label)}</Table.Th><Table.Td ta="right">{optionalGbp(row.value_gbp)}</Table.Td><Table.Td ta="right">{optionalPct(row.weight)}</Table.Td></Table.Tr>)}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
    </Stack>
  );
}

export function CfdHistoricalReview({
  accountName,
  review,
  summary,
}: {
  accountName: string;
  review: CfdAccountReview;
  summary: CfdSummary | null;
}) {
  const { locale } = useLocale();
  const latest = review.realisedSeries?.at(-1);
  const importStatus = review.importStatus;
  const historicalMode = importStatus.accountStatus === "retired" || !importStatus.staleRemindersEnabled;
  const freshness = historicalMode
    ? { color: "gray", label: locale === "zh" ? "历史记录模式" : "Historical mode" }
    : importStatus.isStale
      ? { color: "yellow", label: locale === "zh" ? "数据可能过期" : "Possibly stale" }
      : { color: "green", label: locale === "zh" ? "数据在有效期内" : "Data current" };
  const warnings = [
    ...(review.warnings ?? []),
    ...(importStatus.warnings ?? []),
    review.coverage.unavailableReason,
    review.moneyOutcome.unavailableReason,
    review.strategyRisk.unavailableReason,
    review.phases.unavailableReason,
    review.structuralDiagnostics.unavailableReason,
    review.endingRisk.unavailableReason,
    ...(review.endingRisk.warnings ?? []),
    summary?.warning,
  ];
  return (
    <Stack gap="xl">
      <Card className="tm-review-money-hero" data-account="C">
        <Stack gap="lg">
          <Group align="flex-start" justify="space-between" wrap="wrap">
            <div>
              <Title order={2}>{accountName}</Title>
              <Text c="dimmed" size="sm">{dateLabel(review.coverage.startDate, locale)} → {dateLabel(review.coverage.endDate, locale)} · {review.coverage.currency ?? "—"}</Text>
            </div>
            <Badge color={freshness.color} variant="light">{freshness.label}</Badge>
          </Group>
          <div>
            <Group align="center" gap={0}>
              <Text c="dimmed" size="xs"><Localized zh="已实现现金权益代理值" en="Realised cash-equity proxy" /></Text>
              {!review.moneyOutcome.trueNavAvailable ? (
                <ContextHelp
                  content={<Localized zh="这是导入记录计算的已实现现金权益代理值，不是当前券商权益；未平仓盈亏和当前市值风险无法由这些记录确定。" en="This is a realised cash-equity proxy calculated from imported records, not current broker equity. Open-position P&L and current mark-to-market risk cannot be determined from these records." />}
                  label={locale === "zh" ? "已实现现金权益代理值说明" : "About the realised cash-equity proxy"}
                  title={<Localized zh="口径说明" en="Measurement boundary" />}
                />
              ) : null}
            </Group>
            <Title order={2} size="clamp(2.4rem, 7vw, 4.75rem)">{optionalGbp(latest?.realisedCashEquityProxy)}</Title>
          </div>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Metric label={<Localized zh="净已实现损益" en="Net realised P&L" />} tone={tone(review.realisedPnl.netRealisedPnl)} value={gbp(review.realisedPnl.netRealisedPnl, 2)} />
            <Metric label={<Localized zh="账户现金流" en="Account cash flow" />} value={gbp(review.cashFlows.accountCashFlow, 2)} />
            <Metric label={<Localized zh="最大已实现回撤" en="Max realised drawdown" />} tone="red" value={gbp(review.realisedPnl.maxRealisedPnlDrawdown, 2)} />
            <Metric label={<Localized zh="唯一事件" en="Unique events" />} value={count(importStatus.uniqueEvents)} />
          </SimpleGrid>
        </Stack>
      </Card>

      <CfdDiagnosis review={review} />

      <WarningSummary warnings={warnings} />

      <section aria-labelledby="cfd-review-evidence-title">
      <Title id="cfd-review-evidence-title" mb={4} order={2} size="h3"><Localized zh="查看证据" en="Review the evidence" /></Title>
      <Accordion multiple variant="contained">
        <Accordion.Item value="cfd-result">
          <Accordion.Control><SectionControl description={<Localized zh="现金流、交易结果与费用分开核算" en="Separates cash flows, trading results, and costs" />} status={review.moneyOutcome.status} title={<Localized zh="资金结果" en="Money result" />} /></Accordion.Control>
          <Accordion.Panel><Stack gap="md"><SectionState reason={review.moneyOutcome.unavailableReason} status={review.moneyOutcome.status} /><CfdResultPanel review={review} /></Stack></Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cfd-series">
          <Accordion.Control><SectionControl description={<Localized zh="无每日净值，仅显示已平仓结果和英镑回撤" en="No daily NAV; shows closed results and GBP drawdown only" />} status={review.strategyRisk.status} title={<Localized zh="策略与风险" en="Strategy and risk" />} /></Accordion.Control>
          <Accordion.Panel><Stack gap="md"><SectionState reason={review.strategyRisk.unavailableReason} status={review.strategyRisk.status} /><CfdSeriesPanel review={review} /></Stack></Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cfd-phases">
          <Accordion.Control><SectionControl description={<Localized zh="关键阶段、事件与主要贡献和拖累" en="Key phases, events, contributors, and detractors" />} status={review.phases.status} title={<Localized zh="账户阶段" en="Account phases" />} /></Accordion.Control>
          <Accordion.Panel><CfdPhasesPanel phases={review.phases} /></Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cfd-quality">
          <Accordion.Control><SectionControl description={<Localized zh="胜率、持有期、连胜连亏和极端交易依赖" en="Win rate, duration, streaks, and extreme-trade dependence" />} title={<Localized zh="已实现交易质量" en="Realised trade quality" />} /></Accordion.Control>
          <Accordion.Panel><CfdQualityPanel quality={review.tradeQuality} /></Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cfd-attribution">
          <Accordion.Control><SectionControl description={<Localized zh="多空、标的、持有期、日期和星期归因" en="Long/short, instrument, duration, date, and weekday attribution" />} title={<Localized zh="CFD 盈亏归因" en="CFD P&L attribution" />} /></Accordion.Control>
          <Accordion.Panel><CfdAttributionPanel attribution={review.attribution} /></Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cfd-structure">
          <Accordion.Control><SectionControl description={<Localized zh="名义本金、融资成本和集中度" en="Notional exposure, financing cost, and concentration" />} status={review.structuralDiagnostics.status} title={<Localized zh="交易行为与结构" en="Trading behaviour and structure" />} /></Accordion.Control>
          <Accordion.Panel><CfdStructuralPanel review={review} /></Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="cfd-ending-risk">
          <Accordion.Control><SectionControl description={<Localized zh="期末订单、名义敞口与数据完整性" en="Ending orders, notional exposure, and data completeness" />} status={review.endingRisk.status} title={<Localized zh="期末持仓与当前风险" en="Ending positions and current risk" />} /></Accordion.Control>
          <Accordion.Panel><CfdEndingRiskPanel review={review} /></Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      </section>

      <Accordion variant="contained">
        <Accordion.Item value="cfd-imports">
          <Accordion.Control><SectionControl description={<Localized zh="文件、时间范围和重复记录" en="Files, date coverage, and duplicate records" />} title={<Localized zh="导入记录" en="Import records" />} /></Accordion.Control>
          <Accordion.Panel><CfdImportsPanel review={review} /></Accordion.Panel>
        </Accordion.Item>
      </Accordion>

    </Stack>
  );
}

function CfdDiagnosis({ review }: { review: CfdAccountReview }) {
  const { locale } = useLocale();
  const rows = [...(review.attribution.byInstrument ?? [])];
  const contributor = rows.filter((row) => row.netRealisedPnl > 0).sort((left, right) => right.netRealisedPnl - left.netRealisedPnl)[0];
  const detractor = rows.filter((row) => row.netRealisedPnl < 0).sort((left, right) => left.netRealisedPnl - right.netRealisedPnl)[0];
  const phase = [...(review.phases.items ?? [])].sort((left, right) => {
    const leftImpact = Math.abs(left.realisedPnlGbp) + Math.abs(left.accountCashFlowGbp);
    const rightImpact = Math.abs(right.realisedPnlGbp) + Math.abs(right.accountCashFlowGbp);
    return rightImpact - leftImpact;
  })[0];
  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Title order={3}><Localized zh="本次结论" en="Review summary" /></Title>
        </div>
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Metric label={<Localized zh="净已实现损益" en="Net realised P&L" />} tone={tone(review.realisedPnl.netRealisedPnl)} value={gbp(review.realisedPnl.netRealisedPnl, 2)} />
          <Metric label={<Localized zh="首要贡献" en="Top contributor" />} tone="green" value={contributor ? `${contributor.key} · ${gbp(contributor.netRealisedPnl, 2)}` : "—"} />
          <Metric label={<Localized zh="主要拖累" en="Top detractor" />} tone="red" value={detractor ? `${detractor.key} · ${gbp(detractor.netRealisedPnl, 2)}` : "—"} />
          <Metric label={<Localized zh="影响最大的阶段" en="Most impactful phase" />} tone={tone(phase?.realisedPnlGbp)} value={phase ? `${gbp(phase.realisedPnlGbp, 2)} · ${dateLabel(phase.startDate, locale)}` : "—"} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function CfdResultPanel({ review }: { review: CfdAccountReview }) {
  const cash = review.cashFlows;
  const pnl = review.realisedPnl;
  return (
    <Stack gap="lg">
      <div>
        <Text fw={700} mb="md"><Localized zh="账户现金流" en="Account cash flows" /></Text>
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Metric label={<Localized zh="入金" en="Deposits" />} value={gbp(cash.deposits, 2)} />
          <Metric label={<Localized zh="取款" en="Withdrawals" />} value={gbp(cash.withdrawals, 2)} />
          <Metric label={<Localized zh="内部转账" en="Internal transfers" />} value={gbp(cash.internalTransfers, 2)} />
          <Metric label={<Localized zh="调整" en="Adjustments" />} value={gbp(cash.adjustments, 2)} />
          <Metric label={<Localized zh="账户现金流合计" en="Account cash-flow total" />} value={gbp(cash.accountCashFlow, 2)} />
          <Metric label={<Localized zh="家庭外部现金流" en="Household external flow" />} value={gbp(cash.householdExternalFlow, 2)} />
        </SimpleGrid>
      </div>
      <div>
        <Text fw={700} mb="md"><Localized zh="已实现结果瀑布" en="Realised result waterfall" /></Text>
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Metric label={<Localized zh="已平仓毛结果" en="Closed gross result" />} tone={tone(pnl.closedGrossResult)} value={gbp(pnl.closedGrossResult, 2)} />
          <Metric label={<Localized zh="FX 费用" en="FX fees" />} tone="red" value={gbp(pnl.fxFees, 2)} />
          <Metric label={<Localized zh="FX 后平仓结果" en="Closed after FX" />} tone={tone(pnl.closedAfterFx)} value={gbp(pnl.closedAfterFx, 2)} />
          <Metric label={<Localized zh="隔夜利息" en="Overnight interest" />} tone="red" value={gbp(pnl.overnightInterest, 2)} />
          <Metric label={<Localized zh="股息调整" en="Dividend adjustment" />} tone={tone(pnl.dividendAdjustment)} value={gbp(pnl.dividendAdjustment, 2)} />
          <Metric label={<Localized zh="净已实现损益" en="Net realised P&L" />} tone={tone(pnl.netRealisedPnl)} value={gbp(pnl.netRealisedPnl, 2)} />
          <Metric label={<Localized zh="融资拖累 / 毛结果" en="Financing drag / gross" />} value={optionalDeltaPct(pnl.financingDragToGrossRatio)} />
          <Metric label={<Localized zh="融资拖累 / 净结果" en="Financing drag / net" />} value={optionalDeltaPct(pnl.financingDragToNetRatio)} />
        </SimpleGrid>
      </div>
    </Stack>
  );
}

function CfdSeriesPanel({ review }: { review: CfdAccountReview }) {
  const { locale } = useLocale();
  const series = review.realisedSeries ?? [];
  const latest = series.at(-1);
  const visible = series.slice(-100);
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric label={<Localized zh="累计账户现金流" en="Cumulative account cash flow" />} value={optionalGbp(latest?.cumulativeAccountCashFlow)} />
        <Metric label={<Localized zh="累计已实现损益" en="Cumulative realised P&L" />} tone={tone(latest?.cumulativeRealisedPnl)} value={optionalGbp(latest?.cumulativeRealisedPnl)} />
        <Metric label={<Localized zh="期末已实现权益" en="Ending realised equity" />} value={optionalGbp(latest?.realisedCashEquityProxy)} />
        <Metric label={<Localized zh="当前已实现回撤" en="Current realised drawdown" />} tone="red" value={optionalGbp(latest?.realisedPnlDrawdown)} />
      </SimpleGrid>
      <Table.ScrollContainer minWidth={860} scrollAreaProps={{ viewportProps: { "aria-label": "CFD realised cash equity proxy history", tabIndex: 0 } }}>
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th><Localized zh="时间" en="Time" /></Table.Th><Table.Th><Localized zh="事件" en="Event" /></Table.Th><Table.Th ta="right"><Localized zh="现金流变化" en="Cash-flow change" /></Table.Th><Table.Th ta="right"><Localized zh="已实现变化" en="Realised change" /></Table.Th><Table.Th ta="right"><Localized zh="累计已实现" en="Cumulative realised" /></Table.Th><Table.Th ta="right"><Localized zh="已实现权益" en="Realised equity" /></Table.Th><Table.Th ta="right"><Localized zh="回撤" en="Drawdown" /></Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{visible.map((point) => (
            <Table.Tr key={point.eventId}>
              <Table.Td>{dateLabel(point.occurredAt, locale)}</Table.Td><Table.Td>{point.recordType}</Table.Td>
              <Table.Td ta="right">{gbp(point.accountCashFlowChange, 2)}</Table.Td>
              <Table.Td c={tone(point.realisedPnlChange)} ta="right">{gbp(point.realisedPnlChange, 2)}</Table.Td>
              <Table.Td c={tone(point.cumulativeRealisedPnl)} ta="right">{gbp(point.cumulativeRealisedPnl, 2)}</Table.Td>
              <Table.Td ta="right">{gbp(point.realisedCashEquityProxy, 2)}</Table.Td>
              <Table.Td c="red" ta="right">{gbp(point.realisedPnlDrawdown, 2)}</Table.Td>
            </Table.Tr>
          ))}</Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

function CfdPhasesPanel({ phases }: { phases: CfdAccountReview["phases"] }) {
  const items = phases.items ?? [];
  const featured = [...items]
    .sort((left, right) => {
      const rightImpact = Math.abs(right.realisedPnlGbp) + Math.abs(right.accountCashFlowGbp);
      const leftImpact = Math.abs(left.realisedPnlGbp) + Math.abs(left.accountCashFlowGbp);
      return rightImpact - leftImpact || left.startDate.localeCompare(right.startDate);
    })
    .slice(0, 4)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  return (
    <Stack gap="md">
      <SectionState reason={phases.unavailableReason} status={phases.status} />
      {phases.status !== "unavailable" ? (
        <>
          <div>
            <Text fw={700} mb="xs"><Localized zh="关键阶段（按现金流与已实现损益的绝对影响筛选）" en="Key phases (selected by absolute cash-flow and realised-P&L impact)" /></Text>
            <CfdPhaseList phases={featured} />
          </div>
          {items.length > featured.length ? (
            <Accordion variant="separated">
              <Accordion.Item value="all-cfd-phases">
                <Accordion.Control>
                  <Group justify="space-between" pr="md">
                    <Text fw={700}><Localized zh="查看全部阶段" en="View all phases" /></Text>
                    <Badge color="gray" variant="light">{items.length}</Badge>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel><CfdPhaseList phases={items} /></Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

function CfdPhaseList({ phases }: { phases: CfdPhase[] }) {
  const { locale } = useLocale();
  return (
    <Accordion multiple variant="separated">
      {phases.map((phase) => {
        const isCashFlow = phase.classification === "large_cash_flow";
        const headlineValue = isCashFlow ? phase.accountCashFlowGbp : phase.realisedPnlGbp;
        return (
          <Accordion.Item key={phase.phaseId} value={phase.phaseId}>
            <Accordion.Control>
              <Group justify="space-between" pr="md" wrap="wrap">
                <div>
                  <Text fw={700}>{phaseName(phase.classification)}</Text>
                  <Text c="dimmed" size="xs">{dateLabel(phase.startDate, locale)} → {dateLabel(phase.endDate, locale)}</Text>
                </div>
                <Stack align="flex-end" gap={0}>
                  <Text c={tone(headlineValue)} fw={800}>{gbp(headlineValue, 2)}</Text>
                  <Text c="dimmed" size="xs">{isCashFlow ? <Localized zh="账户现金流" en="Account cash flow" /> : <Localized zh="已实现损益" en="Realised P&L" />}</Text>
                </Stack>
              </Group>
            </Accordion.Control>
            <Accordion.Panel><CfdPhaseDetail phase={phase} /></Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}

function CfdPhaseDetail({ phase }: { phase: CfdPhase }) {
  const { locale } = useLocale();
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric label={<Localized zh="期初已实现权益" en="Opening realised equity" />} value={gbp(phase.openingRealisedCashEquityProxyGbp, 2)} />
        <Metric label={<Localized zh="期末已实现权益" en="Ending realised equity" />} value={gbp(phase.endingRealisedCashEquityProxyGbp, 2)} />
        <Metric label={<Localized zh="账户现金流" en="Account cash flow" />} value={gbp(phase.accountCashFlowGbp, 2)} />
        <Metric label={<Localized zh="家庭外部现金流" en="Household external flow" />} value={gbp(phase.householdExternalFlowGbp, 2)} />
        <Metric label={<Localized zh="阶段已实现损益" en="Phase realised P&L" />} tone={tone(phase.realisedPnlGbp)} value={gbp(phase.realisedPnlGbp, 2)} />
        <Metric label={<Localized zh="阶段最大已实现回撤" en="Phase max realised drawdown" />} tone="red" value={gbp(phase.maxRealisedPnlDrawdownGbp, 2)} />
        <Metric label={<Localized zh="期末已实现回撤" en="Ending realised drawdown" />} tone="red" value={gbp(phase.endingRealisedPnlDrawdownGbp, 2)} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <CfdPhaseContributors label={<Localized zh="主要贡献" en="Top contributors" />} rows={phase.topContributors ?? []} />
        <CfdPhaseContributors label={<Localized zh="主要拖累" en="Top detractors" />} rows={phase.topDetractors ?? []} />
      </SimpleGrid>
      <div>
        <Text fw={700} mb="xs"><Localized zh="阶段事件" en="Phase events" /></Text>
        <Table.ScrollContainer minWidth={720} scrollAreaProps={{ viewportProps: { "aria-label": "CFD deterministic phase evidence", tabIndex: 0 } }}>
          <Table striped>
            <Table.Thead><Table.Tr><Table.Th><Localized zh="时间" en="Time" /></Table.Th><Table.Th><Localized zh="依据" en="Basis" /></Table.Th><Table.Th ta="right"><Localized zh="金额" en="Amount" /></Table.Th><Table.Th><Localized zh="说明" en="Detail" /></Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{(phase.evidenceEvents ?? []).map((event, index) => (
              <Table.Tr key={`${event.type}-${event.occurredAt}-${index}`}>
                <Table.Td>{dateLabel(event.occurredAt, locale)}</Table.Td>
                <Table.Th scope="row">{humanize(event.type)}</Table.Th>
                <Table.Td c={tone(event.amountGbp)} ta="right">{gbp(event.amountGbp, 2)}</Table.Td>
                <Table.Td>{event.detail}</Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </div>
    </Stack>
  );
}

function CfdPhaseContributors({
  label,
  rows,
}: {
  label: React.ReactNode;
  rows: NonNullable<CfdPhase["topContributors"]>;
}) {
  return (
    <Card withBorder>
      <Text fw={700} mb="xs">{label}</Text>
      {rows.length ? rows.map((row) => (
        <Group justify="space-between" key={row.key} py={4} wrap="nowrap">
          <div><Text size="sm">{row.key}</Text><Text c="dimmed" size="xs">{count(row.eventCount)} events</Text></div>
          <Text c={tone(row.realisedPnl)} fw={700} size="sm">{gbp(row.realisedPnl, 2)}</Text>
        </Group>
      )) : <Text c="dimmed" size="sm"><Localized zh="本阶段没有同方向已实现贡献。" en="No realised contribution on this side of the phase." /></Text>}
    </Card>
  );
}

function CfdQualityPanel({ quality }: { quality: CfdAccountReview["tradeQuality"] }) {
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric label={<Localized zh="交易数" en="Trade count" />} value={count(quality.tradeCount)} />
        <Metric label={<Localized zh="盈利 / 亏损 / 持平" en="Wins / losses / breakeven" />} value={`${count(quality.wins)} / ${count(quality.losses)} / ${count(quality.breakeven)}`} />
        <Metric label={<Localized zh="胜率" en="Win rate" />} value={optionalPct(quality.winRate)} />
        <Metric label="Profit factor" value={optionalRatio(quality.profitFactor)} />
        <Metric label={<Localized zh="盈亏比" en="Payoff ratio" />} value={optionalRatio(quality.payoffRatio)} />
        <Metric label={<Localized zh="平均盈利" en="Average win" />} value={optionalGbp(quality.averageWin)} />
        <Metric label={<Localized zh="平均亏损" en="Average loss" />} tone="red" value={optionalGbp(quality.averageLoss)} />
        <Metric label={<Localized zh="每笔期望" en="Expectancy / trade" />} tone={tone(quality.expectancy)} value={optionalGbp(quality.expectancy)} />
        <Metric label={<Localized zh="平均 / 中位持仓" en="Average / median duration" />} value={`${optionalRatio(quality.averageDurationHours, 1)}h / ${optionalRatio(quality.medianDurationHours, 1)}h`} />
        <Metric label={<Localized zh="当日 / 一小时内" en="Same-day / under one hour" />} value={`${count(quality.sameDayCount)} / ${count(quality.underOneHourCount)}`} />
        <Metric label={<Localized zh="最长连胜 / 连亏" en="Longest win / loss streak" />} value={`${count(quality.longestWinStreak)} / ${count(quality.longestLossStreak)}`} />
        <Metric label={<Localized zh="最佳 / 最差交易" en="Best / worst trade" />} value={`${optionalGbp(quality.bestTrade)} / ${optionalGbp(quality.worstTrade)}`} />
        <Metric label={<Localized zh="最佳交易集中度" en="Best-trade concentration" />} value={optionalPct(quality.bestTradeConcentration)} />
        <Metric label={<Localized zh="前三交易集中度" en="Top-three concentration" />} value={optionalPct(quality.topThreeTradeConcentration)} />
        <Metric label={<Localized zh="移除最佳交易后" en="Without best trade" />} tone={tone(quality.netWithoutBestTrade)} value={optionalGbp(quality.netWithoutBestTrade)} />
      </SimpleGrid>
    </Stack>
  );
}

function CfdAttributionPanel({ attribution }: { attribution: CfdAccountReview["attribution"] }) {
  return (
    <Tabs defaultValue="direction">
      <Tabs.List className="tm-review-tabs">
        <Tabs.Tab value="direction"><Localized zh="多空方向" en="Direction" /></Tabs.Tab>
        <Tabs.Tab value="instrument"><Localized zh="标的" en="Instrument" /></Tabs.Tab>
        <Tabs.Tab value="duration"><Localized zh="持有时长" en="Duration" /></Tabs.Tab>
        <Tabs.Tab value="date"><Localized zh="日期" en="Date" /></Tabs.Tab>
        <Tabs.Tab value="weekday"><Localized zh="星期" en="Weekday" /></Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel pt="md" value="direction"><CfdBucketTable rows={attribution.byDirection ?? []} /></Tabs.Panel>
      <Tabs.Panel pt="md" value="instrument"><CfdBucketTable rows={attribution.byInstrument ?? []} /></Tabs.Panel>
      <Tabs.Panel pt="md" value="duration"><CfdBucketTable rows={attribution.byDuration ?? []} /></Tabs.Panel>
      <Tabs.Panel pt="md" value="date"><CfdBucketTable rows={attribution.byDate ?? []} /></Tabs.Panel>
      <Tabs.Panel pt="md" value="weekday"><CfdBucketTable rows={attribution.byWeekday ?? []} /></Tabs.Panel>
    </Tabs>
  );
}

function CfdBucketTable({ rows }: { rows: CfdBucket[] }) {
  const ordered = [...rows].sort((left, right) => Math.abs(right.netRealisedPnl) - Math.abs(left.netRealisedPnl));
  return (
    <>
    <div className="tm-review-desktop-attribution"><Table.ScrollContainer minWidth={560} scrollAreaProps={{ viewportProps: { "aria-label": "CFD attribution", tabIndex: 0 } }}>
      <Table striped>
        <Table.Thead><Table.Tr><Table.Th><Localized zh="分组" en="Bucket" /></Table.Th><Table.Th ta="right"><Localized zh="交易数" en="Trades" /></Table.Th><Table.Th ta="right"><Localized zh="净已实现损益" en="Net realised P&L" /></Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{ordered.map((row) => <Table.Tr key={row.key}><Table.Th scope="row">{humanize(row.key)}</Table.Th><Table.Td ta="right">{count(row.tradeCount)}</Table.Td><Table.Td c={tone(row.netRealisedPnl)} fw={700} ta="right">{gbp(row.netRealisedPnl, 2)}</Table.Td></Table.Tr>)}</Table.Tbody>
      </Table>
    </Table.ScrollContainer></div>
    <Stack className="tm-review-mobile-attribution" gap="xs">
      {ordered.map((row) => (
        <Card key={row.key} padding="sm" withBorder>
          <Group justify="space-between" wrap="nowrap">
            <div><Text fw={700} size="sm">{humanize(row.key)}</Text><Text c="dimmed" size="xs">{count(row.tradeCount)} <Localized zh="笔交易" en="trades" /></Text></div>
            <Text c={tone(row.netRealisedPnl)} fw={800}>{gbp(row.netRealisedPnl, 2)}</Text>
          </Group>
        </Card>
      ))}
    </Stack>
    </>
  );
}

function CfdStructuralPanel({ review }: { review: CfdAccountReview }) {
  const diagnostics = review.structuralDiagnostics;
  return (
    <Stack gap="lg">
      <SectionState reason={diagnostics.unavailableReason} status={diagnostics.status} />
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Metric label={<Localized zh="已平仓名义本金" en="Closed notional" />} value={gbp(diagnostics.totalClosedNotional, 2)} />
        <Metric label={<Localized zh="平均已平仓名义本金" en="Average closed notional" />} value={optionalGbp(diagnostics.averageClosedNotional)} />
        <Metric label={<Localized zh="净结果 / 名义本金" en="Net realised / notional" />} value={optionalDeltaPct(diagnostics.netRealisedToNotionalRatio)} />
        <Metric label={<Localized zh="融资成本 / 名义本金" en="Financing cost / notional" />} value={optionalDeltaPct(diagnostics.financingCostToNotionalRatio)} />
        <Metric label={<Localized zh="最佳交易集中度" en="Best-trade concentration" />} value={optionalPct(diagnostics.bestTradeConcentration)} />
        <Metric label={<Localized zh="前三交易集中度" en="Top-three concentration" />} value={optionalPct(diagnostics.topThreeTradeConcentration)} />
        <Metric label={<Localized zh="移除最佳交易后" en="Without best trade" />} tone={tone(diagnostics.netWithoutBestTrade)} value={optionalGbp(diagnostics.netWithoutBestTrade)} />
        <Metric label={<Localized zh="缺失名义金额的交易" en="Trades missing notional" />} value={count(diagnostics.missingNotionalTradeCount)} />
      </SimpleGrid>
      <div>
        <Text fw={700} mb="xs"><Localized zh="多空结构" en="Long/short structure" /></Text>
        <CfdBucketTable rows={diagnostics.byDirection ?? []} />
      </div>
    </Stack>
  );
}

function CfdEndingRiskPanel({ review }: { review: CfdAccountReview }) {
  const ending = review.endingRisk;
  const unmatched = review.unmatchedExecutedOrders ?? [];
  const { locale } = useLocale();
  return (
    <Stack gap="lg">
      <SectionState reason={ending.unavailableReason} status={ending.status} />
      <WarningSummary warnings={ending.warnings ?? []} />
      {unmatched.length ? (
        <Alert color="yellow" icon={<ShieldWarning size={18} />} title={<Localized zh="可能未平仓或数据不完整" en="Potential open positions or incomplete data" />}>
          <Localized zh={`发现 ${unmatched.length} 条已执行但无法匹配平仓的订单。这里只提示风险，不估算当前 MTM。`} en={`Found ${unmatched.length} executed orders without a matched close. This is a risk flag only; no current MTM is estimated.`} />
        </Alert>
      ) : null}
      {unmatched.length ? (
        <Table.ScrollContainer minWidth={820} scrollAreaProps={{ viewportProps: { "aria-label": "Unmatched executed CFD orders", tabIndex: 0 } }}>
          <Table striped>
            <Table.Thead><Table.Tr><Table.Th><Localized zh="时间" en="Time" /></Table.Th><Table.Th><Localized zh="标的" en="Instrument" /></Table.Th><Table.Th><Localized zh="方向" en="Direction" /></Table.Th><Table.Th><Localized zh="意图" en="Intent" /></Table.Th><Table.Th>Order ID</Table.Th><Table.Th>Position ID</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{unmatched.map((order) => <Table.Tr key={order.eventId}><Table.Td>{dateLabel(order.occurredAt, locale)}</Table.Td><Table.Td>{order.symbol ?? "—"}</Table.Td><Table.Td>{order.direction ?? "—"}</Table.Td><Table.Td>{order.intent ?? "—"}</Table.Td><Table.Td>{order.orderId ?? "—"}</Table.Td><Table.Td>{order.positionId ?? "—"}</Table.Td></Table.Tr>)}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
    </Stack>
  );
}

function CfdImportsPanel({ review }: { review: CfdAccountReview }) {
  const { locale } = useLocale();
  const status = review.importStatus;
  const historicalMode = status.accountStatus === "retired" || !status.staleRemindersEnabled;
  const updateStatus = historicalMode
    ? locale === "zh" ? "历史记录模式" : "Historical mode"
    : status.isStale
      ? locale === "zh" ? "可能需要更新" : "May need an update"
      : locale === "zh" ? "数据在有效期内" : "Data current";
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 2, md: 3 }}>
        <Metric label={<Localized zh="上次导入" en="Last imported" />} value={dateLabel(status.lastImportedAt, locale)} />
        <Metric label={<Localized zh="最新事件" en="Latest event" />} value={dateLabel(status.latestEventAt, locale)} />
        <Metric
          label={<Localized zh="更新状态" en="Update status" />}
          value={updateStatus}
        />
      </SimpleGrid>
      <Table.ScrollContainer minWidth={820} scrollAreaProps={{ viewportProps: { "aria-label": "CFD imported files", tabIndex: 0 } }}>
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th><Localized zh="文件" en="File" /></Table.Th><Table.Th><Localized zh="覆盖期" en="Coverage" /></Table.Th><Table.Th ta="right"><Localized zh="原始行" en="Raw rows" /></Table.Th><Table.Th ta="right"><Localized zh="规范事件" en="Canonical events" /></Table.Th><Table.Th><Localized zh="导入时间" en="Imported" /></Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{(status.files ?? []).map((file) => <Table.Tr key={file.sha256}><Table.Th scope="row">{file.filename}</Table.Th><Table.Td>{dateLabel(file.coverageStartDate, locale)} → {dateLabel(file.coverageEndDate, locale)}</Table.Td><Table.Td ta="right">{count(file.rawRows)}</Table.Td><Table.Td ta="right">{count(file.canonicalEvents)}</Table.Td><Table.Td>{dateLabel(file.importedAt, locale)}</Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
