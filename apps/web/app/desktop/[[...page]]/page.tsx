import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Pending } from "@/workspace/foundation";
import { OverviewWorkspace } from "@/workspace/overview";
import { HoldingsWorkspace } from "@/workspace/holdings";
import { PerformanceWorkspace } from "@/workspace/performance";
import { ResearchWorkspace } from "@/workspace/research";
import { ReviewWorkspace, AccountReviewWorkspace } from "@/workspace/review";
import { SettingsWorkspace } from "@/workspace/settings";
import { HealthWorkspace } from "@/workspace/health";
import { ImportsWorkspace } from "@/workspace/imports";

export const dynamic = "force-dynamic";
export default async function DesktopPage({ params, searchParams }: { params: Promise<{ page?: string[] }>; searchParams: Promise<{ scope?: string }> }) {
  const { page = [] } = await params;
  const { scope } = await searchParams;
  const localWorkspace = Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID);
  if (page.length > 1) notFound();
  const content = {
    "": <OverviewWorkspace localWorkspace={localWorkspace} />,
    holdings: <HoldingsWorkspace />,
    analytics: <PerformanceWorkspace />,
    research: <ResearchWorkspace />,
    review: <ReviewWorkspace />,
    "account-analysis": <AccountReviewWorkspace />,
    settings: <SettingsWorkspace localWorkspace={localWorkspace} desktop />,
    activity: <HealthWorkspace localWorkspace={localWorkspace} desktop initialScope={scope === "cfd" ? "cfd" : "all"} readOnly={process.env.TRADING_MAX_ENV === "desktop-preview"} />,
    imports: <ImportsWorkspace demonstration={process.env.TRADING_MAX_ENV === "desktop-preview"} />,
  }[page[0] ?? ""];
  if (!content) notFound();
  return <Suspense fallback={<Pending />}>{content}</Suspense>;
}
