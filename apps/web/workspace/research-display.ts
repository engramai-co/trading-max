import { numeric } from "@/lib/numeric";
import { object, percent, str, type Json } from "@/workspace/data";

/** The solver returns sentinel values outside its search bounds, not estimates. */
export function impliedGrowthLabel(value: unknown, bound: unknown) {
  if (bound === "above-80%") return "> 80%";
  if (bound === "below--30%") return "< −30%";
  return percent(value);
}

/** Keep quarter and fiscal-year estimates separate; they are different durations. */
export function estimateGroups(rows: Json[]) {
  const groups = [
    { key: "quarter", periods: ["0q", "+1q"] },
    { key: "year", periods: ["0y", "+1y"] },
  ];
  return [
    ...groups.map((group) => ({
      key: group.key,
      rows: group.periods.flatMap((period) =>
        rows.filter((row) => str(row.period ?? row.index) === period),
      ),
    })),
    {
      key: "other",
      rows: rows.filter(
        (row) =>
          !groups.some((g) => g.periods.includes(str(row.period ?? row.index))),
      ),
    },
  ].filter((group) => group.rows.length);
}

/** Pair by source index before dropping missing observations. Never shift a price to another input. */
export function sensitivityPoints(source: unknown, base: unknown) {
  const row = object(source);
  const anchor = numeric(base);
  if (
    anchor == null ||
    !Array.isArray(row.deltas) ||
    !Array.isArray(row.values)
  )
    return [];
  const values = row.values;
  return row.deltas
    .flatMap((delta, i) => {
      const change = numeric(delta),
        value = numeric(values[i]);
      return change == null || value == null
        ? []
        : [{ input: anchor + change, delta: change, value }];
    })
    .sort((a, b) => a.input - b.input);
}

export const statementOrder: Record<string, string[]> = {
  incomeStatement: [
    "Total Revenue",
    "Operating Revenue",
    "Cost Of Revenue",
    "Gross Profit",
    "Operating Expense",
    "Selling General And Administration",
    "Research And Development",
    "Operating Income",
    "Interest Expense",
    "Pretax Income",
    "Tax Provision",
    "Net Income",
    "Basic EPS",
    "Diluted EPS",
    "Basic Average Shares",
    "Diluted Average Shares",
    "EBITDA",
    "EBIT",
  ],
  balanceSheet: [
    "Total Assets",
    "Current Assets",
    "Cash Cash Equivalents And Short Term Investments",
    "Cash And Cash Equivalents",
    "Receivables",
    "Inventory",
    "Total Non Current Assets",
    "Net PPE",
    "Goodwill And Other Intangible Assets",
    "Total Liabilities Net Minority Interest",
    "Current Liabilities",
    "Current Debt",
    "Total Non Current Liabilities Net Minority Interest",
    "Long Term Debt",
    "Stockholders Equity",
    "Total Debt",
    "Net Debt",
    "Working Capital",
  ],
  cashflow: [
    "Operating Cash Flow",
    "Net Income From Continuing Operations",
    "Depreciation And Amortization",
    "Stock Based Compensation",
    "Change In Working Capital",
    "Investing Cash Flow",
    "Capital Expenditure",
    "Purchase Of Investment",
    "Sale Of Investment",
    "Financing Cash Flow",
    "Common Stock Dividend Paid",
    "Repurchase Of Capital Stock",
    "Net Issuance Payments Of Debt",
    "Changes In Cash",
    "Beginning Cash Position",
    "End Cash Position",
    "Free Cash Flow",
  ],
};

export function orderedStatement(rows: Json[], statement: string) {
  const order = statementOrder[statement] ?? [];
  const name = (row: Json) => str(row.index ?? row.name);
  const rank = (row: Json) => {
    const i = order.indexOf(name(row));
    return i < 0 ? order.length : i;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

export function relativeToPrice(price: unknown, reference: unknown) {
  const p = numeric(price),
    r = numeric(reference);
  return p == null || r == null || r <= 0 ? null : p / r - 1;
}
