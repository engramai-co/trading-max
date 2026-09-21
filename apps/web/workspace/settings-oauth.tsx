"use client";

import { Anchor, Button, Checkbox, Code, CopyButton, Group, Select, Stack, Text } from "@mantine/core";
import { ArrowSquareOut, Copy, Check } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { IntegrationSummary, LLMProviderDescriptor, OAuthLoginStatus } from "@/lib/types";
import { api, jsonRequest } from "./data";
import { Notice, useCopy } from "./foundation";

const loginPath = "/settings/llm/oauth/openai";

export function OpenAIOAuthConnection({ provider, existing, useAsDefault, onSaved }: {
  provider: LLMProviderDescriptor;
  existing?: IntegrationSummary;
  useAsDefault?: boolean;
  onSaved: (result: "saved" | "disconnected") => void;
}) {
  const t = useCopy();
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
  return <Stack gap="lg">
    <Notice>{t(
      "使用 ChatGPT 账户的 Codex 额度。授权保存在运行 Trading Max 的设备上；API Key 使用独立计费。",
      "Use your ChatGPT account’s Codex allowance. Authorization stays on the device running Trading Max. API keys are billed separately.",
    )}</Notice>
    <Select label={t("模型", "Model")} data={provider.models} value={model}
      onChange={(value) => setModel(value ?? provider.defaultModel)} disabled={pending} allowDeselect={false} />
    <Checkbox checked={defaultModel} onChange={(event) => setDefaultModel(event.currentTarget.checked)}
      disabled={pending} label={t("设为默认模型", "Use as the default model")} />
    {current?.state === "pending" && current.userCode && current.verificationUrl && <Stack gap="md" aria-live="polite">
      <Text fw={600}>{t("在 OpenAI 完成授权", "Authorize with OpenAI")}</Text>
      <Text size="sm">{t("复制一次性代码，然后打开授权页面。完成后这里会自动连接。", "Copy the one-time code and open the authorization page. This screen will connect automatically when you finish.")}</Text>
      <Group justify="space-between" wrap="nowrap">
        <Code fz="xl" p="sm">{current.userCode}</Code>
        <CopyButton value={current.userCode}>{({ copied, copy }) => <Button variant="light" onClick={copy} leftSection={copied ? <Check size={16} /> : <Copy size={16} />}>
          {copied ? t("已复制", "Copied") : t("复制代码", "Copy code")}
        </Button>}</CopyButton>
      </Group>
      <Button component="a" href={current.verificationUrl} target="_blank" rel="noopener noreferrer" rightSection={<ArrowSquareOut size={16} />}>
        {t("打开 OpenAI 授权", "Open OpenAI authorization")}
      </Button>
      <Text size="sm" c="dimmed">{t("代码约 15 分钟内有效。请仅在 OpenAI 官方页面登录并输入代码。", "The code is valid for about 15 minutes. Sign in and enter it only on the official OpenAI page.")}</Text>
    </Stack>}
    {failed && <Notice tone="warn">{current?.errorCode === "credential_store_unavailable"
      ? t("设备的凭据存储不可用，连接未保存。请解锁系统钥匙串后重试。", "The device credential store is unavailable. Unlock the system keychain and try again.")
      : t("本次登录未完成或已过期，请重试。若无法取得授权码，请检查 ChatGPT 安全设置中的设备码登录权限。", "Login did not complete or expired. Try again; if no code appears, check device-code login permissions in ChatGPT security settings.")}</Notice>}
    {pending ? <Group>
      <Button variant="light" loading>{t("等待授权", "Waiting for authorization")}</Button>
      {session && <Button variant="subtle" onClick={() => cancel.mutate()} loading={cancel.isPending}>{t("取消", "Cancel")}</Button>}
    </Group> : <Button onClick={() => { setSession(null); start.mutate(); }} loading={start.isPending}>
      {t("使用 ChatGPT 登录", "Sign in with ChatGPT")}
    </Button>}
    <Text size="sm" c="dimmed">{t("账户可用模型和使用额度以 OpenAI 为准。", "Model access and usage limits depend on your OpenAI account.")} {" "}
      <Anchor size="sm" href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noopener noreferrer">{t("登录帮助", "Sign-in help")}</Anchor>
    </Text>
    {existing?.configured && <Button color="red" variant="subtle" disabled={pending} loading={disconnect.isPending}
      onClick={() => disconnecting ? disconnect.mutate() : setDisconnecting(true)}>
      {disconnecting ? t("确认移除此设备的授权", "Confirm removing this device’s authorization") : t("断开 ChatGPT", "Disconnect ChatGPT")}
    </Button>}
  </Stack>;
}
