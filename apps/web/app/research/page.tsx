import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { ResearchPageView } from "@/components/pages/research-page-view";
import type { ResearchView } from "@/components/research/research-lens";
import { mockResearchShell } from "@/lib/mock-research";
import { createServerQueryClient } from "@/lib/query-server";
import {
  loadResearchLens,
  loadResearchPrices,
  loadResearchShell,
} from "@/lib/research";
import {
  researchLensQueryKey,
  researchPricesQueryKey,
} from "@/lib/research-query";
import {
  researchDataRunId,
  researchWorkIsPending,
} from "@/lib/watchlist";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Research workbench" };

const validViews = new Set<ResearchView>([
  "overview",
  "technical",
  "valuation",
  "fundamentals",
  "analyst",
  "options",
  "ledger",
]);

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string; ticker?: string; view?: string }>;
}) {
  const params = await searchParams;
  const mock = process.env.NODE_ENV !== "production" && params.mock === "research-v2";
  const ticker = (params.ticker ?? "BE").toUpperCase();
  const requestedView = (
    params.view === "financials" ? "fundamentals" : params.view
  ) as ResearchView | undefined;
  const view = requestedView && validViews.has(requestedView) ? requestedView : "overview";
  const needsPrices = view === "overview" || view === "technical" || view === "analyst";
  const shellPromise = mock ? Promise.resolve(mockResearchShell) : loadResearchShell();
  const requestedLensPromise = mock
    ? Promise.resolve(null)
    : loadResearchLens(ticker, view).catch(() => null);
  const requestedPricesPromise = !mock && needsPrices
    ? loadResearchPrices(ticker).catch(() => null)
    : Promise.resolve(null);
  const [shell, requestedLens, requestedPrices] = await Promise.all([
    shellPromise,
    requestedLensPromise,
    requestedPricesPromise,
  ]);
  const initialTicker = shell.instruments.some((item) => item.ticker === ticker)
    ? ticker
    : shell.instruments.find((item) => item.held)?.ticker
      ?? shell.instruments[0]?.ticker
      ?? ticker;
  const instrument = shell.instruments.find((item) => item.ticker === initialTicker);
  const canLoadInitialData = Boolean(
    instrument && !researchWorkIsPending(instrument) && instrument.status !== "failed",
  );
  const fallbackData = !mock && canLoadInitialData && initialTicker !== ticker
    ? await Promise.all([
        loadResearchLens(initialTicker, view).catch(() => null),
        needsPrices ? loadResearchPrices(initialTicker).catch(() => null) : Promise.resolve(null),
      ])
    : [null, null] as const;
  const initialLens = initialTicker === ticker ? requestedLens : fallbackData[0];
  const initialPrices = initialTicker === ticker ? requestedPrices : fallbackData[1];
  const queryClient = createServerQueryClient();
  const runId = researchDataRunId(instrument, shell.status.runId);
  if (canLoadInitialData && initialLens) {
    queryClient.setQueryData(
      researchLensQueryKey(runId, initialTicker, view, false),
      initialLens,
    );
  }
  if (canLoadInitialData && initialPrices) {
    queryClient.setQueryData(
      researchPricesQueryKey(runId, initialTicker, false),
      initialPrices,
    );
  }
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ResearchPageView
        mock={mock}
        shell={shell}
        ticker={ticker}
        view={view}
      />
    </HydrationBoundary>
  );
}
