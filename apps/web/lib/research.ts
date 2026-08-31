import "server-only";

import { backendFetch, backendUrl } from "@/lib/backend";
import type {
  ResearchLensSnapshot,
  ResearchOverview,
  ResearchPriceSeries,
  ResearchShell,
} from "@/lib/types";

function ensureBackend() {
  if (!backendUrl()) {
    throw new Error(
      "Trading Max API is not configured; set PORTFOLIO_BACKEND_URL for server-side data access.",
    );
  }
}

export async function loadResearchShell(): Promise<ResearchShell> {
  ensureBackend();
  const response = await backendFetch("/v1/research/shell");
  if (!response.ok) {
    throw new Error("Trading Max research shell API returned " + response.status);
  }
  return (await response.json()) as ResearchShell;
}

export async function loadResearchOverview(
  ticker?: string,
): Promise<ResearchOverview> {
  ensureBackend();

  const query = new URLSearchParams({ limit: "30" });
  if (ticker) query.set("ticker", ticker);
  const response = await backendFetch("/v1/research?" + query.toString());
  if (!response.ok) {
    throw new Error("Trading Max research API returned " + response.status);
  }
  const payload = (await response.json()) as ResearchOverview;
  return {
    ...payload,
    alerts: payload.alerts ?? [],
    watchlistCategories: payload.watchlistCategories ?? [],
  };
}

export async function loadResearchLens(
  ticker: string,
  view: string,
): Promise<ResearchLensSnapshot> {
  ensureBackend();
  const response = await backendFetch(
    `/v1/research/${encodeURIComponent(ticker)}/lens/${encodeURIComponent(view)}?limit=30`,
  );
  if (!response.ok) {
    throw new Error(`Trading Max research lens API returned ${response.status}`);
  }
  return (await response.json()) as ResearchLensSnapshot;
}

export async function loadResearchPrices(
  ticker: string,
): Promise<ResearchPriceSeries> {
  ensureBackend();
  const response = await backendFetch(
    `/v1/research/${encodeURIComponent(ticker)}/prices?limit=504`,
  );
  if (!response.ok) {
    throw new Error(`Trading Max research prices API returned ${response.status}`);
  }
  return (await response.json()) as ResearchPriceSeries;
}
