import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { OverviewWorkspace } from "@/workspace/overview";
import { HoldingsWorkspace } from "@/workspace/holdings";
import { PerformanceWorkspace } from "@/workspace/performance";
import { ResearchWorkspace } from "@/workspace/research";
import { ReviewWorkspace } from "@/workspace/review";
import { SectorsWorkspace } from "@/workspace/sectors";
import { SettingsWorkspace } from "@/workspace/settings";
import { HealthWorkspace } from "@/workspace/health";
import { ImportsWorkspace } from "@/workspace/imports";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ page?: string[] }> }): Promise<Metadata> {
  const { page } = await params;
  return page?.[0] === "sectors" ? { title: "Markets" } : {};
}

export default async function DesktopPage({ params, searchParams }: { params: Promise<{ page?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { page = [] } = await params;
  const search = await searchParams;
  const scope = typeof search.scope === "string" ? search.scope : undefined;
  const localWorkspace = Boolean(process.env.TRADING_MAX_DESKTOP_WORKSPACE_ID);
  if (page.length > 1) notFound();
  if (page[0] === "account-analysis") {
    // An account's review is the review in that account's scope; earlier links keep working.
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) query.append(key, item);
    }
    if (!query.has("account")) query.set("account", "A");
    if (query.get("reviewView") === "decisions") query.delete("reviewView");
    redirect("/desktop/review?" + query.toString());
  }
  const content = {
    "": <OverviewWorkspace localWorkspace={localWorkspace} />,
    holdings: <HoldingsWorkspace />,
    analytics: <PerformanceWorkspace />,
    sectors: <SectorsWorkspace />,
    research: <ResearchWorkspace />,
    review: <ReviewWorkspace />,
    settings: <SettingsWorkspace localWorkspace={localWorkspace} desktop />,
    activity: <HealthWorkspace localWorkspace={localWorkspace} desktop initialScope={scope === "cfd" ? "cfd" : "all"} readOnly={process.env.TRADING_MAX_ENV === "desktop-preview"} />,
    imports: <ImportsWorkspace demonstration={process.env.TRADING_MAX_ENV === "desktop-preview"} />,
  }[page[0] ?? ""];
  if (!content) notFound();
  return content;
}
