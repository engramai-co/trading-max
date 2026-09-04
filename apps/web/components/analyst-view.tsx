"use client";

import {
  Alert,
  Badge,
  Box,
  Card,
  Divider,
  Grid,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

import {
  ConsensusGaugeChart,
  EstimateChart,
  PriceTargetChart,
  RatingTrendChart,
  type EstimateBar,
  type RatingPeriod,
} from "@/components/analyst-charts";
import { ContextHelp } from "@/components/context-help";
import { useLocale } from "@/components/locale-provider";
import type { PriceSeriesPoint } from "@/lib/types";

type Row = Record<string, unknown>;
type AnalystPayload = {
  priceTargets?: Record<string, number | null> | null;
  recommendations?: Row[];
  upgradesDowngrades?: Row[];
  earningsEstimate?: Row[];
  revenueEstimate?: Row[];
  earningsHistory?: Row[];
  epsRevisions?: Row[];
};
type ForecastMetric = {
  key: string;
  label: string;
  row: Row | null;
  kind: "currency" | "number";
};

const sectionStyle = { overflow: "hidden" } as const;
const sectionHeaderStyle = { marginBottom: "var(--mantine-spacing-md)", minHeight: 44 } as const;
const forecastValueStyle = {
  fontSize: "clamp(1.45rem, 2.6vw, 2rem)",
  fontWeight: 820,
  letterSpacing: "-0.035em",
  lineHeight: 1.15,
} as const;
const mobileRowStyle = {
  border: "1px solid var(--tm-border)",
  borderRadius: "var(--mantine-radius-md)",
  padding: "var(--mantine-spacing-sm)",
} as const;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number | null, currency: string, digits = 2): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-GB", {
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "currency",
  }).format(value);
}

function compactCurrency(value: number | null, currency: string): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-GB", {
    currency,
    maximumFractionDigits: 2,
    notation: "compact",
    style: "currency",
  }).format(value);
}

function compactNumber(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);
}

function percent(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
    style: "percent",
  }).format(value);
}

function changeFrom(value: number | null, base: number | null) {
  return value != null && base != null && base !== 0 ? (value - base) / base : null;
}

function findPeriod(rows: Row[] | undefined, period: string) {
  return rows?.find((row) => String(row.period ?? "") === period) ?? null;
}

function periodLabel(value: unknown, zh: boolean) {
  const period = String(value ?? "—");
  const labels: Record<string, [string, string]> = {
    "+1q": ["下季度", "Next quarter"],
    "+1y": ["下一财年", "Next year"],
    "0q": ["本季度", "Current quarter"],
    "0y": ["本财年", "Current year"],
  };
  return labels[period]?.[zh ? 0 : 1] ?? period;
}

function ratingPeriodLabel(value: unknown, zh: boolean) {
  const period = String(value ?? "—");
  const monthsAgo = /^-(\d+)m$/.exec(period);
  if (period === "0m") return zh ? "本月" : "Current";
  if (monthsAgo) return zh ? `${monthsAgo[1]} 月前` : `${monthsAgo[1]}m ago`;
  return period;
}

function actionLabel(value: unknown, zh: boolean) {
  const action = String(value ?? "—");
  const labels: Record<string, [string, string]> = {
    announces: ["公布", "Announces"],
    down: ["下调", "Down"],
    lowers: ["下调", "Lowers"],
    maintains: ["维持", "Maintains"],
    reiterates: ["重申", "Reiterates"],
    resumes: ["恢复覆盖", "Resumes"],
    up: ["上调", "Up"],
    raises: ["上调", "Raises"],
  };
  return labels[action.toLowerCase()]?.[zh ? 0 : 1] ?? action;
}

function consensusScore(row: RatingPeriod | undefined) {
  if (!row) return null;
  const count = row.strongBuy + row.buy + row.hold + row.sell + row.strongSell;
  if (!count) return null;
  return (row.strongBuy * 5 + row.buy * 4 + row.hold * 3 + row.sell * 2 + row.strongSell) / count;
}

