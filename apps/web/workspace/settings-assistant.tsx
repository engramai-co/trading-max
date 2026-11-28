"use client";

import { WorkspaceAlertDialog, WorkspaceDialog } from "./overlay";
import { Switch } from "@/components/ui/switch";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AssistantSettings, AssistantUpdate, UserProfile } from "@/lib/types";
import { useBuildNavigationGuard } from "@/ui/publication-provider";
import { api, ApiError, jsonRequest } from "./data";
import { Notice, Panel, QueryError, QueryReadStatus, useCopy } from "./foundation";
import { workspaceProfileKey } from "./profile";
import { ASSISTANT_NAME, assistantSettingsChange, assistantSettingsKey, conversationsErasedEvent, connectedAssistantModels, DISCLOSURE_REVISION } from "./assistant-settings";
import { NativePicker } from "./picker";
import { SettingsLoading } from "./settings-loading";
import {
  settingsRetryLinkClass,
  settingsRowClass,
  settingsRowHeadingClass,
  settingsSwitchOffsetClass,
  settingsSwitchRowClass,
} from "./settings-styles";

const path = "/settings/assistant";
const actionKey = [...assistantSettingsKey, "action"];
type ModelOption = ReturnType<typeof connectedAssistantModels>[number];
type Dialog = { kind: "consent"; option: ModelOption; enable: boolean; revision: number } | { kind: "delete" };

export function AssistantPreferences({ openModels }: { openModels: () => void }) {
  const t = useCopy();
  const query = useQuery({
    queryKey: assistantSettingsKey,
    queryFn: ({ signal }) => api<AssistantSettings>(path, { signal }),
    staleTime: 0,
    retry: 1,
  });
  return <>
    <QueryReadStatus
      label={t("助手设置", "Assistant settings")}
      failed={query.isError && !query.data}
      ready={Boolean(query.data) && !query.isError}
      error={query.error}
    />
    {!query.data ? (
      query.isPending ? <SettingsLoading section="assistant" /> : <QueryError retry={query.refetch} error={query.error} />
    ) : <>
      {query.isError && <Notice tone="bad">{t("设置未能重新载入。", "Settings could not be reloaded.")}{" "}
        <button type="button" className={settingsRetryLinkClass} onClick={() => void query.refetch()}>{t("重试", "Retry")}</button>
      </Notice>}
      <AssistantControls settings={query.data} openModels={openModels} />
    </>}
  </>;
}

