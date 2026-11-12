import { useQuery } from "@tanstack/react-query";
import type { components } from "@/lib/api-schema";
import { api } from "@/workspace/data";
import { useDemonstration } from "./demonstration";

export type IndexIdentity = components["schemas"]["IndexIdentity"];
export type IndexScope = IndexIdentity["scope"];
export type IndexQuote = components["schemas"]["IndexQuote"];
export type IndexMarket = components["schemas"]["IndexMarket"];
export type IndexHistory = components["schemas"]["IndexHistory"];
export type IndexContext = components["schemas"]["IndexContext"];
export type IndexContribution = components["schemas"]["IndexContribution"];
export type IndexPoint = components["schemas"]["IndexPoint"];
export type IndexRange = IndexHistory["range"];

export const INDEX_MARKETS: readonly IndexScope[] = [
  "global", "us", "eu", "uk", "jp", "hk", "kr", "tw", "in", "au", "ch", "ca",
];

export function indexMarket(value: string | null): IndexScope | null {
  return INDEX_MARKETS.find((market) => market === value) ?? null;
}

export const INDEX_RANGES: IndexRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"];

export function indexHref(index: Pick<IndexIdentity, "scope" | "id">) {
  return `/sectors?market=${index.scope}&index=${index.id}`;
}

function key(value: string) {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}^]/gu, "");
}

export function useIndexCatalog(enabled = true) {
  const demonstration = useDemonstration();
  return useQuery({
    queryKey: ["index-catalog"],
    queryFn: ({ signal }) => api<IndexIdentity[]>("/indices/catalog", { signal }),
    enabled: enabled && !demonstration,
    staleTime: 30 * 60_000,
    retry: 0,
  });
}

export function matchIndices(indices: IndexIdentity[] | undefined, query: string) {
  const value = key(query);
  if (value.length < 2) return [];
  return (indices ?? [])
    .map((index) => {
      const candidates = [index.name, index.nameZh, index.symbol ?? "", ...index.aliases].map(key);
      const rank = candidates.some((name) => name === value) ? 2
        : candidates.some((name) => name.includes(value)) ? 1 : 0;
      return { index, rank };
    })
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 5)
    .map(({ index }) => index);
}

export function comparable(a: IndexIdentity, b: IndexIdentity, gbp: boolean, period: IndexRange) {
  return a.id !== b.id && a.kind === b.kind && a.kind !== "volatility" && a.basis === b.basis
    && (a.currency === b.currency || gbp) && a.ranges.includes(period) && b.ranges.includes(period);
}

type HistorySeries = Pick<IndexHistory, "points" | "gaps">;

function comparisonSlot(at: string, period: IndexRange) {
  const time = Date.parse(at);
  if (period === "MAX") {
    // Yahoo weekly bars can end on different weekdays. Compare the observed
    // closes in the same calendar week without inventing a price for either.
    const weekEnd = new Date(time);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + (7 - weekEnd.getUTCDay()) % 7);
    return weekEnd.toISOString();
  }
  const interval = ({ "1D": 5, "1W": 30, "1M": 60 } as Partial<Record<IndexRange, number>>)[period];
  if (interval) return new Date(Math.floor(time / (interval * 60_000)) * interval * 60_000).toISOString();
  return new Date(time).toISOString();
}

function observations({ points, gaps }: HistorySeries, slot: (at: string) => string) {
  const rows = new Map<string, number | null>((gaps ?? []).map((at) => [slot(at), null]));
  for (const { at, value } of points ?? []) rows.set(slot(at), value);
  return rows;
}

export function indexHistoryRows(history: HistorySeries) {
  return [...observations(history, (at) => at)].sort(([a], [b]) => a.localeCompare(b))
    .map(([at, left]) => ({ at, left, right: undefined }));
}

/** Use the first shared slot as the base. Only known gaps break a stroke. */
export function alignIndices(first: HistorySeries, second: HistorySeries, period: IndexRange) {
  const slot = (at: string) => comparisonSlot(at, period);
  const left = observations(first, slot);
  const right = observations(second, slot);
  const times = [...new Set([...left.keys(), ...right.keys()])].sort();
  const start = times.find((at) => (left.get(at) ?? 0) > 0 && (right.get(at) ?? 0) > 0);
  if (!start) return [];
  const a = left.get(start)!;
  const b = right.get(start)!;
  const rebase = (value: number | null | undefined, base: number) => value == null ? value : value * 100 / base;
  return times.filter((at) => at >= start).map((at) => ({
    at,
    left: rebase(left.get(at), a),
    right: rebase(right.get(at), b),
  }));
}