function consensusLabel(score: number | null, zh: boolean) {
  if (score == null) return zh ? "暂无共识" : "No consensus";
  if (score >= 4.5) return zh ? "强烈买入" : "Strong buy";
  if (score >= 3.5) return zh ? "买入" : "Buy";
  if (score >= 2.5) return zh ? "持有" : "Hold";
  if (score >= 1.5) return zh ? "卖出" : "Sell";
  return zh ? "强烈卖出" : "Strong sell";
}

function ratingTone(value: unknown): "green" | "yellow" | "red" | "gray" {
  const grade = String(value ?? "").toLowerCase();
  if (grade.includes("buy") || grade.includes("outperform") || grade.includes("overweight")) return "green";
  if (grade.includes("sell") || grade.includes("underperform") || grade.includes("underweight")) return "red";
  if (grade.includes("hold") || grade.includes("neutral") || grade.includes("equal")) return "yellow";
  return "gray";
}

export function AnalystView({
  analyst,
  currency = "USD",
  priceHistory = [],
  referencePrice,
}: {
  analyst: Record<string, unknown>;
  currency?: string;
  priceHistory?: PriceSeriesPoint[];
  referencePrice?: number | null;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const payload = analyst as AnalystPayload;
  const targets = payload.priceTargets ?? {};
  const current = referencePrice ?? num(targets.current);
  const ratings: RatingPeriod[] = [...(payload.recommendations ?? [])]
    .slice(0, 12)
    .reverse()
    .map((row) => ({
      buy: num(row.buy) ?? 0,
      hold: num(row.hold) ?? 0,
      period: ratingPeriodLabel(row.period, zh),
      sell: num(row.sell) ?? 0,
      strongBuy: num(row.strongBuy) ?? 0,
      strongSell: num(row.strongSell) ?? 0,
    }));
  const latestRating = ratings.at(-1);
  const latestRatingCount = latestRating
    ? latestRating.strongBuy + latestRating.buy + latestRating.hold + latestRating.sell + latestRating.strongSell
    : 0;
  const score = consensusScore(latestRating);
  const scoreLabel = consensusLabel(score, zh);
  const meanTarget = num(targets.mean);
  const lowTarget = num(targets.low);
  const medianTarget = num(targets.median);
  const highTarget = num(targets.high);
  const meanChange = changeFrom(meanTarget, current);
  const revenueThisYear = findPeriod(payload.revenueEstimate, "0y");
  const revenueNextYear = findPeriod(payload.revenueEstimate, "+1y");
  const epsThisYear = findPeriod(payload.earningsEstimate, "0y");
  const epsNextYear = findPeriod(payload.earningsEstimate, "+1y");
  const forecastMetrics: ForecastMetric[] = [
    { key: "revenue-0y", kind: "currency", label: zh ? "本财年营收" : "Revenue this year", row: revenueThisYear },
    { key: "revenue-1y", kind: "currency", label: zh ? "下一财年营收" : "Revenue next year", row: revenueNextYear },
    { key: "eps-0y", kind: "number", label: zh ? "本财年 EPS" : "EPS this year", row: epsThisYear },
    { key: "eps-1y", kind: "number", label: zh ? "下一财年 EPS" : "EPS next year", row: epsNextYear },
  ];
  const revenueBars: EstimateBar[] = [
    { high: num(revenueThisYear?.high), label: zh ? "本财年" : "Current FY", low: num(revenueThisYear?.low), value: num(revenueThisYear?.avg) },
    { high: num(revenueNextYear?.high), label: zh ? "下一财年" : "Next FY", low: num(revenueNextYear?.low), value: num(revenueNextYear?.avg) },
  ];
  const epsBars: EstimateBar[] = [
    { high: num(epsThisYear?.high), label: zh ? "本财年" : "Current FY", low: num(epsThisYear?.low), value: num(epsThisYear?.avg) },
    { high: num(epsNextYear?.high), label: zh ? "下一财年" : "Next FY", low: num(epsNextYear?.low), value: num(epsNextYear?.avg) },
  ];
  const actions = payload.upgradesDowngrades ?? [];
  const revisions = payload.epsRevisions ?? [];
  const history = payload.earningsHistory ?? [];

  if (!Object.keys(targets).length && !ratings.length && !revenueBars.some((row) => row.value != null) && !actions.length) {
    return <Alert color="gray" title={zh ? "暂无分析师数据" : "No analyst data"} />;
  }

  return (
    <Stack gap="xl">
      <Card style={sectionStyle}>
        <Grid align="stretch">
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Box
              h="100%"
              py="sm"
              pr={{ base: 0, lg: "xl" }}
              style={{ display: "flex", flexDirection: "column" }}
            >
              <SectionHeading
                accessory={latestRatingCount ? (
                  <Badge color="gray" variant="light">
                    {zh ? `${latestRatingCount} 项评级` : `${latestRatingCount} ratings`}
                  </Badge>
                ) : undefined}
                help={{
                  content: zh ? "共识由当前各档评级数量加权得出。" : "Consensus is weighted from the current rating counts.",
                  label: zh ? "当前共识口径" : "About current consensus",
                }}
                size="h3"
                title={zh ? "当前共识" : "Current consensus"}
              />
              <Stack gap="lg" justify="center" style={{ flex: 1 }}>
                <Group gap={7} justify="center" wrap="wrap">
                  <Text fw={800} size="xl">{zh ? "目标价：" : "Price target:"}</Text>
                  <Text fw={850} size="xl">{money(meanTarget, currency)}</Text>
                  <Text c={meanChange == null ? "dimmed" : meanChange >= 0 ? "green" : "red"} fw={850} size="xl">（{percent(meanChange)}）</Text>
                </Group>
                <ConsensusGaugeChart breakdown={latestRating} count={latestRatingCount} label={scoreLabel} score={score} />
                <Group gap={6} justify="center">
                  <Text fw={700}>{zh ? "分析师共识" : "Analyst consensus"}:</Text>
                  <Text c={score != null && score >= 3.5 ? "green" : score != null && score < 2.5 ? "red" : undefined} fw={800}>{scoreLabel}</Text>
                </Group>
              </Stack>
            </Box>
          </Grid.Col>
          <Grid.Col pos="relative" span={{ base: 12, lg: 8 }}>
            <Divider hiddenFrom="lg" mb="lg" />
            <Divider
              orientation="vertical"
              visibleFrom="lg"
              style={{ bottom: 0, height: "100%", left: 0, position: "absolute", top: 0 }}
            />
            <Box h="100%" py="sm" pl={{ base: 0, lg: "xl" }}>
              <SectionHeading
                accessory={<Badge color="blue" variant="light">{zh ? "约 12 个月" : "Approx. 12 months"}</Badge>}
                help={{
                  content: zh
                    ? "历史部分只使用过去 12 个月真实价格。虚线把当前价连接到约 12 个月目标价快照，仅表示目标区间，不代表逐月预测或统一到期日。"
                    : "The history uses only actual prices from the past 12 months. Dashed lines connect the current price to the approximate 12-month target snapshot; they are not month-by-month forecasts or a shared expiry date.",
                  label: zh ? "目标价口径" : "About price targets",
                }}
                size="h3"
                title={zh ? "目标价" : "Price targets"}
              />
              <PriceTargetChart currency={currency} high={highTarget} history={priceHistory} low={lowTarget} mean={meanTarget} spot={current} />
              <TargetSummaryTable
                currency={currency}
                current={current}
                high={highTarget}
                low={lowTarget}
                mean={meanTarget}
                median={medianTarget}
                zh={zh}
              />
            </Box>
          </Grid.Col>
        </Grid>
      </Card>

      <Card style={sectionStyle}>
        <SectionHeading accessory={<Text c="dimmed" size="sm">{zh ? "近 12 期" : "Last 12 periods"}</Text>} size="h3" title={zh ? "评级趋势" : "Rating trend"} />
        <RatingTrendChart rows={ratings} />
      </Card>

      <Card style={sectionStyle}>
        <SectionHeading accessory={<Text c="dimmed" size="sm">{actions.length}</Text>} size="h3" title={zh ? "近期机构行动" : "Recent firm actions"} />
        <AnalystActions actions={actions.slice(0, 12)} currency={currency} current={current} zh={zh} />
      </Card>

      <Card style={sectionStyle}>
        <SectionHeading
          accessory={<Badge color="gray" variant="light">{zh ? "本财年 / 下一财年" : "Current / next FY"}</Badge>}
          help={{
            content: zh ? "图表同时展示分析师平均预期与低—高区间。增长率沿用数据源口径，分析师覆盖数量可能因指标而不同。" : "Charts show the analyst mean and low–high range. Growth follows the source definition and analyst coverage may differ by metric.",
            label: zh ? "财务预测口径" : "About financial forecasts",
          }}
          size="h3"
          title={zh ? "财务预测" : "Financial forecasts"}
        />
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing={0}>
          {forecastMetrics.map((metric) => {
            const value = num(metric.row?.avg);
            return (
              <Box key={metric.key} p="md" style={{ borderTop: "1px solid var(--tm-border)" }}>
                <Text c="dimmed" fw={600} size="sm">{metric.label}</Text>
                <Text style={forecastValueStyle}>{metric.kind === "currency" ? compactCurrency(value, currency) : compactNumber(value)}</Text>
                <DirectionalValue compact value={num(metric.row?.growth)} />
              </Box>
            );
          })}
        </SimpleGrid>
        <Grid mt="md" pt="lg" style={{ borderTop: "1px solid var(--tm-border)" }}>
          <Grid.Col span={{ base: 12, lg: 6 }}>
            <Text fw={750}>{zh ? "营收预期" : "Revenue estimates"}</Text>
            <EstimateChart ariaLabel={zh ? "营收预期及低高区间" : "Revenue estimates and low-high range"} compactValue={(value) => compactCurrency(value, currency)} rows={revenueBars} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 6 }}>
            <Text fw={750}>{zh ? "EPS 预期" : "EPS estimates"}</Text>
            <EstimateChart ariaLabel={zh ? "EPS 预期及低高区间" : "EPS estimates and low-high range"} compactValue={compactNumber} rows={epsBars} />
          </Grid.Col>
        </Grid>
        <ForecastTable currency={currency} metrics={forecastMetrics} zh={zh} />
      </Card>

      <Grid>
        <Grid.Col span={{ base: 12, xl: 6 }}>
          <Card h="100%" style={sectionStyle}>
            <SectionHeading accessory={<Text c="dimmed" size="sm">{revisions.length}</Text>} size="h3" title={zh ? "EPS 修正" : "EPS revisions"} />
            <ResponsiveTable
              columns={[zh ? "周期" : "Period", zh ? "当前 EPS" : "Current EPS", zh ? "7 日上调" : "Up 7d", zh ? "30 日上调" : "Up 30d", zh ? "30 日下调" : "Down 30d"]}
              rows={revisions.slice(0, 8).map((row) => [periodLabel(row.period, zh), num(row.current)?.toFixed(3) ?? "—", String(num(row.upLast7days) ?? "—"), String(num(row.upLast30days) ?? "—"), String(num(row.downLast30days) ?? "—")])}
              title={zh ? "EPS 修正" : "EPS revisions"}
            />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, xl: 6 }}>
          <Card h="100%" style={sectionStyle}>
            <SectionHeading accessory={<Text c="dimmed" size="sm">{history.length}</Text>} size="h3" title={zh ? "财报惊喜" : "Earnings surprises"} />
            <ResponsiveTable
              columns={[zh ? "季度" : "Quarter", zh ? "预期" : "Estimate", zh ? "实际" : "Actual", zh ? "惊喜" : "Surprise"]}
              rows={history.slice(0, 8).map((row) => [String(row.quarter ?? "—").slice(0, 10), num(row.epsEstimate)?.toFixed(3) ?? "—", num(row.epsActual)?.toFixed(3) ?? "—", percent(num(row.surprisePercent))])}
              title={zh ? "财报惊喜" : "Earnings surprises"}
            />
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function SectionHeading({ accessory, help, size, title }: {
  accessory?: React.ReactNode;
  help?: { content: string; label: string; title?: string };
  size?: "h3";
  title: string;
}) {
  return (
    <Group justify="space-between" style={sectionHeaderStyle} wrap="nowrap">
      <Group gap={6} wrap="nowrap">
        <Title order={2} size={size}>{title}</Title>
        {help ? <ContextHelp {...help} /> : null}
      </Group>
      {accessory}
    </Group>
  );
}

