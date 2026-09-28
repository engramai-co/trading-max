"use client";

import { ArrowRight, ArrowSquareOut, CloudCheck, GearSix, Pulse, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { HealthDetails } from "@/lib/types";
import { api } from "./data";
import { auxiliaryPage } from "./desktop-routing";
import { activityState } from "./desktop-status";
import { Freshness, useCopy } from "./foundation";
import Link from "./link";
import { useWorkspaceProfile } from "./profile";

export function useActivity() {
  return useQuery({ queryKey: ["workspace-health"], queryFn: () => api<HealthDetails>("/health/details"), refetchInterval: 15_000, retry: 1 });
}

export function DesktopStatus() {
  const t = useCopy();
  const query = useActivity();
  const state = activityState(query.data ?? null);
  const label = query.isError ? t("同步状态不可用", "Sync status unavailable") : query.isPending ? t("正在检查更新", "Checking updates")
    : state.tone === "degraded" || state.tone === "unavailable" ? t("有更新需要检查", "Updates need attention")
    : state.running ? t("正在同步", "Syncing") : t("同步与活动", "Sync & activity");
  const Warning = query.isError || state.tone === "degraded" || state.tone === "unavailable";
  return <div className="mx-desktop-tools">
    <Link href="/health" className={"mx-desktop-status" + (Warning ? " mx-desktop-warning" : "")}>
      {Warning ? <WarningCircle size={19} /> : state.running ? <Pulse size={19} /> : <CloudCheck size={19} />}
      <span><strong>{label}</strong><small>{query.data?.health?.queue.last_success_at ? <Freshness date={query.data.health.queue.last_success_at} label={t("最近成功", "Last success")} /> : t("查看进度与更新记录", "Progress and update history")}</small></span>
      <ArrowSquareOut size={14} />
    </Link>
    <div className="mx-desktop-utilities">
      <Link href="/imports"><UploadSimple size={17} />{t("导入", "Import")}</Link>
      <Link href="/settings"><GearSix size={17} />{t("工作区设置", "Workspace settings")}</Link>
    </div>
  </div>;
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
