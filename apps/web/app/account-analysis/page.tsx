import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { AccountAnalysisPageView } from "@/components/pages/account-analysis-page-view";
import { prefetchDashboardLens } from "@/lib/dashboard-server";
import { createServerQueryClient } from "@/lib/query-server";
import type { AccountCode } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account review" };

export default async function AccountAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const params = await searchParams;
  const selected: AccountCode = params.account === "B" || params.account === "C" ? params.account : "A";
  const queryClient = createServerQueryClient();
  await prefetchDashboardLens(queryClient, "account-analysis", selected);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AccountAnalysisPageView selected={selected} />
    </HydrationBoundary>
  );
}
