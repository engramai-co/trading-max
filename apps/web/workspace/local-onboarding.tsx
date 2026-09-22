"use client";

import { Button, Checkbox, Group, Progress, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { components } from "@/lib/api-schema";
import type { DashboardLens } from "@/lib/types";
import { api, currency, jsonRequest } from "./data";
import { Notice, Panel, Pending, QueryError, useCopy } from "./foundation";

type Workspace = components["schemas"]["LocalWorkspaceStatus"];

export function LocalOnboarding() {
  const t = useCopy();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["local-onboarding"], queryFn: () => api<Workspace>("/local-workspace"),
    refetchInterval: 3000, retry: 1,
  });
  const start = useMutation({
    mutationFn: () => api("/local-workspace/refresh", jsonRequest("POST", {})),
    onSuccess: () => { void query.refetch(); },
  });
  const confirm = useMutation({
    mutationFn: (runId: string) => api<Workspace>("/local-workspace/confirm", jsonRequest("POST", { runId })),
    onSuccess: (data) => { client.setQueryData(["local-onboarding"], data); },
  });
  if (query.isPending) return <Pending />;
  if (query.isError || !query.data) return <QueryError retry={query.refetch} />;
  const data = query.data, job = data.latestFullJob;
  const connected = data.connectedAccounts.length > 0;
  const active = Boolean(data.activeJobId);
  const completed = job?.stages?.filter((stage) => ["succeeded", "skipped"].includes(stage.status)).length ?? 0;
  const total = job?.stages?.length ?? 0;
  const failed = job && ["failed", "interrupted"].includes(job.status);
  const ready = data.readiness.status === "ready";
  return <Panel title={t("开始使用你的本地工作区", "Set up your local workspace")}>
    <Stack gap="lg">
      <div><Text fw={600}>{data.name}</Text><Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>{data.path}</Text></div>
      <Group gap="xl" aria-label={t("设置进度", "Setup progress")}>
        <Text size="sm" fw={!connected ? 700 : 400}>{connected ? "✓" : "1"} {t("连接账户", "Connect account")}</Text>
        <Text size="sm" fw={connected && !data.canConfirm && !data.confirmed ? 700 : 400}>{data.canConfirm || data.confirmed ? "✓" : "2"} {t("首次同步", "First sync")}</Text>
        <Text size="sm" fw={data.canConfirm ? 700 : 400}>{data.confirmed ? "✓" : "3"} {t("核对金额", "Check balances")}</Text>
      </Group>
      {!connected && <Notice>{t("在下方连接 Invest 或 ISA 账户。先测试，再保存；只需连接你实际使用的账户。密钥只保存在这台 Mac 的钥匙串里。", "Connect Invest or ISA below. Test before saving, and connect only the accounts you use. Credentials stay in this Mac’s Keychain.")}</Notice>}
      {connected && !data.confirmed && !data.canConfirm && !active && <Notice>{t("账户已连接。接下来同步账户、交易记录与公开市场数据；首次同步可能需要几分钟。", "Your account is connected. Sync accounts, transactions and public market data next; the first run can take a few minutes.")}</Notice>}
      {active && <div role="status" aria-live="polite">
        <Text size="sm" mb="sm">{t("正在同步…", "Syncing…")} {total > 0 ? `${completed} / ${total}` : t("等待任务开始", "Waiting for the worker")}</Text>
        <Progress value={total ? completed / total * 100 : 0} aria-label={t("同步进度", "Sync progress")} />
        <Text size="xs" c="dimmed" mt="sm">{t("可离开此页面；请保持 App 打开和网络连接。", "You can leave this page; keep the App open and connected.")}</Text>
      </div>}
      {failed && !active && <Notice tone="warn">{t("上次同步未完成。已保存的连接和资料仍在，可以查看原因后重试。", "The last sync did not complete. Saved connections and data remain available; check its status and retry.")}</Notice>}
      {!ready && connected && !active && job?.status === "succeeded" && <Notice tone="warn">{t("同步任务已结束，数据就绪检查尚未通过。请查看数据状态。", "The sync finished, but readiness checks have not passed. Check Data status.")}</Notice>}
      {start.isError && <Notice tone="warn">{t("未能开始同步，请检查账户连接后重试。", "Could not start the sync. Check your account connection and retry.")}</Notice>}
      {confirm.isError && <Notice tone="warn">{t("数据可能已更新，请重新核对当前金额。", "Data may have changed. Check the current balances again.")}</Notice>}
      {data.canConfirm && !data.confirmed && data.readiness.latestRunId && <BalanceConfirmation key={data.readiness.latestRunId} runId={data.readiness.latestRunId} onConfirm={(run) => confirm.mutate(run)} busy={confirm.isPending} />}
      {data.confirmed && <Notice tone="good">{t("账户金额已核对，工作区设置完成。", "Balances checked. Your workspace is set up.")}</Notice>}
      <Group>
        {!data.confirmed && !data.canConfirm && <Button disabled={!connected || active} loading={start.isPending} onClick={() => start.mutate()}>{failed ? t("重试同步", "Retry sync") : t("开始首次同步", "Start first sync")}</Button>}
        {data.confirmed && ready && <Button component={Link} href="/">{t("进入投资工作台", "Open workspace")}</Button>}
        {job && <Button component={Link} href="/health" variant="subtle">{t("查看同步详情", "View sync details")}</Button>}
      </Group>
      <Text size="xs" c="dimmed">{t("App 打开期间可在「更新计划」开启自动记录。退出 App 或 Mac 休眠后暂停更新；模型与 Alpaca 都是可选项。", "Enable automatic recording in Update schedule while the App is open. Updates pause when you quit or the Mac sleeps. Models and Alpaca are optional.")}</Text>
    </Stack>
  </Panel>;
}

function BalanceConfirmation({ runId, onConfirm, busy }: { runId: string; onConfirm: (run: string) => void; busy: boolean }) {
  const t = useCopy();
  const [checked, setChecked] = useState(false);
  const query = useQuery({
    queryKey: ["local-balance-check", runId],
    queryFn: () => api<DashboardLens>("/dashboard/lens/overview?detail=summary"), retry: 1,
  });
  if (query.isPending) return <Pending />;
  if (query.isError || !query.data || query.data.runId !== runId) return <QueryError retry={query.refetch} />;
  const accounts = query.data.accounts?.filter((account) => account.isInvestable) ?? [];
  return <Stack gap="md">
    <Text size="sm">{t("请对照 Trading 212，确认下面的账户价值合理。", "Compare these account values with Trading 212 before continuing.")}</Text>
    {accounts.map((account) => <Group key={account.code} justify="space-between"><Text>{account.code === "A" ? "Invest" : "ISA"}</Text><Text fw={600}>{currency(account.totalValueGbp, "GBP", 2)}</Text></Group>)}
    <Text size="xs" c="dimmed">{t("按 GBP 统一展示；外币账户需对照折算后的金额。", "Values are shown in GBP; compare converted values for foreign-currency accounts.")}</Text>
    <Checkbox label={t("我已核对，账户金额合理", "I have checked that the account values are plausible")} checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} />
    <Group><Button loading={busy} disabled={!checked || !accounts.length} onClick={() => onConfirm(runId)}>{t("完成设置", "Finish setup")}</Button></Group>
  </Stack>;
}
