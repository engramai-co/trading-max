import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { HealthPageView } from "@/components/pages/health-page-view";
import { healthDetailsQueryKey } from "@/lib/health-query";
import { loadHealthDetails } from "@/lib/health-server";
import { createServerQueryClient } from "@/lib/query-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "System health" };

export default async function HealthPage() {
  const queryClient = createServerQueryClient();
  queryClient.setQueryData(healthDetailsQueryKey, await loadHealthDetails());
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HealthPageView />
    </HydrationBoundary>
  );
}
