import type { Json } from "@/workspace/data";
import type { Locale } from "@/components/locale-provider";
import { formatCurrency } from "@/ui/formatters";
import { compact, currency, number, percent } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { fixed } from "./reading-format";
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

/** Provider quote units are case-sensitive: GBp is pence, GBP is pounds. */
export function quoteUnit(unit: unknown) {
  const raw = typeof unit === "string" ? unit.trim() : "";
  if (["GBp", "GBX", "GBx"].includes(raw)) return { currency: "GBP", divisor: 100 };
  return { currency: /^[a-z]{3}$/i.test(raw) ? raw.toUpperCase() : "", divisor: 1 };
}

export function quoteAmount(value: unknown, unit: unknown) {
  const amount = numeric(value);
  const { currency, divisor } = quoteUnit(unit);
  return amount == null || !currency ? null : amount / divisor;
}

/** Use figures alone when the panel already names the display currency. */
export function quoteValue(
  value: unknown,
  unit: unknown,
  { style = "money", digits = 2, unknownLabel = "—", locale }: {
    style?: "money" | "figure" | "number" | "code" | "compact" | "native";
    locale?: Locale;
    digits?: number;
    unknownLabel?: string;
  } = {},
) {
  const n = numeric(value);
  if (n == null) return "—";
  const { currency: code, divisor } = quoteUnit(unit);
  if (!code) return unknownLabel;
  if (style === "native") return String(unit).trim() + " " + fixed(n, digits);
  const amount = n / divisor;
  if (style === "compact") return compact(amount, locale);
  if (style === "money") return locale ? formatCurrency(amount, locale, code, digits) : currency(amount, code, digits);
  if (style === "figure") return fixed(amount, digits);
  return number(amount, digits) + (style === "code" ? " " + code : "");
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
