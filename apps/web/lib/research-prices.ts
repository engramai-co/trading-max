import type { ResearchPriceSeries } from "@/lib/types";

export async function fetchResearchPrices(
  ticker: string,
): Promise<ResearchPriceSeries> {
  const response = await fetch(
    `/api/backend/research/${encodeURIComponent(ticker)}/prices?limit=504`,
  );
  if (!response.ok) {
    throw new Error(`price history returned ${response.status}`);
  }
  return (await response.json()) as ResearchPriceSeries;
}
