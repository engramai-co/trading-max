"use client";

import { useQuery } from "@tanstack/react-query";
import { portfolioHistoryKey } from "@/lib/dashboard-query";
import { decodeTimeline, type HistorySelection, type PreparedHistory } from "@/lib/portfolio/prepared";

export async function fetchHistory<T>(
  selection: HistorySelection, signal: AbortSignal, page?: number, openings: readonly string[] = [], retained = false,
): Promise<T> {
  const params = new URLSearchParams(selection);
  if (retained) params.set("retained","1");
  if (page != null) params.set("page", String(page));
  for (const opening of openings) params.append("opening", opening);
  const response = await fetch(`/api/backend/dashboard/history?${params}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`History returned ${response.status}`);
  return response.json() as Promise<T>;
}

/** Openings name the attributions a "what moved" strip explains; the answer carries their exact P&L. */
export function usePortfolioHistory(selection: HistorySelection, enabled = true, openings: readonly string[] = [], retained = false) {
  return useQuery({
    queryKey: retained ? [...portfolioHistoryKey(selection, openings), "retained"] : portfolioHistoryKey(selection, openings), enabled,
    queryFn: ({ signal }) => fetchHistory<PreparedHistory>(selection, signal, undefined, openings, retained),
    select: (data) => ({ ...data, history: { ...data.history, timeline: decodeTimeline(data.history.timeline) } }),
    retry: 1, staleTime: retained ? 0 : Infinity, gcTime: 120_000,
  });
}
