import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OverviewWorkspace } from "@/workspace/overview";
import { HoldingsWorkspace } from "@/workspace/holdings";
import { PerformanceWorkspace } from "@/workspace/performance";
import { ResearchWorkspace } from "@/workspace/research";
import { ReviewWorkspace, AccountReviewWorkspace } from "@/workspace/review";
import { SectorsWorkspace } from "@/workspace/sectors";
import { SettingsWorkspace } from "@/workspace/settings";
import { HealthWorkspace } from "@/workspace/health";
import { ImportsWorkspace } from "@/workspace/imports";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ page?: string[] }> }): Promise<Metadata> {
  const { page } = await params;
  return page?.[0] === "sectors" ? { title: "Markets" } : {};
}

export default async function DesktopPage({ params, searchParams }: { params: Promise<{ page?: string[] }>; searchParams: Promise<{ scope?: string }> }) {
  const { page = [] } = await params;
  const { scope } = await searchParams;
  const localWorkspace = Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID);
  if (page.length > 1) notFound();
  const content = {
    "": <OverviewWorkspace localWorkspace={localWorkspace} />,
    holdings: <HoldingsWorkspace />,
    analytics: <PerformanceWorkspace />,
    sectors: <SectorsWorkspace />,
    research: <ResearchWorkspace />,
    review: <ReviewWorkspace />,
    "account-analysis": <AccountReviewWorkspace />,
    settings: <SettingsWorkspace localWorkspace={localWorkspace} desktop />,
    activity: <HealthWorkspace localWorkspace={localWorkspace} desktop initialScope={scope === "cfd" ? "cfd" : "all"} readOnly={process.env.TRADING_MAX_ENV === "desktop-preview"} />,
    imports: <ImportsWorkspace demonstration={process.env.TRADING_MAX_ENV === "desktop-preview"} />,
  }[page[0] ?? ""];
  if (!content) notFound();
  return content;
}
