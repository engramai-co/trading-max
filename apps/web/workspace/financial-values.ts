import { currency, number, numeric, percent } from "./data";

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
  return statementUnits[name.trim().toLowerCase().replace(/\s+/g, " ")] ?? "money";
}
export function statementValue(value: unknown, name: string, millions: boolean) {
  if (numeric(value) == null) return "—";
  const unit = statementUnit(name);
  if (unit === "ratio") return percent(value, false, 1);
  if (unit === "per-share") return number(value, 2);
  return number(Number(value) / (millions ? 1_000_000 : 1), millions ? 1 : 0);
}

/** Unknown quote currencies must never acquire an assumed dollar symbol. */
export function quoteValue(value: unknown, code: unknown, unknownLabel: string) {
  if (numeric(value) == null) return "—";
  return typeof code === "string" && code.trim()
    ? currency(value, code, 2)
    : number(value, 2) + " · " + unknownLabel;
}