function DirectionalValue({ compact = false, value }: { compact?: boolean; value: number | null }) {
  return <Text c={value == null ? "dimmed" : value >= 0 ? "green" : "red"} fw={750} mb={compact ? 0 : 5} size={compact ? "sm" : "lg"}>{percent(value)}</Text>;
}

function TargetSummaryTable({
  currency,
  current,
  high,
  low,
  mean,
  median,
  zh,
}: {
  currency: string;
  current: number | null;
  high: number | null;
  low: number | null;
  mean: number | null;
  median: number | null;
  zh: boolean;
}) {
  const values = [
    [zh ? "低位" : "Low", low],
    [zh ? "均值" : "Mean", mean],
    [zh ? "中位数" : "Median", median],
    [zh ? "高位" : "High", high],
  ] as const;
  return (
    <ScrollArea mt="md" viewportProps={{ "aria-label": zh ? "分析师目标价明细" : "Analyst price target details", tabIndex: 0 }}>
      <Table horizontalSpacing="md" miw={620} verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{zh ? "目标" : "Target"}</Table.Th>
            {values.map(([label]) => <Table.Th key={label} ta="right">{label}</Table.Th>)}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Th>{zh ? "价格" : "Price"}</Table.Th>
            {values.map(([label, value]) => <Table.Td fw={700} key={label} ta="right">{money(value, currency)}</Table.Td>)}
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{zh ? "变化" : "Change"}</Table.Th>
            {values.map(([label, value]) => {
              const change = changeFrom(value, current);
              return <Table.Td c={change == null ? "dimmed" : change >= 0 ? "green" : "red"} fw={750} key={label} ta="right">{percent(change)}</Table.Td>;
            })}
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function AnalystActions({ actions, currency, current, zh }: { actions: Row[]; currency: string; current: number | null; zh: boolean }) {
  if (!actions.length) return <Text c="dimmed">—</Text>;
  const data = actions.map((row) => {
    const target = num(row.currentPriceTarget);
    return {
      action: actionLabel(row.priceTargetAction ?? row.Action, zh),
      change: changeFrom(target, current),
      date: String(row.GradeDate ?? "").slice(0, 10) || "—",
      firm: String(row.Firm ?? "—"),
      grade: String(row.ToGrade ?? row.toGrade ?? "—"),
      target,
    };
  });
  return (
    <>
      <ScrollArea className="tm-research-table-desktop" viewportProps={{ "aria-label": zh ? "近期机构行动表" : "Recent firm actions table", tabIndex: 0 }}>
        <Table highlightOnHover miw={820}>
          <Table.Thead><Table.Tr>{[zh ? "日期" : "Date", zh ? "机构" : "Firm", zh ? "评级" : "Rating", zh ? "动作" : "Action", zh ? "目标价" : "Target", zh ? "相对现价" : "Upside"].map((label, index) => <Table.Th key={label} ta={index >= 4 ? "right" : undefined}>{label}</Table.Th>)}</Table.Tr></Table.Thead>
          <Table.Tbody>{data.map((row, index) => <Table.Tr key={`${row.date}-${row.firm}-${index}`}><Table.Td>{row.date}</Table.Td><Table.Td fw={700}>{row.firm}</Table.Td><Table.Td><Badge color={ratingTone(row.grade)} variant="light">{row.grade}</Badge></Table.Td><Table.Td>{row.action}</Table.Td><Table.Td fw={700} ta="right">{money(row.target, currency, 0)}</Table.Td><Table.Td c={row.change == null ? "dimmed" : row.change >= 0 ? "green" : "red"} fw={750} ta="right">{percent(row.change)}</Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </ScrollArea>
      <Stack className="tm-research-table-mobile" gap="xs">
        {data.map((row, index) => <Box key={`${row.date}-${row.firm}-${index}`} style={mobileRowStyle}><Group justify="space-between" wrap="nowrap"><div><Text fw={750}>{row.firm}</Text><Text c="dimmed" size="xs">{row.date}</Text></div><Badge color={ratingTone(row.grade)} variant="light">{row.grade}</Badge></Group><SimpleGrid cols={3} mt="sm" spacing="xs"><CompactDatum label={zh ? "动作" : "Action"} value={row.action} /><CompactDatum label={zh ? "目标价" : "Target"} value={money(row.target, currency, 0)} /><CompactDatum label={zh ? "相对现价" : "Upside"} value={percent(row.change)} /></SimpleGrid></Box>)}
      </Stack>
    </>
  );
}

function ForecastTable({ currency, metrics, zh }: { currency: string; metrics: ForecastMetric[]; zh: boolean }) {
  const rows = metrics.map((metric) => {
    const formatter = metric.kind === "currency" ? (value: number | null) => compactCurrency(value, currency) : compactNumber;
    return [metric.label, formatter(num(metric.row?.avg)), `${formatter(num(metric.row?.low))} – ${formatter(num(metric.row?.high))}`, percent(num(metric.row?.growth)), String(num(metric.row?.numberOfAnalysts) ?? "—")];
  });
  return <ResponsiveTable columns={[zh ? "指标" : "Metric", zh ? "均值" : "Mean", zh ? "低—高" : "Low–high", zh ? "增长" : "Growth", zh ? "分析师" : "Analysts"]} rows={rows} title={zh ? "财务预测明细" : "Financial forecast details"} />;
}

function ResponsiveTable({ columns, rows, title }: { columns: string[]; rows: string[][]; title: string }) {
  if (!rows.length) return <Text c="dimmed">—</Text>;
  return (
    <>
      <ScrollArea className="tm-research-table-desktop" viewportProps={{ "aria-label": `${title} table`, tabIndex: 0 }}><Table highlightOnHover miw={560}><Table.Thead><Table.Tr>{columns.map((column) => <Table.Th key={column}>{column}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{rows.map((row, index) => <Table.Tr key={`${row[0]}-${index}`}>{row.map((value, cell) => <Table.Td fw={cell === 0 ? 700 : undefined} key={`${index}-${cell}`}>{value}</Table.Td>)}</Table.Tr>)}</Table.Tbody></Table></ScrollArea>
      <Stack className="tm-research-table-mobile" gap="xs">{rows.map((row, index) => <Box key={`${row[0]}-${index}`} style={mobileRowStyle}><SimpleGrid cols={2} spacing="xs">{row.map((value, cell) => <CompactDatum key={`${index}-${cell}`} label={columns[cell]} value={value} />)}</SimpleGrid></Box>)}</Stack>
    </>
  );
}

function CompactDatum({ label, value }: { label: string; value: string }) {
  return <div><Text c="dimmed" size="xs">{label}</Text><Text fw={700} size="sm">{value}</Text></div>;
}
