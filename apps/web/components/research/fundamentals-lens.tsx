"use client";

import {
  Alert,
  Card,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Info } from "@phosphor-icons/react";

import { FinancialsView } from "@/components/financials-view";
import { useLocale } from "@/components/locale-provider";
import { normalizedFundamentalMetrics } from "@/lib/research-view";

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compact(value: number | null): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: 2,
        notation: "compact",
      }).format(value);
}

function percentage(value: number | null, directional = false): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: 1,
        signDisplay: directional ? "exceptZero" : "auto",
        style: "percent",
      }).format(value);
}

function multiple(value: number | null): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: 2,
      }).format(value);
}

export function FundamentalsLens({
  financials,
  fundamentals,
}: {
  financials: Record<string, unknown> | null | undefined;
  fundamentals: Record<string, unknown> | null | undefined;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  if (!fundamentals && !financials) {
    return (
      <Alert
        color="gray"
        icon={<Info size={18} />}
        title={zh ? "暂无可验证基本面数据" : "No verified fundamentals"}
      >
        {zh
          ? "更新该标的数据后再查看。"
          : "Update this ticker's data, then return."}
      </Alert>
    );
  }
  const metrics = normalizedFundamentalMetrics(fundamentals ?? {});
  const sections = [
    {
      title: zh ? "规模与估值" : "Scale and valuation",
      rows: [
        [zh ? "市值" : "Market cap", compact(number(metrics.marketCap))],
        [
          zh ? "企业价值" : "Enterprise value",
          compact(number(metrics.enterpriseValue)),
        ],
        ["Trailing P/E", multiple(number(metrics.trailingPE))],
        ["Forward P/E", multiple(number(metrics.forwardPE))],
        ["EV / EBITDA", multiple(number(metrics.enterpriseToEbitda))],
        ["P / S", multiple(number(metrics.priceToSalesTrailing12Months))],
      ],
    },
    {
      title: zh ? "增长与盈利" : "Growth and profitability",
      rows: [
        [zh ? "营收增长" : "Revenue growth", percentage(number(metrics.revenueGrowth), true)],
        [zh ? "盈利增长" : "Earnings growth", percentage(number(metrics.earningsGrowth), true)],
        [zh ? "毛利率" : "Gross margin", percentage(number(metrics.grossMargins))],
        [zh ? "营业利润率" : "Operating margin", percentage(number(metrics.operatingMargins))],
        [zh ? "净利率" : "Net margin", percentage(number(metrics.profitMargins))],
        ["ROE", percentage(number(metrics.returnOnEquity))],
      ],
    },
    {
      title: zh ? "现金流与资产负债" : "Cash flow and balance sheet",
      rows: [
        [zh ? "自由现金流" : "Free cash flow", compact(number(metrics.freeCashflow))],
        [
          zh ? "经营现金流" : "Operating cash flow",
          compact(number(metrics.operatingCashflow)),
        ],
        [zh ? "总债务" : "Total debt", compact(number(metrics.totalDebt))],
        [zh ? "现金" : "Cash", compact(number(metrics.totalCash))],
        [zh ? "流动比率" : "Current ratio", multiple(number(metrics.currentRatio))],
        [zh ? "债务 / 权益" : "Debt / equity", multiple(number(metrics.debtToEquity))],
      ],
    },
  ];

  return (
    <Stack gap="xl">
      {fundamentals ? (
        <Stack gap="md">
          <Title order={2}>{zh ? "基本面概览" : "Fundamentals overview"}</Title>
          <SimpleGrid cols={{ base: 1, md: 3 }}>
            {sections.map((section) => (
              <Card key={section.title}>
                <Stack gap="sm">
                  <Title order={3}>{section.title}</Title>
                  {section.rows.map(([label, value]) => (
                    <SimpleGrid cols={2} key={label}>
                      <Text c="dimmed" size="sm">{label}</Text>
                      <Text fw={700} ta="right">{value}</Text>
                    </SimpleGrid>
                  ))}
                </Stack>
              </Card>
            ))}
          </SimpleGrid>
        </Stack>
      ) : null}
      {financials ? (
        <Stack gap="md">
          <Title order={2}>{zh ? "财务趋势与报表" : "Financial trends and statements"}</Title>
          <FinancialsView financials={financials} />
        </Stack>
      ) : null}
    </Stack>
  );
}
