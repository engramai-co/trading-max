import type { Locale } from "@/components/locale-provider";
import { numeric } from "@/lib/numeric";
import { compact } from "@/workspace/data";
import type { Reading, ReadingItem, ReadingTone } from "./chart-readout";

/** The typographic minus used by readings and axes. */
export const MINUS = "\u2212";

const fixedFormats = new Map<number, Intl.NumberFormat>();
/** A figure with a fixed number of decimals, grouped in the en-GB style both locales use for numbers. */
export function fixed(value: unknown, digits = 2) {
  const n = numeric(value);
  if (n == null) return "—";
  let format = fixedFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    fixedFormats.set(digits, format);
  }
  const text = format.format(Math.abs(n));
  return (n < 0 && Number(text.replace(/,/g, "")) !== 0 ? MINUS : "") + text;
}

/** Up when the figure rounds above zero at the shown precision, down below it; zero has no tone. */
export function readingTone(value: unknown, digits = 2): ReadingTone | undefined {
  const n = numeric(value);
  if (n == null) return undefined;
  const rounded = Number(n.toFixed(digits));
  return rounded > 0 ? "up" : rounded < 0 ? "down" : undefined;
}

function signed(text: string, tone: ReadingTone | undefined) {
  return tone === "up" ? "+" + text : text;
}

/** Pounds with the typographic minus: £1,234.56, −£954.53. */
export function pounds(value: unknown, digits = 2) {
  const n = numeric(value);
  if (n == null) return "—";
  const text = "£" + fixed(Math.abs(n), digits);
  return readingTone(n, digits) === "down" ? MINUS + text : text;
}

/** A signed pound result: +£20,873.83, −£954.53 and £0.00. */
export function signedPounds(value: unknown, digits = 2) {
  return signed(pounds(value, digits), readingTone(value, digits));
}

/** A signed fraction as a percentage: +9.62%, −0.44%, 0.00%. */
export function signedPercent(value: unknown, digits = 2) {
  const n = numeric(value);
  if (n == null) return "—";
  return signed(fixed(n * 100, digits) + "%", readingTone(n * 100, digits));
}

/** An unsigned fraction as a percentage, keeping the minus for negatives: 15.57%, −2.83%. */
export function plainPercent(value: unknown, digits = 2) {
  const n = numeric(value);
  return n == null ? "—" : fixed(n * 100, digits) + "%";
}

/** A difference in percentage points: +1.20 pp, −5.17 pp. */
export function signedPoints(fraction: unknown, digits = 2) {
  const n = numeric(fraction);
  if (n == null) return "—";
  return signed(fixed(n * 100, digits) + " pp", readingTone(n * 100, digits));
}

/** A signed plain number: +0.13, −0.005. */
export function signedNumber(value: unknown, digits = 2) {
  return signed(fixed(value, digits), readingTone(value, digits));
}

/** Share volume in the volume axis's units: 3440万 or 34.4m. */
export function volume(value: unknown, locale: Locale) {
  return compact(value, locale);
}

/** Decimals that tell nearby values apart: two, or three when they differ only in the third place. */
export function telling(values: Array<number | null | undefined>, base = 2) {
  const shown = values.filter((value): value is number => value != null && Number.isFinite(value));
  const distinct = (digits: number) => new Set(shown.map((value) => value.toFixed(digits))).size;
  return shown.length > 1 && distinct(base) < distinct(base + 1) ? base + 1 : base;
}

/**
 * A comparison reading: the leading series, each comparison keyed to its stroke, then the
 * difference in percentage points. `change` is each line's move as a fraction of its start.
 */
export function comparisonFigures(
  lines: Array<{ item: ReadingItem; change: number | null | undefined }>,
  difference?: string,
): Pick<Reading, "primary" | "groups"> {
  const shown = lines.filter((line) => line.change != null);
  const [lead, ...others] = shown;
  if (!lead) return {};
  const gap = difference && lines.length === 2 && shown.length === 2 ? lead.change! - others[0].change! : null;
  const rows: ReadingItem[] = [
    ...others.map((line) => line.item),
    ...(gap == null ? [] : [{ label: difference!, value: signedPoints(gap), tone: readingTone(gap * 100) }]),
  ];
  return { primary: lead.item, ...(rows.length ? { groups: [rows] } : {}) };
}

