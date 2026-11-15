import { researchLensKey } from "@/lib/dashboard-query";
import type { ResearchLensSnapshot, ResearchPriceSeries } from "@/lib/types";
import { queryOptions } from "@tanstack/react-query";
import { previousForIdentity } from "./loading-state";
import { isReadTimeout, readApi } from "@/workspace/data";

export function researchLensQuery(
  ticker: string,
  view: string,
  revision?: string | null,
  detail = "full",
  preview = false,
) {
  return queryOptions({
    queryKey: preview ? [...researchLensKey(ticker, view, detail, revision), "preview"] : researchLensKey(ticker, view, detail, revision),
    queryFn: ({ signal }) => readApi<ResearchLensSnapshot>(
      `/research/${encodeURIComponent(ticker)}/lens/${view}?limit=30&detail=${detail}${preview ? "&preview=true" : ""}${revision ? "&revision=" + encodeURIComponent(revision) : ""}`,
      signal,
    ),
    staleTime: 60_000,
    retry: (count, error) => count < 1 && !isReadTimeout(error),
    // A refresh can retain this security's view; navigation must never borrow
    // another company's numbers or another lens's partial fields.
    placeholderData: (previous, query) =>
      query?.queryKey[2] === view && query?.queryKey[3] === detail
        ? previousForIdentity(previous, previous?.ticker, ticker) : undefined,
  });
}

export function researchPriceQuery(
  ticker: string,
  revision?: string | null,
  interval = "1d",
  window?: string,
) {
  return queryOptions({
    queryKey: ["workspace-prices", ticker, interval, window ?? "MAX", revision],
    queryFn: ({ signal }) => readApi<ResearchPriceSeries>(
      `/research/${encodeURIComponent(ticker)}/prices?limit=2000&interval=${interval}${window ? `&window=${window}` : ""}`,
      signal,
    ),
    staleTime: 300_000,
    placeholderData: (previous, query) => previousForIdentity(previous, query?.queryKey[1], ticker),
    retry: (count, error) => count < 1 && !isReadTimeout(error),
  });
}
