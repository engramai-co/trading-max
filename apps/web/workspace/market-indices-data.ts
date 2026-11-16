import { useLocalStorage } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@/lib/api-schema";
import { readApi } from "@/workspace/data";

export type IndexIdentity = components["schemas"]["IndexIdentity"];
export type IndexScope = IndexIdentity["scope"];
export type IndexQuote = components["schemas"]["IndexQuote"];
export type IndexMarket = components["schemas"]["IndexMarket"];
export type IndexHistory = components["schemas"]["IndexHistory"];
export type IndexResearch = components["schemas"]["IndexResearch"];
export type IndexComposition = components["schemas"]["IndexComposition"];
export type IndexConstituent = components["schemas"]["IndexConstituent"];
export type IndexProduct = components["schemas"]["IndexProduct"];
export type IndexContext = components["schemas"]["IndexContext"];
export type IndexContribution = components["schemas"]["IndexContribution"];
export type IndexPoint = components["schemas"]["IndexPoint"];
export type IndexRange = IndexHistory["range"];

export const INDEX_MARKETS: readonly IndexScope[] = [
  "global", "us", "eu", "uk", "jp", "hk", "cn", "kr", "tw", "in", "au", "ch", "ca",
];

export function indexMarket(value: string | null): IndexScope | null {
  return INDEX_MARKETS.find((market) => market === value) ?? null;
}

export const INDEX_RANGES: IndexRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"];

export function indexHref(index: Pick<IndexIdentity, "scope" | "id">) {
  return `/sectors?market=${index.scope}&index=${index.id}`;
}

export function researchIndexHref(index: Pick<IndexIdentity, "id">, view?: "overview" | "price" | "constituents" | "tracking") {
  return `/research?type=index&index=${index.id}${view && view !== "overview" ? `&view=${view}` : ""}`;
}

const starter = ["nasdaq-100", "sp-500", "msci-world-ex-usa", "msci-usa-momentum", "msci-em",
  "marketvector-semiconductor-screened", "msci-semiconductors-screened", "msci-world", "msci-acwi", "ftse-100", "nikkei-225"];

export const savedIndexKey = "trading_max-research-indexes";

/**
 * Indices in the research list. Stocks and funds live in the service's list;
 * indices stay in this browser's storage under the key they have always used.
 */
export function useListedIndices() {
  const [ids, setIds] = useLocalStorage<string[]>({ key: savedIndexKey, defaultValue: [] });
  return {
    ids,
    has: (id: string) => ids.includes(id),
    add: (id: string) => setIds((items) => (items.includes(id) ? items : [...items, id])),
    remove: (id: string) => setIds((items) => items.filter((item) => item !== id)),
  };
}

export function indexDirectory(indices: IndexIdentity[] | undefined, saved: readonly string[] = []) {
  return [...(indices ?? [])].sort((a, b) => {
    const rank = (item: IndexIdentity) => { const i = starter.indexOf(item.id); return i < 0 ? starter.length : i; };
    return Number(saved.includes(b.id)) - Number(saved.includes(a.id)) || rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

function key(value: string) {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}^]/gu, "");
}

export function useIndexCatalog(enabled = true) {
  return useQuery({
    queryKey: ["index-catalog"],
    queryFn: ({ signal }) => readApi<IndexIdentity[]>("/indices/catalog", signal),
    enabled,
    staleTime: 30 * 60_000,
    retry: 0,
  });
}

export function matchIndices(indices: IndexIdentity[] | undefined, query: string) {
  const value = key(query);
  if (value.length < 2) return [];
  return indexDirectory(indices)
    .map((index) => {
      const candidates = [index.name, index.nameZh, index.symbol ?? "", ...index.aliases].map(key);
      const rank = candidates.some((name) => name === value) ? 2
        : candidates.some((name) => name.includes(value)) ? 1 : 0;
      return { index, rank };
    })
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map(({ index }) => index);
}

export function comparable(a: IndexIdentity, b: IndexIdentity, gbp: boolean, period: IndexRange) {
  return a.id !== b.id && a.kind === b.kind && a.kind !== "volatility" && a.basis === b.basis
    && (a.currency === b.currency || gbp) && a.ranges.includes(period) && b.ranges.includes(period);
}

type HistorySeries = Pick<IndexHistory, "points" | "gaps">;

const alignedCache = new WeakMap<HistorySeries, WeakMap<HistorySeries, Map<IndexRange, ReturnType<typeof alignHistory>>>>();
const timelineCache = new WeakMap<HistorySeries, Array<{ at: string; left: number | null; right: undefined }>>();

function canonicalUtc(at: string) {
  if (at.endsWith("Z")) {
    if (at.length === 24) return at;
    if (at.length === 20) return at.slice(0, -1) + ".000Z";
  }
  return new Date(at).toISOString();
}

function comparisonSlot(at: string, period: IndexRange) {
  if (period !== "MAX" && period !== "1D" && period !== "1W" && period !== "1M") return canonicalUtc(at);
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
  const found = timelineCache.get(history);
  if (found) return found;
  const rows = history.gaps?.length
    ? [...observations(history, (at) => at)].sort(([a], [b]) => a.localeCompare(b))
      .map(([at, left]) => ({ at, left, right: undefined }))
    : (history.points ?? []).map(({ at, value }) => ({ at, left: value, right: undefined }));
  timelineCache.set(history, rows);
  return rows;
}

/** Use the first shared slot as the base. Only known gaps break a stroke. */
export function alignIndices(first: HistorySeries, second: HistorySeries, period: IndexRange) {
  let peers = alignedCache.get(first);
  if (!peers) alignedCache.set(first, peers = new WeakMap());
  let ranges = peers.get(second);
  if (!ranges) peers.set(second, ranges = new Map());
  let rows = ranges.get(period);
  if (!rows) ranges.set(period, rows = alignHistory(first, second, period));
  return rows;
}

function alignHistory(first: HistorySeries, second: HistorySeries, period: IndexRange) {
  const a = first.points, b = second.points;
  // Same-date, complete feeds are already ordered by the API. Avoid building
  // two maps and sorting tens of thousands of identical keys.
  if (a?.length && a.length === b?.length && !first.gaps?.length && !second.gaps?.length
    && !["1D", "1W", "1M", "MAX"].includes(period)
    && a[0].value > 0 && b[0].value > 0
    && a.every((point, i) => point.at === b[i].at && (i === 0 || point.at > a[i - 1].at))) {
    return a.map((point, i) => ({
      at: canonicalUtc(point.at),
      left: point.value * 100 / a[0].value,
      right: b[i].value * 100 / b[0].value,
    }));
  }
  const slot = (at: string) => comparisonSlot(at, period);
  const left = observations(first, slot);
  const right = observations(second, slot);
  const times = [...new Set([...left.keys(), ...right.keys()])].sort();
  const start = times.find((at) => (left.get(at) ?? 0) > 0 && (right.get(at) ?? 0) > 0);
  if (!start) return [];
  const leftBase = left.get(start)!;
  const rightBase = right.get(start)!;
  const rebase = (value: number | null | undefined, base: number) => value == null ? value : value * 100 / base;
  return times.filter((at) => at >= start).map((at) => ({
    at,
    left: rebase(left.get(at), leftBase),
    right: rebase(right.get(at), rightBase),
  }));
}
