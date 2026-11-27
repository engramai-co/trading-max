"use client";

import { WorkspaceAlertDialog, WorkspaceDialog } from "./overlay";
import { CredentialField, useRequiredFields } from "@/components/ui/form-field";
import { useBuildNavigationGuard } from "@/ui/publication-provider";
import { Switch } from "@/components/ui/switch";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import type { IntegrationSummary } from "@/lib/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, jsonRequest } from "./data";
import { Notice, Panel, useCopy } from "./foundation";
import { settingsKey } from "./settings-query";

const indexData = {
  provider: "eodhd", name: "EODHD", keysUrl: "https://eodhd.com/",
  path: "/settings/integrations/eodhd", dailyLimit: 20,
} as const;
const mutationKey = ["settings", indexData.provider, "write"];

export function IndexMarketData({ integration }: { integration?: IntegrationSummary }) {
  const t = useCopy(), client = useQueryClient();
  const required = useRequiredFields();
  const [mode, setMode] = useState<"keys" | "remove" | null>(null);
  const [key, setKey] = useState("");
  useBuildNavigationGuard(mode !== null);
  const busy = useIsMutating({ mutationKey }) > 0;
  const commit = useMutation({
    gcTime: 0,
    mutationKey,
    mutationFn: async (action: "save" | "remove" | "enable" | "disable") => {
      if (action === "remove") return api(indexData.path, { method: "DELETE" });
      if (action !== "save") return api(indexData.path, jsonRequest("PATCH", { enabled: action === "enable" }));
      const apiKey = key.trim();
      const test = await api<{ validationToken: string }>(indexData.path + "/test", jsonRequest("POST", { apiKey }));
      return api(indexData.path, jsonRequest("PUT", {
        apiKey, validationToken: test.validationToken, enabled: integration?.enabled ?? false,
      }));
    },
    onSuccess: async () => {
      setMode(null);
      setKey("");
      await Promise.all([settingsKey, ["index-catalog"], ["index-history"]].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ));
    },
  });
  function open(value: typeof mode) {
    if (client.isMutating({ mutationKey })) return;
    commit.reset();
    setKey("");
    required.reset();
    setMode(value);
  }
  function submit(action: "save" | "remove" | "enable" | "disable") {
    if (!client.isMutating({ mutationKey })) commit.mutate(action);
  }
  const configured = integration?.configured && !integration.needsSecret;
  const error = <Notice tone="bad">{t("无法更新 EODHD 连接，请稍后重试。", "Could not update the EODHD connection. Try again.")}</Notice>;
  return <Panel title={t("指数日线", "Daily index history")}>
    <div className="mx-setting-row">
      {configured ? <Switch label={indexData.name} labelPosition="left"
        saving={commit.isPending && (commit.variables === "enable" || commit.variables === "disable")}
        disabled={busy} checked={Boolean(integration?.enabled)}
        onCheckedChange={(checked) => submit(checked ? "enable" : "disable")} />
        : <h3>{indexData.name}</h3>}
      <div className="flex flex-wrap items-center gap-mx-xs">
        <Button data-autofocus variant="secondary" disabled={busy} onClick={() => open("keys")}>
          {configured ? t("更新密钥", "Update key") : t("连接 EODHD", "Connect EODHD")}
        </Button>
        {configured && <Button variant="ghost" disabled={busy} onClick={() => open("remove")}>
          {t("删除密钥", "Remove key")}
        </Button>}
      </div>
    </div>
    <details>
      <summary>{t("覆盖范围", "Coverage")}</summary>
      <p className="mx-measure">{t(
        "提供东证指数、恒生科技、沪深 300 和 KOSPI 200 的指数日线。免费计划每天最多使用 {limit} 次，默认关闭。",
        "Provides daily TOPIX, Hang Seng TECH, CSI 300 and KOSPI 200 history. The free plan uses up to {limit} calls per day and is off by default.",
      ).replace("{limit}", String(indexData.dailyLimit))}</p>
      <a href={indexData.keysUrl} target="_blank" rel="noreferrer">{t("前往 EODHD", "Open EODHD")}</a>
    </details>
    {commit.isError && !mode && error}
    <WorkspaceDialog open={mode === "keys"} onClose={() => open(null)} preventDismiss={busy} title={t("连接 EODHD", "Connect EODHD")}>
      <form method="post" noValidate onSubmit={(event) => { event.preventDefault(); if (!busy && required.validate(event.currentTarget)) submit("save"); }}>
        <div className="flex flex-col gap-mx-md">
          <CredentialField data-autofocus label={t("API 密钥", "API key")} name="eodhd-api-key"
            revealLabel={t("显示或隐藏密钥", "Show or hide key")}
            error={required.missing(key) ? t("请输入 API 密钥。", "Enter the API key.") : undefined}
            value={key} maxLength={200} onChange={(event) => setKey(event.currentTarget.value)}
            disabled={busy} />
          {commit.isError && error}
          <Button type="submit" loading={busy} loadingLabel={t("保存中…", "Saving…")}>{t("测试并保存", "Test and save")}</Button>
        </div>
      </form>
    </WorkspaceDialog>
    <WorkspaceAlertDialog open={mode === "remove"} onClose={() => open(null)} preventDismiss={busy} title={t("删除 EODHD 密钥", "Remove EODHD key")}>
      <div className="flex flex-col gap-mx-md">
        {commit.isError && error}
        <div className="flex flex-wrap items-center gap-mx-md">
          <Button data-autofocus variant="secondary" disabled={busy} onClick={() => open(null)}>{t("取消", "Cancel")}</Button>
          <Button variant="destructive" loading={busy} loadingLabel={t("删除中…", "Removing…")} onClick={() => submit("remove")}>{t("删除密钥", "Remove key")}</Button>
        </div>
      </div>
    </WorkspaceAlertDialog>
  </Panel>;
}
