"use client";

import { Accordion, Card, ScrollArea, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { useState } from "react";

import { FinancialsChart } from "@/components/financials-chart";
import { useLocale } from "@/components/locale-provider";
import { ViewSwitch } from "@/components/view-switch";

type Row = Record<string, unknown>;
type Frame = Row[];
type MetricRow = { label: string; periods: string[]; values: Array<number | null> };

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compact(value: number | null): string {
  return value == null ? "—" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2, notation: "compact" }).format(value);
}

function growth(current: number | null, previous: number | null) {
  return current == null || previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous);
}

function metricRows(frame: Frame, labels: Array<[string, string]>): MetricRow[] {
  if (!frame.length) return [];
  const periods = Object.keys(frame[0]).filter((key) => key !== "index");
  return labels.map(([label, key]) => {
    const row = frame.find((item) => String(item.index ?? "") === key);
    return { label, periods, values: periods.map((period) => num(row?.[period])) };
  });
}

export function FinancialsView({ financials }: { financials: Record<string, unknown> }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [frequency, setFrequency] = useState<"annual" | "quarterly">("annual");
  const payload = financials as {
    incomeStatement?: Frame;
    quarterlyIncomeStatement?: Frame;
    balanceSheet?: Frame;
    quarterlyBalanceSheet?: Frame;
    cashflow?: Frame;
    quarterlyCashflow?: Frame;
  };
  const quarterly = frequency === "quarterly";
  const income = quarterly ? payload.quarterlyIncomeStatement ?? [] : payload.incomeStatement ?? [];
  const balance = quarterly ? payload.quarterlyBalanceSheet ?? [] : payload.balanceSheet ?? [];
  const cashflow = quarterly ? payload.quarterlyCashflow ?? [] : payload.cashflow ?? [];
  const incomeRows = metricRows(income, [
    [zh ? "营收" : "Revenue", "Total Revenue"],
    [zh ? "营业成本" : "Cost of revenue", "Cost Of Revenue"],
    [zh ? "毛利润" : "Gross profit", "Gross Profit"],
    [zh ? "营业费用" : "Operating expense", "Operating Expense"],
    [zh ? "营业利润" : "Operating income", "Operating Income"],
    ["EBIT", "EBIT"],
    ["EBITDA", "EBITDA"],
    [zh ? "净利润" : "Net income", "Net Income"],
    [zh ? "摊薄 EPS" : "Diluted EPS", "Diluted EPS"],
  ]);
  const balanceRows = metricRows(balance, [
    [zh ? "现金及等价物" : "Cash & equivalents", "Cash And Cash Equivalents"],
    [zh ? "总债务" : "Total debt", "Total Debt"],
    [zh ? "净债务" : "Net debt", "Net Debt"],
    [zh ? "总资产" : "Total assets", "Total Assets"],
    [zh ? "总负债" : "Total liabilities", "Total Liabilities Net Minority Interest"],
    [zh ? "股东权益" : "Equity", "Stockholders Equity"],
  ]);
  const cashRows = metricRows(cashflow, [
    [zh ? "经营现金流" : "Operating cash flow", "Operating Cash Flow"],
    [zh ? "资本支出" : "Capital expenditure", "Capital Expenditure"],
    [zh ? "自由现金流" : "Free cash flow", "Free Cash Flow"],
    [zh ? "回购" : "Buybacks", "Repurchase Of Capital Stock"],
    [zh ? "融资现金流" : "Financing cash flow", "Financing Cash Flow"],
    [zh ? "投资现金流" : "Investing cash flow", "Investing Cash Flow"],
  ]);
  const periods = incomeRows[0]?.periods ?? [];
  if (!periods.length) return <Text c="dimmed">{zh ? "暂无财务报表" : "No financial statements"}</Text>;
  const row = (name: string) => incomeRows.find((item) => item.label === name)?.values ?? [];
  const revenue = row(zh ? "营收" : "Revenue");
  const gross = row(zh ? "毛利润" : "Gross profit");
  const net = row(zh ? "净利润" : "Net income");
  const latest = periods.length - 1;

  return (
    <Stack gap="xl">
      <ViewSwitch
        data={[{ label: zh ? "年度" : "Annual", value: "annual" }, { label: zh ? "季度" : "Quarterly", value: "quarterly" }]}
        label={zh ? "财报频率" : "Statement frequency"}
        onChange={(value) => setFrequency(value as "annual" | "quarterly")}
        value={frequency}
      />
      <FinancialsChart
        compactValue={(value) => compact(value)}
        marginLabel={zh ? "净利率" : "Net margin"}
        margins={revenue.map((value, index) => value && net[index] != null ? net[index]! / value : null)}
        periods={periods.map((period) => period.slice(0, 7))}
        series={[
          { label: zh ? "营收" : "Revenue", values: revenue },
          { label: zh ? "毛利润" : "Gross profit", values: gross },
          { label: zh ? "净利润" : "Net income", values: net },
        ]}
      />
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        {[
          [zh ? "营收" : "Revenue", revenue[latest]],
          [zh ? "毛利润" : "Gross profit", gross[latest]],
          [zh ? "净利润" : "Net income", net[latest]],
          [zh ? "自由现金流" : "Free cash flow", cashRows.find((item) => item.label === (zh ? "自由现金流" : "Free cash flow"))?.values[latest] ?? null],
        ].map(([label, value]) => <Card key={String(label)}><Text c="dimmed" size="xs">{String(label)}</Text><Text fw={800} size="xl">{compact(value as number | null)}</Text></Card>)}
      </SimpleGrid>
      <Accordion defaultValue="income" variant="separated">
        <StatementTable itemValue="income" periods={periods} rows={incomeRows} title={zh ? "利润表" : "Income statement"} />
        <StatementTable itemValue="balance" periods={periods} rows={balanceRows} title={zh ? "资产负债表" : "Balance sheet"} />
        <StatementTable itemValue="cashflow" periods={periods} rows={cashRows} title={zh ? "现金流量表" : "Cash flow"} />
      </Accordion>
    </Stack>
  );
}

