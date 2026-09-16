import type { NavPoint } from "@/lib/types";
export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
export const objects = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(object) : [];
export const numeric = (value: unknown): number | null =>
  (typeof value !== "number" && typeof value !== "string") ||
  (typeof value === "string" && value.trim() === "")
    ? null
    : Number.isFinite(Number(value))
      ? Number(value) || 0
      : null;
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
export const compact = (value: unknown) =>
  numeric(value)?.toLocaleString("en-GB", {
    notation: "compact",
    maximumFractionDigits: 1,
  }) ?? "—";
export const tone = (value: unknown) =>
  numeric(value) == null
    ? undefined
    : Number(value) < 0
      ? ("down" as const)
      : ("up" as const);
export type Range =
  | "1D"
  | "1W"
  | "1M"
  | "3M"
  | "6M"
  | "YTD"
  | "1Y"
  | "2Y"
  | "ALL";
export type Scope = "total" | "invest" | "isa" | "household" | "cfd";
export function inRange<T extends { date: string }>(
  data: T[],
  range: Range,
): T[] {
  const sorted = [...data]
    .filter((p) => Number.isFinite(Date.parse(p.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (range === "ALL" || sorted.length === 0) return sorted;
  if (range === "1D")
    return sorted.filter(
      (p) =>
        p.date.slice(0, 10) === sorted[sorted.length - 1].date.slice(0, 10),
    );
  const latest = Date.parse(sorted[sorted.length - 1].date);
  if (range === "YTD") {
    const year = new Date(latest).getUTCFullYear();
    return sorted.filter((p) => Date.parse(p.date) >= Date.UTC(year, 0, 1));
  }
  const days =
    range === "1W"
      ? 7
      : range === "1M"
        ? 30
        : range === "3M"
          ? 90
          : range === "6M"
            ? 183
            : range === "2Y"
              ? 730
              : 365;
  return sorted.filter((p) => latest - Date.parse(p.date) <= days * 86400000);
}
export function navNumber(
  point: NavPoint | undefined,
  scope: Scope,
  metric = "",
): number | null {
  return point ? numeric(point[(scope + metric) as keyof NavPoint]) : null;
}
/** Trim only empty boundaries; missing observations inside the range stay visible. */
export function observedNav(data: NavPoint[], scope: Scope, metric = "") {
  const rows = data.filter((point) => !point.intraday);
  const first = rows.findIndex((point) => navNumber(point, scope, metric) != null);
  const last = rows.findLastIndex((point) => navNumber(point, scope, metric) != null);
  return first < 0 ? [] : rows.slice(first, last + 1);
}
export function periodReturn(start: unknown, end: unknown): number | null {
  const a = numeric(start),
    b = numeric(end);
  return a == null || b == null || a <= -1 ? null : (1 + b) / (1 + a) - 1;
}
export function difference(start: unknown, end: unknown) {
  const a = numeric(start),
    b = numeric(end);
  return a == null || b == null ? null : b - a;
}
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
