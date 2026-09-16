import type { Json } from "./data";
import { currency, number, numeric, percent } from "./data";
import type { FinancialFacts } from "./research-facts";

export type StatementUnit = "money" | "shares" | "ratio" | "per-share";
// Yahoo statement fields are amounts unless their schema explicitly says otherwise.
// Substring matching confuses Operation/Administration with "ratio".
const statementUnits: Record<string, StatementUnit> = {
  "tax rate for calcs": "ratio",
  "basic eps": "per-share",
  "diluted eps": "per-share",
  "normalized diluted eps": "per-share",
  "basic average shares": "shares",
  "diluted average shares": "shares",
  "ordinary shares number": "shares",
  "share issued": "shares",
  "treasury shares number": "shares",
};
export function statementUnit(name: string): StatementUnit {
  return (
    statementUnits[name.trim().toLowerCase().replace(/\s+/g, " ")] ?? "money"
  );
}
export function statementValue(
  value: unknown,
  name: string,
  millions: boolean,
) {
  if (numeric(value) == null) return "—";
  const unit = statementUnit(name);
  if (unit === "ratio") return percent(value, false, 1);
  if (unit === "per-share") return number(value, 2);
  return number(Number(value) / (millions ? 1_000_000 : 1), millions ? 1 : 0);
}

/** Unknown quote currencies must never acquire an assumed dollar symbol. */
export function quoteValue(
  value: unknown,
  code: unknown,
  unknownLabel: string,
) {
  if (numeric(value) == null) return "—";
  return typeof code === "string" && code.trim()
    ? currency(value, code, 2)
    : number(value, 2) + " · " + unknownLabel;
}

/** TTM uses four known fiscal quarters; balances are a point-in-time stock. */
export function trailingStatement(
  rows: Json[],
  statement: string,
  facts?: FinancialFacts | null,
) {
  const periods = (facts?.periods ?? []).filter((p) => p.kind === "ttm");
  const quarterEnds = new Map(
    (facts?.periods ?? []).map((p) => [p.id, p.providerEnd]),
  );
  return rows.map((row) => {
    const result: Json = { index: row.index ?? row.name };
    const name = String(row.index ?? row.name ?? "");
    for (const period of periods) {
      const components = (period.components ?? []).map((id) =>
        quarterEnds.get(id),
      );
      const keys = components.map((end) =>
        Object.keys(row).find((k) => k.slice(0, 10) === end),
      );
      const values = keys.map((key) => numeric(key ? row[key] : null));
      if (values.length !== 4 || values.some((v) => v == null)) {
        result[period.providerEnd] = null;
        continue;
      }
      if (statement === "balanceSheet" || name === "End Cash Position")
        result[period.providerEnd] = values.at(-1);
      else if (name === "Beginning Cash Position")
        result[period.providerEnd] = values[0];
      else if (statementUnit(name) === "ratio")
        result[period.providerEnd] = null;
      else
        result[period.providerEnd] =
          values.reduce<number>((sum, n) => sum + n!, 0) /
          (name.includes("Average Shares") ? 4 : 1);
    }
    return result;
  });
}