function StatementTable({ itemValue, periods, rows, title }: { itemValue: string; periods: string[]; rows: MetricRow[]; title: string }) {
  return (
    <Accordion.Item value={itemValue}>
      <Accordion.Control>{title}</Accordion.Control>
      <Accordion.Panel>
        <ScrollArea className="tm-research-table-desktop" viewportProps={{ "aria-label": `${title} table`, tabIndex: 0 }}>
          <Table highlightOnHover miw={760} striped>
            <Table.Thead><Table.Tr><Table.Th>{title}</Table.Th>{periods.map((period) => <Table.Th key={period} ta="right">{period.slice(0, 7)}</Table.Th>)}</Table.Tr></Table.Thead>
            <Table.Tbody>{rows.map((item) => <Table.Tr key={item.label}><Table.Th>{item.label}</Table.Th>{item.values.map((value, index) => {
              const delta = growth(value, index ? item.values[index - 1] : null);
              return <Table.Td key={`${item.label}-${periods[index]}`} ta="right"><Text fw={700}>{compact(value)}</Text>{delta == null ? null : <Text c={delta >= 0 ? "green" : "red"} size="xs">{new Intl.NumberFormat("en-GB", { signDisplay: "exceptZero", style: "percent" }).format(delta)}</Text>}</Table.Td>;
            })}</Table.Tr>)}</Table.Tbody>
          </Table>
        </ScrollArea>
        <Stack className="tm-research-table-mobile" gap="xs">
          {rows.map((item) => (
            <Card key={item.label} p="sm" withBorder>
              <Text fw={700}>{item.label}</Text>
              <SimpleGrid cols={Math.min(3, periods.length)} mt="xs" spacing="xs">
                {periods.slice(-3).map((period, offset) => {
                  const index = periods.length - Math.min(3, periods.length) + offset;
                  const value = item.values[index] ?? null;
                  const delta = growth(value, index ? item.values[index - 1] : null);
                  return (
                    <div key={`${item.label}-${period}`}>
                      <Text c="dimmed" size="xs">{period.slice(0, 7)}</Text>
                      <Text fw={700} size="sm">{compact(value)}</Text>
                      {delta == null ? null : (
                        <Text c={delta >= 0 ? "green" : "red"} size="xs">
                          {new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0, signDisplay: "exceptZero", style: "percent" }).format(delta)}
                        </Text>
                      )}
                    </div>
                  );
                })}
              </SimpleGrid>
            </Card>
          ))}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
