import type { NavPoint } from "@/lib/types";
import { numeric } from "@/lib/numeric";
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
