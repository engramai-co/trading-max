"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeTimeline, type HistorySelection, type PreparedHistory } from "@/lib/portfolio/prepared";

export async function fetchHistory<T>(
  selection: HistorySelection, signal: AbortSignal, page?: number, openings: readonly string[] = [],
): Promise<T> {
  const params = new URLSearchParams(selection);
  if (page != null) params.set("page", String(page));
  for (const opening of openings) params.append("opening", opening);
  const response = await fetch(`/api/backend/dashboard/history?${params}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`History returned ${response.status}`);
  return response.json() as Promise<T>;
}

/** Openings name the attributions a "what moved" strip explains; the answer carries their exact P&L. */
export function usePortfolioHistory(selection: HistorySelection, enabled = true, openings: readonly string[] = []) {
  return useQuery({
    queryKey: openings.length ? ["portfolio-history", selection, openings] : ["portfolio-history", selection], enabled,
    queryFn: ({ signal }) => fetchHistory<PreparedHistory>(selection, signal, undefined, openings),
    select: (data) => ({ ...data, history: { ...data.history, timeline: decodeTimeline(data.history.timeline) } }),
    retry: 1, staleTime: Infinity, gcTime: 120_000,
  });
}
