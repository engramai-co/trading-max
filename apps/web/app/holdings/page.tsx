import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { HoldingsPageView } from "@/components/pages/holdings-page-view";
import { prefetchDashboardLens } from "@/lib/dashboard-server";
import { createServerQueryClient } from "@/lib/query-server";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Holdings" };

export default async function HoldingsPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; q?: string; view?: string }>;
}) {
  const params = await searchParams;
  const initialAccount =
    params.account === "A" || params.account === "B"
      ? params.account
      : "all";
  const view = params.view === "lookthrough" ? "lookthrough" : "positions";
  const queryClient = createServerQueryClient();
  await Promise.all([
    prefetchDashboardLens(queryClient, "holdings-positions"),
    view === "lookthrough"
      ? prefetchDashboardLens(queryClient, "holdings-lookthrough")
      : Promise.resolve(null),
  ]);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HoldingsPageView
        initialAccount={initialAccount}
        initialQuery={params.q ?? ""}
        view={view}
      />
    </HydrationBoundary>
  );
}
