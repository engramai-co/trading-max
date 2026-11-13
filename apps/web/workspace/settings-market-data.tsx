"use client";

import { useBuildNavigationGuard } from "@/ui/publication-provider";
import { Button, Group, Loader, Modal, PasswordInput, Stack, Switch } from "@mantine/core";
import { useIsMutating, useMutation, useMutationState, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { IntegrationOverview, IntegrationSummary } from "@/lib/types";
import { api, jsonRequest } from "@/workspace/data";
import { Freshness, Notice, Panel, useCopy } from "./foundation";
import { settingsKey } from "./settings-query";

const path = "/settings/integrations/alpaca";
/** Every Alpaca write shares this key, so the global mutation cache can hold one at a time across tab changes. */
const writeKey = ["settings", "alpaca", "write"];

/**
 * Asked as a write starts. Two presses in one task both run before React re-renders, so both see the same `busy`; the
 * mutation cache counts the first write the moment it starts.
 */
function writeInFlight(client: QueryClient) {
  return client.isMutating({ mutationKey: writeKey }) > 0;
}

/** Writes a confirmed Alpaca result, or its removal, into the cached settings, then reloads them. */
function confirmAlpaca(client: QueryClient, alpaca: IntegrationSummary | null) {
  client.setQueryData<IntegrationOverview>(settingsKey, (overview) => {
    if (!overview) return overview;
    const others = overview.integrations.filter((item) => item.provider !== "alpaca");
    return { ...overview, integrations: alpaca ? [...others, alpaca] : others };
  });
  void client.invalidateQueries({ queryKey: settingsKey });
}

/** The integration comes from the cached settings, the switch's one source of truth. */
export function ReconstructionMarketData({ integration }: { integration?: IntegrationSummary }) {
  const t = useCopy();
  const client = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [removing, setRemoving] = useState(false);
  useBuildNavigationGuard(opened || removing);
  // What the latest write came to. Starting another write clears it, so no notice outlives its action.
  const [outcome, setOutcome] = useState<"saved" | "failed" | null>(null);
  const toggle = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ enabled }: { enabled: boolean }) => api<IntegrationSummary>(path, jsonRequest("PATCH", { enabled })),
    onSuccess: (alpaca) => { confirmAlpaca(client, alpaca); setOutcome("saved"); },
    onError: () => setOutcome("failed"),
  });
  const remove = useMutation({
    mutationKey: writeKey,
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: () => { confirmAlpaca(client, null); setOutcome("saved"); setRemoving(false); },
  });
  // Renders the lock: one Alpaca write at a time, counted in the global mutation cache, so leaving the tab and coming
  // back keeps it. Each confirmed result is already in the settings cache, so no write waits for the reload.
  const busy = useIsMutating({ mutationKey: writeKey }) > 0;
  // A switch change in flight, wherever it started: only the toggle's variables carry { enabled }.
  const requested = useMutationState({
    filters: { mutationKey: writeKey, status: "pending" },
    select: (mutation) => (mutation.state.variables as { enabled?: boolean } | undefined)?.enabled,
  }).find((value) => value !== undefined);
  const begin = () => {
    setOutcome(null);
    remove.reset();
  };
  // A change in flight shows its requested value; otherwise the switch shows the cached settings.
  const enabled = requested ?? Boolean(integration?.configured && integration.enabled);
  return (
    <Panel
      title={t("行情数据", "Market data")}
      help={t("Alpaca 提供美股行情，并补充账户净值重建所需的历史数据。", "Alpaca provides US market prices and supplements account value reconstruction.")}
    >
      {/* YF is the base in every state; the row names it until Alpaca keys exist, then switches Alpaca on or off. */}
      <div className="mx-setting-row">
        {integration?.configured ? (
          <Switch
            className="mx-setting-switch"
            label={t("Alpaca 增强", "Alpaca enhancement")}
            labelPosition="left"
            checked={enabled}
            // Key changes disable it; its own change only holds presses, so a focused switch keeps focus.
            disabled={busy && requested === undefined}
            aria-busy={requested !== undefined || undefined}
            thumbIcon={requested !== undefined ? <Loader size={10} /> : undefined}
            onChange={(event) => {
              if (writeInFlight(client)) return;
              begin();
              toggle.mutate({ enabled: event.currentTarget.checked });
            }}
          />
        ) : (
          <>
            <div>
              <h3>Yahoo Finance</h3>
            </div>
            <Button disabled={busy} onClick={() => setOpened(true)}>{t("连接 Alpaca", "Connect Alpaca")}</Button>
          </>
        )}
        {/* Always mounted, so screen readers hear the save start; empty otherwise. Focus stays on the switch. */}
        <span role="status" className="sr-only">{requested !== undefined ? t("正在保存…", "Saving…") : null}</span>
      </div>
      <Stack gap="md">
        {integration?.configured && (
          <Group>
            <Button variant="default" disabled={busy} onClick={() => setOpened(true)}>{t("更新 Alpaca 密钥", "Update Alpaca keys")}</Button>
            <Button variant="subtle" color="red" disabled={busy} onClick={() => setRemoving(true)}>{t("删除密钥", "Remove keys")}</Button>
          </Group>
        )}
        {integration?.lastTestAt && <Freshness date={integration.lastTestAt} label={t("连接测试", "Connection tested")} />}
        {outcome === "failed" && <Notice tone="bad">{t("无法更改设置，请检查 Alpaca 连接后重试。", "Could not update settings. Check the Alpaca connection and retry.")}</Notice>}
        {outcome === "saved" && <Notice tone="good">{t("设置已保存，下一次账户更新会重新计算历史重建。", "Saved. The next account update will recalculate reconstruction history.")}</Notice>}
        <details>
          <summary>{t("覆盖范围与密钥获取", "Coverage and API keys")}</summary>
          <p className="mx-measure">{t("使用免费 Paper 账户的 API Key ID 和 Secret。密钥保存在服务器的系统凭据库中。", "Use a free Paper account’s API Key ID and Secret. Keys are kept in the server’s operating-system credential store.")}</p>
          <a href="https://app.alpaca.markets/dashboard/overview" target="_blank" rel="noreferrer">{t("打开 Alpaca → Paper → API Keys", "Open Alpaca → Paper → API Keys")}</a>
        </details>
      </Stack>
      {/* A dialog stays open until its write settles, so its outcome shows where it was asked for. */}
      <Modal opened={opened} onClose={() => { if (!busy) setOpened(false); }} title={t("连接 Alpaca 行情", "Connect Alpaca market data")} centered>
        {opened && <AlpacaKeyForm onStart={begin} onSaved={() => { setOpened(false); setOutcome("saved"); }} />}
      </Modal>
      <Modal opened={removing} onClose={() => { if (!remove.isPending) setRemoving(false); }} title={t("删除 Alpaca 密钥", "Remove Alpaca keys")} centered>
        <Stack>
          <p>{t("删除后恢复使用 YF，已有券商记录和快照会保留。", "YF will remain active. Existing broker observations and snapshots are preserved.")}</p>
          {remove.isError && <Notice tone="bad">{t("删除失败，请重试。", "Could not remove keys. Please retry.")}</Notice>}
          <Group justify="flex-end">
            <Button variant="default" disabled={remove.isPending} onClick={() => setRemoving(false)}>{t("取消", "Cancel")}</Button>
            <Button color="red" loading={remove.isPending} disabled={busy} onClick={() => { if (writeInFlight(client)) return; begin(); remove.mutate(); }}>{t("确认删除", "Remove keys")}</Button>
          </Group>
        </Stack>
      </Modal>
    </Panel>
  );
}

