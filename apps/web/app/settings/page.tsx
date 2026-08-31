import type { Metadata } from "next";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { SettingsPageView } from "@/components/pages/settings-page-view";
import { healthDetailsQueryKey } from "@/lib/health-query";
import { loadHealthDetails } from "@/lib/health-server";
import { createServerQueryClient } from "@/lib/query-server";
import { settingsBundleQueryKey } from "@/lib/settings-query";
import { loadSettingsBundle } from "@/lib/settings-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings & connections" };

export default async function SettingsPage() {
  const queryClient = createServerQueryClient();
  const [settings, health] = await Promise.all([
    loadSettingsBundle().catch(() => null),
    loadHealthDetails(),
  ]);
  if (settings) queryClient.setQueryData(settingsBundleQueryKey, settings);
  queryClient.setQueryData(healthDetailsQueryKey, health);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SettingsPageView />
    </HydrationBoundary>
  );
}
