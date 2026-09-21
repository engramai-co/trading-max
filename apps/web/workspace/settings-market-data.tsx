"use client";

import { Button, Group, Modal, PasswordInput, Stack } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { IntegrationSummary } from "@/lib/types";
import { api, jsonRequest } from "@/workspace/data";
import { Freshness, Notice, Panel, Tag, useCopy } from "./foundation";

const path = "/settings/integrations/alpaca";

export function ReconstructionMarketData({ integration, onSaved }: {
  integration?: IntegrationSummary;
  onSaved: () => void;
}) {
  const t = useCopy();
  const [opened, setOpened] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [saved, setSaved] = useState(false);
  const active = Boolean(integration?.configured && integration.enabled);
  const toggle = useMutation({
    mutationFn: () => api(path, jsonRequest("PATCH", { enabled: !active })),
    onSuccess: () => { setSaved(true); onSaved(); },
  });
  const remove = useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: () => { setRemoving(false); setSaved(true); onSaved(); },
  });
  return (
    <Panel title={t("账户重建行情", "Reconstruction market data")}>
      <div className="mx-setting-row">
        <div>
          <h3>{active ? "Yahoo Finance + Alpaca" : "Yahoo Finance"}</h3>
          <p>{t("默认使用 YF；Alpaca 可补充美股隔夜历史行情。", "YF is the default. Alpaca adds historical US overnight prices.")}</p>
        </div>
        <Tag tone={active ? "good" : "neutral"}>{active ? t("增强已开启", "Enhancement on") : t("默认数据源", "Default source")}</Tag>
      </div>
      <Stack gap="md">
        <Group>
          <Button variant={integration?.configured ? "default" : "filled"} onClick={() => setOpened(true)}>
            {integration?.configured ? t("更新 Alpaca 密钥", "Update Alpaca keys") : t("连接 Alpaca", "Connect Alpaca")}
          </Button>
          {integration?.configured && <>
            <Button variant="default" loading={toggle.isPending} disabled={remove.isPending} onClick={() => { setSaved(false); toggle.mutate(); }}>
              {active ? t("关闭增强", "Turn off enhancement") : t("开启增强", "Turn on enhancement")}
            </Button>
            <Button variant="subtle" color="red" onClick={() => setRemoving(true)}>{t("删除密钥", "Remove keys")}</Button>
          </>}
        </Group>
        {integration?.lastTestAt && <Freshness date={integration.lastTestAt} label={t("连接测试", "Connection tested")} />}
        {toggle.isError && <Notice tone="bad">{t("无法更改设置，请检查 Alpaca 连接后重试。", "Could not update settings. Check the Alpaca connection and retry.")}</Notice>}
        {saved && <Notice tone="good">{t("设置已保存，下一次账户更新会重新计算历史重建。", "Saved. The next account update will recalculate reconstruction history.")}</Notice>}
        <details>
          <summary>{t("覆盖范围与密钥获取", "Coverage and API keys")}</summary>
          <p>{t("使用免费 Paper 账户的 API Key ID 和 Secret。历史 SIP 与 BOATS 数据约延迟 15 分钟；英国证券和汇率仍使用 YF。此连接只读取行情，不会下单。", "Use a free Paper account’s API Key ID and Secret. Historical SIP and BOATS data has a 15-minute delay; UK instruments and FX continue to use YF. This connection only reads market data and never places orders.")}</p>
          <p>{t("Alpaca 无数据时回退到有效的 YF 行情；缺失的隔夜成交不会被填成真实价格。密钥保存在运行服务器的系统凭据库中。", "When Alpaca is unavailable, valid YF data remains the fallback. Missing overnight trades are not fabricated. Keys are kept in the server’s operating-system credential store.")}</p>
          <a href="https://app.alpaca.markets/dashboard/overview" target="_blank" rel="noreferrer">{t("打开 Alpaca → Paper → API Keys", "Open Alpaca → Paper → API Keys")}</a>
        </details>
      </Stack>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t("连接 Alpaca 行情", "Connect Alpaca market data")} centered>
        {opened && <AlpacaKeyForm onSaved={() => { setOpened(false); setSaved(true); onSaved(); }} />}
      </Modal>
      <Modal opened={removing} onClose={() => setRemoving(false)} title={t("删除 Alpaca 密钥", "Remove Alpaca keys")} centered>
        <Stack>
          <p>{t("删除后恢复使用 YF，已有券商记录和快照会保留。", "YF will remain active. Existing broker observations and snapshots are preserved.")}</p>
          {remove.isError && <Notice tone="bad">{t("删除失败，请重试。", "Could not remove keys. Please retry.")}</Notice>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoving(false)}>{t("取消", "Cancel")}</Button>
            <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>{t("确认删除", "Remove keys")}</Button>
          </Group>
        </Stack>
      </Modal>
    </Panel>
  );
}

function AlpacaKeyForm({ onSaved }: { onSaved: () => void }) {
  const t = useCopy();
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const candidate = { apiKeyId: key.trim(), secretKey: secret.trim() };
  const test = useMutation({
    mutationFn: () => api<{ validationToken: string }>(path + "/test", jsonRequest("POST", candidate)),
    onSuccess: (result) => setToken(result.validationToken),
  });
  const save = useMutation({
    mutationFn: () => api(path, jsonRequest("PUT", { ...candidate, enabled: true, validationToken: token })),
    onSuccess: () => { setKey(""); setSecret(""); setToken(null); onSaved(); },
  });
  const busy = test.isPending || save.isPending;
  function edit(action: () => void) { action(); setToken(null); test.reset(); save.reset(); }
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (token && !busy) save.mutate(); }}>
      <Stack gap="md">
        <PasswordInput label="Alpaca API Key ID" visibilityToggleButtonProps={{ "aria-label": t("显示或隐藏 Key ID", "Show or hide key ID") }} autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={(event) => { const value = event.currentTarget.value; edit(() => setKey(value)); }} />
        <PasswordInput label="Alpaca API Secret" visibilityToggleButtonProps={{ "aria-label": t("显示或隐藏 Secret", "Show or hide secret") }} autoComplete="new-password" spellCheck={false} value={secret} disabled={busy} onChange={(event) => { const value = event.currentTarget.value; edit(() => setSecret(value)); }} />
        {test.isError && <Notice tone="bad">{t("历史行情测试失败，请检查密钥与 SIP / BOATS 访问权限。", "Historical market-data test failed. Check the keys and SIP / BOATS access.")}</Notice>}
        {token && <Notice tone="good">{t("SIP 与隔夜 BOATS 访问测试通过。", "SIP and overnight BOATS access verified.")}</Notice>}
        {save.isError && <Notice tone="bad">{t("保存失败，请检查服务器凭据库并重新测试。", "Save failed. Check the server credential store and test again.")}</Notice>}
        <Group grow>
          <Button variant="default" disabled={!key.trim() || !secret.trim() || busy} loading={test.isPending} onClick={() => { setToken(null); test.mutate(); }}>{t("测试连接", "Test connection")}</Button>
          <Button type="submit" disabled={!token || busy} loading={save.isPending}>{t("保存并开启增强", "Save and enable")}</Button>
        </Group>
      </Stack>
    </form>
  );
}
