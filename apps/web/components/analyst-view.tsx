"use client";

import {
  Accordion,
  Alert,
  Card,
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
  EstimateChart,
  RatingTrendChart,
  TargetFanChart,
  type RatingPeriod,
} from "@/components/analyst-charts";
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
  epsTrend?: Row[];
  epsRevisions?: Row[];
};

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compact(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2, notation: "compact" }).format(value);
}

function percent(value: number | null): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, signDisplay: "exceptZero", style: "percent" }).format(value);
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
  const targetValues = [
    [zh ? "最低" : "Low", num(targets.low)],
    [zh ? "均值" : "Mean", num(targets.mean)],
    [zh ? "中位数" : "Median", num(targets.median)],
    [zh ? "最高" : "High", num(targets.high)],
  ] as const;
  const ratings: RatingPeriod[] = [...(payload.recommendations ?? [])]
    .slice(0, 12)
    .reverse()
    .map((row) => ({
      buy: num(row.buy) ?? 0,
      hold: num(row.hold) ?? 0,
      period: String(row.period ?? "—"),
      sell: num(row.sell) ?? 0,
      strongBuy: num(row.strongBuy) ?? 0,
      strongSell: num(row.strongSell) ?? 0,
    }));
  const estimates = [
    [zh ? "今年营收" : "Revenue this year", findPeriod(payload.revenueEstimate, "0y")],
    [zh ? "明年营收" : "Revenue next year", findPeriod(payload.revenueEstimate, "+1y")],
    [zh ? "今年 EPS" : "EPS this year", findPeriod(payload.earningsEstimate, "0y")],
    [zh ? "明年 EPS" : "EPS next year", findPeriod(payload.earningsEstimate, "+1y")],
  ] as Array<[string, Row | null]>;
  const estimateBars = estimates
    .filter(([, row]) => num(row?.avg) != null)
    .map(([label, row]) => ({ high: num(row?.high), label, low: num(row?.low), value: num(row?.avg) }));
  const history = payload.earningsHistory ?? [];
  const revisions = payload.epsRevisions ?? [];
  const actions = payload.upgradesDowngrades ?? [];

  if (!Object.keys(targets).length && !ratings.length && !estimateBars.length && !actions.length) {
    return <Alert color="gray" title={zh ? "暂无分析师数据" : "No analyst data"} />;
  }

  return (
    <Stack gap="xl">
      <Card>
        <Stack gap="lg">
          <Title order={2}>{zh ? "目标价" : "Price targets"}</Title>
          <TargetFanChart
            currency={currency}
            high={num(targets.high)}
            history={priceHistory}
            low={num(targets.low)}
            mean={num(targets.mean)}
            spot={current}
          />
          <ScrollArea
            className="tm-research-table-desktop"
            viewportProps={{
              "aria-label": zh ? "分析师目标价表" : "Analyst price target table",
              tabIndex: 0,
            }}
          >
            <Table miw={620} striped withTableBorder>
              <Table.Thead>
                <Table.Tr><Table.Th>{zh ? "目标" : "Target"}</Table.Th>{targetValues.map(([label]) => <Table.Th key={label} ta="right">{label}</Table.Th>)}</Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr><Table.Th>{zh ? "价格" : "Price"}</Table.Th>{targetValues.map(([label, value]) => <Table.Td key={label} ta="right">{value == null ? "—" : new Intl.NumberFormat("en-GB", { currency, style: "currency" }).format(value)}</Table.Td>)}</Table.Tr>
                <Table.Tr><Table.Th>{zh ? "相对现价" : "Change"}</Table.Th>{targetValues.map(([label, value]) => {
                  const change = value != null && current != null && current !== 0
                    ? (value - current) / current
                    : null;
                  return <Table.Td c={change == null ? undefined : change >= 0 ? "green" : "red"} fw={700} key={label} ta="right">{percent(change)}</Table.Td>;
                })}</Table.Tr>
              </Table.Tbody>
            </Table>
          </ScrollArea>
          <SimpleGrid className="tm-research-table-mobile" cols={2}>
            {targetValues.map(([label, value]) => {
              const change = value != null && current != null && current !== 0
                ? (value - current) / current
                : null;
              return (
                <Card key={label} p="sm" withBorder>
                  <Text c="dimmed" size="xs">{label}</Text>
                  <Text fw={800}>{value == null ? "—" : new Intl.NumberFormat("en-GB", { currency, style: "currency" }).format(value)}</Text>
                  <Text c={change == null ? "dimmed" : change >= 0 ? "green" : "red"} size="sm">
                    {percent(change)}
                  </Text>
                </Card>
              );
            })}
          </SimpleGrid>
        </Stack>
      </Card>

      <Grid>
        <Grid.Col span={{ base: 12, xl: 7 }}>
          <Card h="100%">
            <Title order={2} size="h3">{zh ? "评级趋势" : "Rating trend"}</Title>
            <RatingTrendChart rows={ratings} />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, xl: 5 }}>
          <Card h="100%">
            <Stack gap="md">
              <Title order={2} size="h3">{zh ? "一致预期" : "Consensus estimates"}</Title>
              <EstimateChart compactValue={(value) => compact(value)} rows={estimateBars} />
              <SimpleGrid cols={2}>
                {estimates.map(([label, row]) => (
                  <div key={label}>
                    <Text c="dimmed" size="xs">{label}</Text>
                    <Text fw={800} size="lg">{compact(num(row?.avg))}</Text>
                    <Text c={(num(row?.growth) ?? 0) >= 0 ? "green" : "red"} size="sm">{percent(num(row?.growth))}</Text>
                  </div>
                ))}
              </SimpleGrid>
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      <Accordion multiple variant="separated">
        <Accordion.Item value="revisions">
          <Accordion.Control>{zh ? "EPS 修正" : "EPS revisions"}</Accordion.Control>
          <Accordion.Panel>
            <DataTable
              columns={[zh ? "周期" : "Period", zh ? "当前 EPS" : "Current EPS", zh ? "7 日上调" : "Up 7d", zh ? "30 日上调" : "Up 30d", zh ? "30 日下调" : "Down 30d"]}
              rows={revisions.slice(0, 8).map((row) => [
                periodLabel(row.period, zh),
                num(row.current)?.toFixed(3) ?? "—",
                String(num(row.upLast7days) ?? "—"),
                String(num(row.upLast30days) ?? "—"),
                String(num(row.downLast30days) ?? "—"),
              ])}
              title={zh ? "EPS 修正" : "EPS revisions"}
            />
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="surprises">
          <Accordion.Control>{zh ? "财报惊喜" : "Earnings surprises"}</Accordion.Control>
          <Accordion.Panel>
            <DataTable
              columns={[zh ? "季度" : "Quarter", zh ? "预期" : "Estimate", zh ? "实际" : "Actual", zh ? "惊喜" : "Surprise"]}
              rows={history.slice(0, 8).map((row) => [
                String(row.quarter ?? "—").slice(0, 10),
                num(row.epsEstimate)?.toFixed(3) ?? "—",
                num(row.epsActual)?.toFixed(3) ?? "—",
                percent(num(row.surprisePercent)),
              ])}
              title={zh ? "财报惊喜" : "Earnings surprises"}
            />
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="actions">
          <Accordion.Control>{zh ? "近期机构行动" : "Recent analyst actions"}</Accordion.Control>
          <Accordion.Panel>
            <DataTable
              columns={[zh ? "日期" : "Date", zh ? "机构" : "Firm", zh ? "动作" : "Action", zh ? "目标价" : "Target"]}
              rows={actions.slice(0, 12).map((row) => [
                String(row.GradeDate ?? "").slice(0, 10),
                String(row.Firm ?? "—"),
                actionLabel(row.priceTargetAction ?? row.Action, zh),
                num(row.currentPriceTarget)?.toFixed(0) ?? "—",
              ])}
              title={zh ? "近期机构行动" : "Recent analyst actions"}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function DataTable({ columns, rows, title }: { columns: string[]; rows: string[][]; title: string }) {
  return (
    <Card>
      <Stack gap="md">
        <Group justify="space-between"><Title order={2} size="h3">{title}</Title><Text c="dimmed" size="sm">{rows.length}</Text></Group>
        {rows.length ? (
          <>
            <ScrollArea className="tm-research-table-desktop" viewportProps={{ "aria-label": `${title} table`, tabIndex: 0 }}>
              <Table highlightOnHover miw={560}>
                <Table.Thead><Table.Tr>{columns.map((column) => <Table.Th key={column}>{column}</Table.Th>)}</Table.Tr></Table.Thead>
                <Table.Tbody>{rows.map((row, index) => <Table.Tr key={`${row[0]}-${index}`}>{row.map((value, cell) => <Table.Td key={`${index}-${cell}`}>{value}</Table.Td>)}</Table.Tr>)}</Table.Tbody>
              </Table>
            </ScrollArea>
            <Stack className="tm-research-table-mobile" gap="xs">
              {rows.map((row, index) => (
                <Card key={`${row[0]}-${index}`} p="sm" withBorder>
                  <SimpleGrid cols={2} spacing="xs">
                    {row.map((value, cell) => (
                      <div key={`${index}-${cell}`}>
                        <Text c="dimmed" size="xs">{columns[cell]}</Text>
                        <Text fw={cell === 0 ? 700 : 500} size="sm">{value}</Text>
                      </div>
                    ))}
                  </SimpleGrid>
                </Card>
              ))}
            </Stack>
          </>
        ) : <Text c="dimmed">—</Text>}
      </Stack>
    </Card>
  );
}
