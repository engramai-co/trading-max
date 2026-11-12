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

export const INDEX_RANGES: IndexRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y"];

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
    && (a.currency === b.currency || gbp) && (period !== "1D" || a.scope === b.scope)
    && !!a.symbol && !!b.symbol && (period === "1D" || (a.historyYears > 0 && b.historyYears > 0));
}

/** Both histories start at the same observed instant; missing bars stay missing. */
export function alignIndices(first: IndexPoint[], second: IndexPoint[], gaps: string[] = []) {
  const left = new Map(first.map(({ at, value }) => [at, value]));
  const right = new Map(second.map(({ at, value }) => [at, value]));
  const times = [...new Set([...left.keys(), ...right.keys(), ...gaps])].sort();
  const start = times.find((at) => (left.get(at) ?? 0) > 0 && (right.get(at) ?? 0) > 0);
  if (!start) return [];
  const a = left.get(start)!;
  const b = right.get(start)!;
  return times.filter((at) => at >= start).map((at) => ({
    at,
    left: left.has(at) ? left.get(at)! * 100 / a : null,
    right: right.has(at) ? right.get(at)! * 100 / b : null,
  }));
}