function AssistantControls({ settings, openModels }: { settings: AssistantSettings; openModels: () => void }) {
  const t = useCopy();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useBuildNavigationGuard(Boolean(dialog));
  const models = connectedAssistantModels(settings);
  const selected = settings.route ? models.find((option) => option.value === settings.route) : models[0];
  const consented = settings.acceptedConsentRevision === settings.consentRevision;
  const selectedConsent = Boolean(consented && selected &&
    settings.route === selected.value && settings.acceptedDestination === selected.destination);
  const canProbe = settings.enabled && selectedConsent;
  const enabled = settings.enabled && consented;
  const currentDisclosure = settings.consentRevision === DISCLOSURE_REVISION;
  const busy = useIsMutating({ mutationKey: actionKey }) > 0;
  const inFlight = () => client.isMutating({ mutationKey: actionKey }) > 0;

  const save = useMutation({
    mutationKey: actionKey,
    mutationFn: (change: AssistantUpdate) => api<AssistantSettings>(path, jsonRequest("PUT", change)),
    onSuccess: async (next) => {
      await Promise.all([assistantSettingsKey, workspaceProfileKey].map(queryKey => client.cancelQueries({queryKey, exact:true})));
      client.setQueryData(assistantSettingsKey, next);
      client.setQueryData<UserProfile>(workspaceProfileKey, previous => previous && ({
        ...previous, assistantEnabled:next.enabled && next.acceptedConsentRevision === next.consentRevision,
      }));
      try { localStorage.setItem(assistantSettingsChange, String(next.revision)); } catch { /* Restricted browser storage. */ }
      setDialog(null);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setDialog(null);
        void client.invalidateQueries({ queryKey: assistantSettingsKey, exact: true });
      }
    },
  });
  const probe = useMutation({
    mutationKey: actionKey,
    mutationFn: async (option: ModelOption) => {
      await api("/settings/llm/providers/" + option.provider + "/assistant/test", jsonRequest("POST", { model: option.model }));
    },
  });
  const erase = useMutation({
    mutationKey: actionKey,
    mutationFn: () => api<void>("/assistant/conversations", { method: "DELETE" }),
    onSuccess: () => {
      client.setQueryData(["assistant-conversations"], []);
      window.dispatchEvent(new Event(conversationsErasedEvent));
      setDialog(null);
    },
  });
  function reset() {
    save.reset();
    probe.reset();
    erase.reset();
  }
  function update(change: AssistantUpdate) {
    if (inFlight()) return;
    reset();
    save.mutate({ expectedRevision: settings.revision, ...change });
  }
  function consent(option: ModelOption, enable: boolean) {
    reset();
    setDialog({ kind: "consent", option, enable, revision: settings.revision });
  }
  const saveError = save.isError && <Notice tone="bad">{save.error instanceof ApiError && save.error.status === 409
    ? t("设置已更改。请检查最新设置后重试。", "Settings changed. Check the latest settings and try again.")
    : t("未能保存。请检查模型连接后重试。", "Could not save. Check the model connection and try again.")}</Notice>;
  const preferences = [
    { key: "backgroundBriefsEnabled", label: t("后台预写简报", "Write briefs in the background") },
    { key: "shareValuationAssumptions", label: t("分享已保存的估值假设", "Share saved valuation assumptions") },
  ] as const;
  const probeMatches = canProbe && selected && probe.variables?.value === selected.value &&
    probe.variables.destination === selected.destination;

  const closeDialog = () => { if (!inFlight()) setDialog(null); };
  return <Panel
    className="mx-assistant-settings [&>.mx-panel-heading]:flex-row [&>.mx-panel-heading]:items-center"
    title={ASSISTANT_NAME}
    action={<Switch
      className={cn("mx-assistant-enable", settingsSwitchOffsetClass)}
      aria-label={t("启用 ", "Enable ") + ASSISTANT_NAME}
      saving={save.isPending && save.variables.enabled != null}
      checked={enabled} disabled={busy || (!enabled && (!selected || !currentDisclosure))}
      onCheckedChange={() => {
        if (inFlight()) return;
        if (enabled) update({ enabled: false });
        else if (selectedConsent) update({ enabled: true });
        else if (selected) consent(selected, true);
      }}
    />}
  >
    <div className={cn(settingsRowClass, "flex-wrap items-end justify-start gap-3")}>
      {models.length ? <>
        <NativePicker label={t("模型", "Model")} value={selected?.value ?? ""} disabled={busy}
          options={[...(!selected ? [{ value: "", label: t("请选择已连接的模型", "Choose a connected model"), disabled: true }] : []), ...models.map(({ value, label }) => ({ value, label }))]}
          onChange={(event) => {
            const option = models.find((item) => item.value === event.currentTarget.value);
            if (!option || inFlight()) return;
            if (consented && settings.route?.split("/")[0] !== option.provider) consent(option, enabled);
            else update({ route: option.value });
          }} />
        <Button type="button" variant="secondary" disabled={!canProbe || busy} loading={probe.isPending} loadingLabel={t("测试中…", "Testing…")} onClick={() => {
          if (!selected || !canProbe || inFlight()) return;
          reset();
          probe.mutate(selected);
        }}>{t("测试工具调用", "Test tool calls")}</Button>
      </> : <>
        <h3 className={settingsRowHeadingClass}>{t("尚无已连接的模型", "No connected model")}</h3>
        <Button type="button" variant="secondary" onClick={openModels}>{t("连接模型", "Connect a model")}</Button>
      </>}
    </div>
    {models.length > 0 && settings.route && !selected && <Notice tone="warn">{t("已选模型不可用。请重新连接或选择其他模型。", "The selected model is unavailable. Reconnect it or choose another model.")}</Notice>}
    {!currentDisclosure && <Notice tone="warn">{t("请更新工作区以查看当前同意条款。", "Update the workspace to review the current consent terms.")}</Notice>}
    {probeMatches && probe.isSuccess && <Notice tone="good">{t("工具调用测试通过。", "Tool call succeeded.")}</Notice>}
    {probeMatches && probe.isError && <Notice tone="bad">{probe.error instanceof ApiError && probe.error.code === "assistant_tools_unsupported"
      ? t("此模型未能调用工具。请选择其他模型。", "This model could not call a tool. Choose another model.")
      : t("工具测试失败。请检查模型连接后重试。", "Tool test failed. Check the model connection and try again.")}</Notice>}
    {preferences.map(({ key, label }) => <div key={key} className={settingsRowClass}>
      <Switch className={settingsSwitchRowClass} label={label} labelPosition="left"
        saving={save.isPending && save.variables[key] != null}
        checked={settings[key]} disabled={busy || !currentDisclosure}
        onCheckedChange={(checked) => update({ [key]: checked })} />
    </div>)}
    <div className="mt-mx-md flex flex-wrap items-center gap-mx-md">
      <Button type="button" variant="secondary" disabled={busy || settings.acceptedConsentRevision === null}
        onClick={() => update({ enabled: false, acceptedConsentRevision: null })}>{t("撤回同意", "Withdraw consent")}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => { reset(); setDialog({ kind: "delete" }); }}>{t("删除对话", "Delete conversations")}</Button>
    </div>
    {!dialog && saveError}
    {erase.isSuccess && <Notice tone="good">{t("已删除此工作区中的对话。", "Conversations deleted from this workspace.")}</Notice>}
    <span role="status" className="sr-only">{save.isPending ? t("正在保存…", "Saving…") : save.isSuccess ? t("已保存", "Saved") : null}</span>
    <WorkspaceDialog open={dialog?.kind === "consent"} onClose={closeDialog} preventDismiss={busy}
      className="mx-assistant-dialog" title={t("同意向模型分享数据", "Consent to share data")}>
      {dialog?.kind === "consent" && <div className="flex flex-col gap-mx-md">
        <p className="wrap-anywhere"><strong>{dialog.option.recipient} ({dialog.option.model}){dialog.option.local && <> · {dialog.option.destination}</>}</strong>{" "}{t(
          "将收到你的消息、当前对话和工具读取的数据，包括持仓和金额。",
          "will receive your question, this conversation and the data read by tools, including holdings and amounts.",
        )}</p>
        <p>{t(
          "默认开启后台预写。数据更新后会提前生成日报、周报、财报速读和复盘习惯，每日运行次数有上限。",
          "Background writing is on by default. After data updates, it prepares daily, weekly and earnings briefs and review habits, with a daily run cap.",
        )}</p>
        <p>{t(
          "起草或讨论估值时，默认会将你保存的增长率、折现率等假设发给该提供商。你可以分别关闭假设分享和后台预写。",
          "When you draft or discuss a valuation, your saved assumptions, such as growth and discount rates, go to this provider by default. You can turn off assumption sharing and background writing separately.",
        )}</p>
        {saveError}
        <div className="flex flex-wrap items-center justify-end gap-mx-md">
          <Button type="button" data-autofocus variant="secondary" disabled={busy} onClick={() => setDialog(null)}>{t("取消", "Cancel")}</Button>
          <Button type="button" disabled={busy || !currentDisclosure} loading={save.isPending} loadingLabel={t("保存中…", "Saving…")} onClick={() => update({
            route: dialog.option.value, enabled: dialog.enable, expectedRevision: dialog.revision,
            acceptedConsentRevision: DISCLOSURE_REVISION, expectedConsentDestination: dialog.option.destination,
          })}>{dialog.enable ? t("同意并启用", "Agree and enable") : t("同意并保存", "Agree and save")}</Button>
        </div>
      </div>}
    </WorkspaceDialog>
    <WorkspaceAlertDialog open={dialog?.kind === "delete"} onClose={closeDialog} preventDismiss={busy}
      className="mx-assistant-dialog" title={t("删除所有对话？", "Delete all conversations?")}>
      {dialog?.kind === "delete" && <div className="flex flex-col gap-mx-md">
        <p>{t("此工作区保存的所有对话和消息将永久删除。", "All conversations and messages saved in this workspace will be permanently deleted.")}</p>
        {erase.isError && <Notice tone="bad">{erase.error instanceof ApiError && erase.error.code === "assistant_busy"
          ? t("请在当前回复结束后重试。", "Wait for the current reply to finish, then try again.")
          : t("未能删除对话，请重试。", "Could not delete conversations. Try again.")}</Notice>}
        <div className="flex flex-wrap items-center justify-end gap-mx-md">
          <Button type="button" data-autofocus variant="secondary" disabled={busy} onClick={() => setDialog(null)}>{t("取消", "Cancel")}</Button>
          <Button type="button" variant="destructive" disabled={busy} loading={erase.isPending} loadingLabel={t("删除中…", "Deleting…")}
            onClick={() => { if (!inFlight()) erase.mutate(); }}>{t("删除所有对话", "Delete all conversations")}</Button>
        </div>
      </div>}
    </WorkspaceAlertDialog>
  </Panel>;
}
