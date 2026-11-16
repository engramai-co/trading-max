import { MINUS } from "./reading-format";

/** Readings and axes use the minus sign (U+2212); this swaps the hyphen-minus older formatters write. */
export function minus(text: string) {
  return text.replace(/(^|[\s(+])-(?=[\d.£$€¥])/g, "$1" + MINUS).replace(/^-/, MINUS);
}

/** EPS and dividends per share keep two decimals and show a third only when it differs there. */
export function epsFigure(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return minus(value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
}

