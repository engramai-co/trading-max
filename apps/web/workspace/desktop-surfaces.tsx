"use client";

import { ArrowRight, CloudCheck, GearSix, Info, Pulse, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { HealthDetails } from "@/lib/types";
import { api } from "./data";
import { auxiliaryPage } from "./desktop-routing";
import { activityState } from "./desktop-status";
import { useCopy } from "./foundation";
import { NavigationHint } from "./navigation-group";
import Link from "./link";
import { useWorkspaceProfile } from "./profile";

export function useActivity() {
  return useQuery({ queryKey: ["workspace-health"], queryFn: () => api<HealthDetails>("/health/details"), refetchInterval: 15_000, retry: 1 });
}

export function DesktopStatus({ localWorkspace = false }: { localWorkspace?: boolean }) {
  const t = useCopy();
  const query = useActivity();
  const state = activityState(query.data ?? null, localWorkspace);
  const label = query.isError ? t("同步状态不可用", "Sync status unavailable") : query.isPending ? t("正在检查同步状态", "Checking sync status")
    : state.tone === "degraded" || state.tone === "unavailable" ? t("同步需要检查", "Sync needs attention")
    : state.tone === "setup" ? t("等待首次同步", "Awaiting first sync")
    : state.running ? t("正在同步", "Syncing") : t("同步与活动", "Sync & activity");
  const Warning = query.isError || state.tone === "degraded" || state.tone === "unavailable";
  return <nav className="mx-desktop-tools" aria-label={t("工作台管理", "Workspace management")}>
    <NavigationHint label={label}>
      <Link href="/health" aria-label={label} className={"mx-desktop-status" + (Warning ? " mx-desktop-warning" : "")}>
        {Warning ? <WarningCircle size={24} aria-hidden="true" /> : state.tone === "setup" ? <Info size={24} aria-hidden="true" /> : state.running ? <Pulse size={24} aria-hidden="true" /> : <CloudCheck size={24} aria-hidden="true" />}
      </Link>
    </NavigationHint>
    <NavigationHint label={t("导入", "Import")}><Link href="/imports" aria-label={t("导入", "Import")}><UploadSimple size={24} aria-hidden="true" /></Link></NavigationHint>
    <NavigationHint label={t("工作区设置", "Workspace settings")}><Link href="/settings" aria-label={t("工作区设置", "Workspace settings")}><GearSix size={24} aria-hidden="true" /></Link></NavigationHint>
  </nav>;
}

export function DesktopSurface({ children, localWorkspace, demonstration }: { children: ReactNode; localWorkspace: boolean; demonstration: boolean }) {
  const t = useCopy();
  const pathname = usePathname();
  const profile = useWorkspaceProfile();
  const surface = auxiliaryPage(pathname);
  const name = profile.data?.displayName || t("当前工作区", "Current workspace");
  return <div className={"mx-desktop-surface mx-desktop-" + surface}>
    <a className="mx-skip" href="#main-content">{t("跳到正文", "Skip to content")}</a>
    <header className="mx-desktop-source">
      <div><strong>{name}</strong><span>{demonstration ? t("模拟数据 · 只读演示", "Synthetic data · Read-only demo") : localWorkspace ? t("本机工作区", "Local workspace") : t("当前服务", "Selected service")}</span></div>
      <Link href="/" className="mx-text-link">{t("回到工作台", "Back to workspace")}<ArrowRight size={16} /></Link>
    </header>
    <main id="main-content" tabIndex={-1}>{children}</main>
  </div>;
}
