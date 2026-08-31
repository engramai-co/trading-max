import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { AnalyticsPageView } from "@/components/pages/analytics-page-view";
import { prefetchDashboardLens } from "@/lib/dashboard-server";
import { createServerQueryClient } from "@/lib/query-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Performance & risk" };

export default async function AnalyticsPage() {
  const queryClient = createServerQueryClient();
  await prefetchDashboardLens(queryClient, "analytics");
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AnalyticsPageView />
    </HydrationBoundary>
  );
}
