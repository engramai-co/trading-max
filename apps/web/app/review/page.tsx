import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { ReviewPageView } from "@/components/pages/review-page-view";
import { prefetchDashboardLens } from "@/lib/dashboard-server";
import { createServerQueryClient } from "@/lib/query-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account review" };

export default async function ReviewPage() {
  const queryClient = createServerQueryClient();
  await prefetchDashboardLens(queryClient, "review");
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ReviewPageView />
    </HydrationBoundary>
  );
}
