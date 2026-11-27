"use client";

import { Code } from "@mantine/core";
import { Checkbox } from "@/components/ui/checkbox";
import { ExternalLink } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { TextLink } from "@/components/ui/text-link";
import type { IntegrationSummary, LLMProviderDescriptor, OAuthLoginStatus } from "@/lib/types";
import { api, jsonRequest } from "./data";
import { Notice, useCopy } from "./foundation";
import { SelectPicker } from "./picker";

const loginPath = "/settings/llm/oauth/openai";

export function OpenAIOAuthConnection({ provider, existing, useAsDefault, onSaved }: {
  provider: LLMProviderDescriptor;
  existing?: IntegrationSummary;
  useAsDefault?: boolean;
  onSaved: (result: "saved" | "disconnected") => void;
}) {
  const t = useCopy();
  const codeId = useId();
  const [model, setModel] = useState(existing?.model ?? provider.defaultModel);
  const [defaultModel, setDefaultModel] = useState(Boolean(useAsDefault));
  const [session, setSession] = useState<OAuthLoginStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  const delivered = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void api(`${loginPath}/${active.current}`, { method: "DELETE" }).catch(() => {});
    };
  }, []);
  const start = useMutation({
    mutationFn: () => api<OAuthLoginStatus>(`${loginPath}/start`, jsonRequest("POST", { model, useAsDefault: defaultModel })),
    onSuccess: (value) => {
      if (!mounted.current) {
        void api(`${loginPath}/${value.sessionId}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      active.current = value.sessionId;
      setSession(value);
    },
  });
  const status = useQuery({
    queryKey: ["openai-oauth", session?.sessionId],
    queryFn: () => api<OAuthLoginStatus>(`${loginPath}/${session!.sessionId}`),
    enabled: Boolean(session),
    refetchInterval: (query) => query.state.error ||
      ["connected", "error", "expired", "cancelled"].includes(query.state.data?.state ?? "") ? false : 2000,
    retry: false,
    gcTime: 0,
  });
  const current = status.data ?? session;
  const pending = start.isPending || (!status.isError && ["starting", "pending"].includes(current?.state ?? ""));
  useEffect(() => {
    if (current?.state === "connected" && !delivered.current) {
      delivered.current = true;
      active.current = null;
      onSaved("saved");
    }
  }, [current?.state, onSaved]);
  const cancel = useMutation({
    mutationFn: () => api(`${loginPath}/${active.current}`, { method: "DELETE" }),
    onSuccess: () => { active.current = null; setSession(null); },
  });
  const disconnect = useMutation({
    mutationFn: () => api("/settings/llm/providers/openai-codex", { method: "DELETE" }),
    onSuccess: () => onSaved("disconnected"),
  });
  const failed = start.isError || status.isError || cancel.isError || disconnect.isError || current?.state === "error" || current?.state === "expired";
  return <div className="flex flex-col gap-mx-lg">
    <Notice>{t(
      "使用 ChatGPT 账户的 Codex 额度。授权保存在运行 Trading Max 的设备上；API Key 使用独立计费。",
      "Use your ChatGPT account’s Codex allowance. Authorisation stays on the device running Trading Max. API keys are billed separately.",
    )}</Notice>
    <SelectPicker label={t("模型", "Model")} options={provider.models} value={model}
      onChange={(value) => setModel(value ?? provider.defaultModel)} disabled={pending}  />
    <Checkbox checked={defaultModel} onCheckedChange={(checked) => setDefaultModel(checked)}
      disabled={pending} label={t("设为默认模型", "Use as the default model")} />
    {current?.state === "pending" && current.userCode && current.verificationUrl && <div className="flex flex-col gap-mx-md" aria-live="polite">
      <p className="text-[0.9375rem] leading-[1.55] font-semibold">{t("在 OpenAI 完成授权", "Authorise with OpenAI")}</p>
      <p className="text-[0.8125rem] leading-[1.45]">{t("复制一次性代码，然后打开授权页面。完成后这里会自动连接。", "Copy the one-time code and open the authorisation page. This screen will connect automatically when you finish.")}</p>
      <div className="flex flex-nowrap items-center justify-between gap-mx-md">
        <Code id={codeId} fz="xl" p="sm">{current.userCode}</Code>
        <CopyButton
          value={current.userCode}
          targetId={codeId}
          label={t("复制代码", "Copy code")}
          copiedLabel={t("已复制", "Copied")}
          failedLabel={t("复制失败", "Copy failed")}
          announcedCopied={t("一次性代码已复制", "One-time code copied")}
          announcedFailed={t("未能复制代码，请手动复制", "Could not copy code. Copy it manually.")}
        />
      </div>
      <a href={current.verificationUrl} target="_blank" rel="noopener noreferrer" data-slot="button" className={buttonVariants()}>
        {t("打开 OpenAI 授权", "Open OpenAI authorisation")}
        <ExternalLink size={16} aria-hidden="true" />
      </a>
      <p className="text-[0.8125rem] leading-[1.45] text-[var(--mx-muted)]">{t("代码约 15 分钟内有效。请仅在 OpenAI 官方页面登录并输入代码。", "The code is valid for about 15 minutes. Sign in and enter it only on the official OpenAI page.")}</p>
    </div>}
    {failed && <Notice tone="warn">{current?.errorCode === "credential_store_unavailable"
      ? t("设备的凭据存储不可用，连接未保存。请解锁系统钥匙串后重试。", "The device credential store is unavailable. Unlock the system keychain and try again.")
      : t("本次登录未完成或已过期，请重试。若无法取得授权码，请检查 ChatGPT 安全设置中的设备码登录权限。", "Login did not complete or expired. Try again; if no code appears, check device-code login permissions in ChatGPT security settings.")}</Notice>}
    {pending ? <div className="flex flex-wrap items-center gap-mx-md">
      <Button
        variant="secondary"
        loading
        loadingLabel={t("等待授权", "Waiting for authorisation")}
      >
        {t("等待授权", "Waiting for authorisation")}
      </Button>
      {session && <Button variant="ghost" onClick={() => cancel.mutate()} loading={cancel.isPending} loadingLabel={t("取消中…", "Cancelling…")}>{t("取消", "Cancel")}</Button>}
    </div> : <Button onClick={() => { setSession(null); start.mutate(); }} loading={start.isPending} loadingLabel={t("启动中…", "Starting…")}>
      {t("使用 ChatGPT 登录", "Sign in with ChatGPT")}
    </Button>}
    <p className="text-[0.8125rem] leading-[1.45] text-[var(--mx-muted)]">{t("账户可用模型和使用额度以 OpenAI 为准。", "Model access and usage limits depend on your OpenAI account.")} {" "}
      <TextLink inline external href="https://learn.chatgpt.com/docs/auth">{t("登录帮助", "Sign-in help")}</TextLink>
    </p>
    {existing?.configured && <Button variant={disconnecting ? "destructive" : "ghost"} disabled={pending} loading={disconnect.isPending} loadingLabel={t("断开中…", "Disconnecting…")}
      onClick={() => disconnecting ? disconnect.mutate() : setDisconnecting(true)}>
      {disconnecting ? t("确认移除此设备的授权", "Confirm removing this device’s authorisation") : t("断开 ChatGPT", "Disconnect ChatGPT")}
    </Button>}
  </div>;
}
