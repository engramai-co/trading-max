"use client";

import { Page, Notice, useCopy } from "./foundation";
import { CfdImports } from "./settings-preferences";

export function ImportsWorkspace({ demonstration = false }: { demonstration?: boolean }) {
  const t = useCopy();
  return <Page title={t("导入记录", "Import records")} description={t("选择券商导出文件，补充当前工作区的历史记录。", "Add broker exports to the current workspace’s history.")}>
    <Notice>{t("Invest 与 ISA 通过账户连接同步。这里接收 Trading 212 的 CFD 活动 CSV；文件会发送到当前服务。", "Invest and ISA sync through account connections. Import Trading 212 CFD activity CSV here; the file is sent to the selected service.")}</Notice>
    {demonstration && <Notice>{t("这是只读演示。要导入自己的记录，请先创建或打开本地工作区，或连接你的服务。", "This demonstration is read-only. Create or open a local workspace, or connect your service to import records.")}</Notice>}
    <CfdImports desktop readOnly={demonstration} />
  </Page>;
}
