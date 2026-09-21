"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeTimeline, type HistorySelection, type PreparedHistory } from "@/workspace/prepared-history";

export async function fetchHistory<T>(selection: HistorySelection, signal: AbortSignal, page?: number): Promise<T> {
  const params = new URLSearchParams(selection);
  if (page != null) params.set("page", String(page));
  const response = await fetch(`/api/backend/dashboard/history?${params}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`History returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function usePortfolioHistory(selection: HistorySelection, enabled = true) {
  return useQuery({
    queryKey: ["portfolio-history", selection], enabled,
    queryFn: ({ signal }) => fetchHistory<PreparedHistory>(selection, signal),
    select: (data) => ({ ...data, history: { ...data.history, timeline: decodeTimeline(data.history.timeline) } }),
    retry: 1, staleTime: Infinity, gcTime: 120_000,
  });
}
