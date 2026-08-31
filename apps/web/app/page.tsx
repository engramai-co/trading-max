import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { OverviewPageView } from "@/components/pages/overview-page-view";
import { prefetchDashboardLens } from "@/lib/dashboard-server";
import { createServerQueryClient } from "@/lib/query-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "Portfolio overview · Trading Max" },
};

export default async function OverviewPage() {
  const queryClient = createServerQueryClient();
  await prefetchDashboardLens(queryClient, "overview");
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <OverviewPageView />
    </HydrationBoundary>
  );
}
