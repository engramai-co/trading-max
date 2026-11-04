import type { Locale } from "@/components/locale-provider";
import { numeric } from "@/lib/numeric";
export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
export const objects = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(object) : [];
export const str = (value: unknown) => (typeof value === "string" ? value : "");
export const number = (value: unknown, digits = 2) =>
  numeric(value)?.toLocaleString("en-GB", { maximumFractionDigits: digits }) ??
  "—";
export const currency = (value: unknown, code = "GBP", digits = 0) => {
  const n = numeric(value);
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code,
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(Math.abs(n) < 0.5 * 10 ** -digits ? 0 : n);
  } catch {
    return number(n, digits) + " " + code;
  }
};
export const percent = (value: unknown, signed = false, digits = 1) => {
  const n = numeric(value);
  const rounded = n == null ? null : Number((n * 100).toFixed(digits));
  return n == null
    ? "—"
    : (signed && rounded! > 0 ? "+" : "") + rounded!.toFixed(digits) + "%";
};
// Large figures in the reader's units. English keeps the en-GB short scale
// ("3.8bn", "518.3m"); Chinese counts in 万, 亿 and 万亿 to four significant
// digits ("38.12亿", "5.183亿", "1.2万"). Research passes the reader's locale;
// without one the English form is kept (overview and analytics charts).
const compactFigures: Record<Locale, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }),
  zh: new Intl.NumberFormat("zh-CN", { notation: "compact", maximumSignificantDigits: 4 }),
};
// Axis ticks are round steps, so Chinese ticks keep every digit they carry
// (up to four decimals of their unit) and close ticks never share a label.
const compactTicks: Record<Locale, Intl.NumberFormat> = {
  en: compactFigures.en,
  zh: new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 4 }),
};
export const compact = (value: unknown, locale: Locale = "en") => {
  const n = numeric(value);
  return n == null ? "—" : compactFigures[locale].format(n);
};
/** Chart axis labels; figures, tooltips and data labels use compact. */
export const compactTick = (value: unknown, locale: Locale = "en") => {
  const n = numeric(value);
  return n == null ? "—" : compactTicks[locale].format(n);
};
export const tone = (value: unknown) =>
  numeric(value) == null
    ? undefined
    : Number(value) < 0
      ? ("down" as const)
      : ("up" as const);
export type ApiValidationIssue = {
  path: string[];
  type: string;
  bounds: Partial<Record<"gt" | "ge" | "lt" | "le", number>>;
};
// Keep field locations and numeric constraints, never rejected inputs or arbitrary
// server context. Forms translate the known fields into their own labels/units.
function validationIssues(detail: unknown): ApiValidationIssue[] {
  return objects(Array.isArray(detail) ? detail : object(detail).errors)
    .filter((issue) => Array.isArray(issue.loc))
    .slice(0, 50)
    .map((issue) => ({
      path: (issue.loc as unknown[]).filter((part): part is string => typeof part === "string"),
      type: str(issue.type),
      bounds: Object.fromEntries(
        ["gt", "ge", "lt", "le"].flatMap((key) => {
          const value = object(issue.ctx)[key];
          return typeof value === "number" && Number.isFinite(value) ? [[key, value]] : [];
        }),
      ),
    }));
}
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues: ApiValidationIssue[] = [],
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/backend" + path, {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const detail = object(payload).detail;
    throw new ApiError(
      typeof detail === "string"
        ? detail
        : typeof object(detail).message === "string"
          ? String(object(detail).message)
          : "Request failed (" + response.status + ")",
      response.status,
      validationIssues(detail),
      typeof object(detail).code === "string" && /^[a-z_]{1,80}$/.test(String(object(detail).code))
        ? String(object(detail).code) : null,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