/**
 * Tests and saves a candidate key pair. The keys and the validation token live only in this dialog's state, which is
 * cleared on success and goes with the dialog: neither request takes them as mutation variables, and both mutations
 * leave the cache as soon as they settle.
 */
function AlpacaKeyForm({ onStart, onSaved }: { onStart: () => void; onSaved: () => void }) {
  const t = useCopy();
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState<"test" | "save" | null>(null);
  const candidate = { apiKeyId: key.trim(), secretKey: secret.trim() };
  const test = useMutation({
    gcTime: 0,
    mutationFn: () => api<{ validationToken: string }>(path + "/test", jsonRequest("POST", candidate)),
  });
  const save = useMutation({
    mutationKey: writeKey,
    gcTime: 0,
    mutationFn: () => api<IntegrationSummary>(path, jsonRequest("PUT", { ...candidate, enabled: true, validationToken: token })),
    onSuccess: (alpaca) => confirmAlpaca(client, alpaca),
  });
  // Any Alpaca write in flight, including one that began before this dialog opened.
  const writing = useIsMutating({ mutationKey: writeKey }) > 0;
  const busy = test.isPending || writing;
  function edit(action: () => void) { action(); setToken(null); setFailed(null); }
  function runTest() {
    setToken(null);
    setFailed(null);
    test.mutate(undefined, {
      onSuccess: (result) => setToken(result.validationToken),
      onError: () => setFailed("test"),
      onSettled: () => test.reset(),
    });
  }
  function submit() {
    if (!token || test.isPending || writeInFlight(client)) return;
    onStart();
    setFailed(null);
    save.mutate(undefined, {
      onSuccess: () => { setKey(""); setSecret(""); setToken(null); onSaved(); },
      onError: () => setFailed("save"),
      onSettled: () => save.reset(),
    });
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Stack gap="md">
        <PasswordInput label="Alpaca API Key ID" visibilityToggleButtonProps={{ "aria-label": t("显示或隐藏 Key ID", "Show or hide key ID") }} autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={(event) => { const value = event.currentTarget.value; edit(() => setKey(value)); }} />
        <PasswordInput label="Alpaca API Secret" visibilityToggleButtonProps={{ "aria-label": t("显示或隐藏 Secret", "Show or hide secret") }} autoComplete="new-password" spellCheck={false} value={secret} disabled={busy} onChange={(event) => { const value = event.currentTarget.value; edit(() => setSecret(value)); }} />
        {failed === "test" && <Notice tone="bad">{t("历史行情测试失败，请检查密钥与 SIP / BOATS 访问权限。", "Historical market-data test failed. Check the keys and SIP / BOATS access.")}</Notice>}
        {token && <Notice tone="good">{t("SIP 与隔夜 BOATS 访问测试通过。", "SIP and overnight BOATS access verified.")}</Notice>}
        {failed === "save" && <Notice tone="bad">{t("保存失败，请检查服务器凭据库并重新测试。", "Save failed. Check the server credential store and test again.")}</Notice>}
        <Group grow>
          <Button variant="default" disabled={!key.trim() || !secret.trim() || busy} loading={test.isPending} onClick={runTest}>{t("测试连接", "Test connection")}</Button>
          <Button type="submit" disabled={!token || busy} loading={save.isPending}>{t("保存并开启增强", "Save and enable")}</Button>
        </Group>
      </Stack>
    </form>
  );
}
