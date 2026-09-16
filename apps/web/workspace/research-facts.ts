import type { components } from "@/lib/api-schema";

export type FinancialFacts = components["schemas"]["FinancialFacts"];
export type FinancialPeriod = components["schemas"]["FinancialPeriod"];
export type Observation = components["schemas"]["MetricObservation"];
export type Preview = components["schemas"]["ValuationPreview"];
export type ScenarioInput = components["schemas"]["ScenarioInputs"];

export const metricNames: Record<string, [string, string]> = {
  revenue: ["营业收入", "Revenue"],
  costOfRevenue: ["销售成本", "Cost of revenue"],
  grossProfit: ["毛利润", "Gross profit"],
  operatingExpense: ["经营费用", "Operating expenses"],
  operatingIncome: ["营业利润", "Operating income"],
  pretaxIncome: ["税前利润", "Pretax income"],
  tax: ["所得税", "Income tax"],
  netIncome: ["净利润", "Net income"],
  eps: ["摊薄每股盈利", "Diluted EPS"],
  operatingCashflow: ["经营现金流", "Operating cash flow"],
  capex: ["资本开支", "Capital expenditure"],
  freeCashflow: ["自由现金流", "Free cash flow"],
  cash: ["现金及短期投资", "Cash & investments"],
  debt: ["总债务", "Total debt"],
  equity: ["股东权益", "Shareholders’ equity"],
  tangibleEquity: ["有形净资产", "Net tangible assets"],
  assets: ["总资产", "Total assets"],
  buybacks: ["股票回购", "Share repurchases"],
  dividends: ["已付股息", "Dividends paid"],
  shareCount: ["期末股数", "Period-end shares"],
  dilutedShares: ["摊薄平均股数", "Diluted weighted shares"],
  grossMargin: ["毛利率", "Gross margin"],
  operatingMargin: ["营业利润率", "Operating margin"],
  netMargin: ["净利率", "Net margin"],
  fcfMargin: ["现金流率", "FCF margin"],
  revenueGrowth: ["营收同比", "Revenue YoY"],
  netIncomeGrowth: ["盈利同比", "Earnings YoY"],
  epsGrowth: ["每股盈利同比", "EPS YoY"],
  freeCashflowGrowth: ["现金流同比", "FCF YoY"],
  roe: ["净资产收益率", "Return on equity"],
  roa: ["总资产收益率", "Return on assets"],
};

export function factIndex(facts: FinancialFacts) {
  const index = new Map<string, Observation>();
  for (const value of facts.observations ?? [])
    index.set(`${value.periodId}/${value.metric}`, value);
  return (period: string, metric: string) => index.get(`${period}/${metric}`);
}

export function factPeriods(facts: FinancialFacts, kind: string) {
  return (facts.periods ?? [])
    .filter((p) => p.kind === kind)
    .sort((a, b) => a.providerEnd.localeCompare(b.providerEnd));
}

export function incomeBridge(
  value: (metric: string) => number | null | undefined,
) {
  const revenue = value("revenue"),
    gross = value("grossProfit"),
    operating = value("operatingIncome"),
    net = value("netIncome");
  if (
    [revenue, gross, operating, net].some(
      (n) => n == null || !Number.isFinite(n),
    )
  )
    return [];
  return [
    { metric: "revenue", from: 0, to: revenue!, total: true },
    { metric: "costOfRevenue", from: revenue!, to: gross!, total: false },
    { metric: "grossProfit", from: 0, to: gross!, total: true },
    { metric: "operatingExpense", from: gross!, to: operating!, total: false },
    { metric: "operatingIncome", from: 0, to: operating!, total: true },
    { metric: "taxAndOther", from: operating!, to: net!, total: false },
    { metric: "netIncome", from: 0, to: net!, total: true },
  ];
}
