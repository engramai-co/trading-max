"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "./link";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { components } from "@/lib/api-schema";
import { dashboardLensLatestKey } from "@/lib/dashboard-query";
import type { DashboardLens } from "@/lib/types";
import { api, currency, jsonRequest } from "./data";
import { Notice, Panel, Pending, QueryError, QueryReadStatus, StatusMessage, useCopy } from "./foundation";

export type LocalWorkspaceStatus = components["schemas"]["LocalWorkspaceStatus"];
export const LOCAL_ONBOARDING_QUERY_KEY = ["local-onboarding"] as const;

export function fetchLocalWorkspaceStatus(signal?: AbortSignal) {
  return api<LocalWorkspaceStatus>("/local-workspace", { signal });
}

/** Record balance confirmation and reset only the live overview summary lens so historical snapshots stay cached. */
export function applyLocalWorkspaceConfirmation(client: QueryClient, data: LocalWorkspaceStatus) {
  client.setQueryData(LOCAL_ONBOARDING_QUERY_KEY, data);
  return client.resetQueries({
    queryKey: dashboardLensLatestKey("overview", undefined, { detail: "summary" }),
    exact: true,
  });
}

export function LocalOnboarding({ showAccountLink = false, pending = <Pending /> }: {
  showAccountLink?: boolean;
  pending?: React.ReactNode;
}) {
  const t = useCopy();
  const client = useQueryClient();
  const syncStatusId = useId();
  const confirmErrorId = useId();
  const statusErrorId = useId();
  const query = useQuery({
    queryKey: LOCAL_ONBOARDING_QUERY_KEY,
    queryFn: ({ signal }) => fetchLocalWorkspaceStatus(signal),
    refetchInterval: 3000, retry: 1,
  });
  const start = useMutation({
    mutationFn: () => api("/local-workspace/refresh", jsonRequest("POST", {})),
    onSuccess: () => { void query.refetch(); },
  });
  const confirm = useMutation({
    mutationFn: (runId: string) => api<LocalWorkspaceStatus>("/local-workspace/confirm", jsonRequest("POST", { runId })),
    onSuccess: (data) => {
      void applyLocalWorkspaceConfirmation(client, data);
    },
  });
  const data = query.data;
  const stale = Boolean(data && (query.isRefetchError || query.failureCount > 0));
  const statusError = stale ? t("未能刷新工作区状态。", "Workspace status could not be refreshed.") : undefined;
  const job = data?.latestFullJob;
  const connected = Boolean(data && data.connectedAccounts.length > 0);
  const activeJobId = data?.activeJobId;
  const active = Boolean(activeJobId);
  const progressJob = active && job?.jobId !== activeJobId ? undefined : job;
  const completed = progressJob?.stages?.filter((stage) => ["succeeded", "skipped"].includes(stage.status)).length ?? 0;
  const total = progressJob?.stages?.length ?? 0;
  const failed = Boolean(job && ["failed", "interrupted"].includes(job.status));
  const ready = data?.readiness.status === "ready";
  const readinessBlocked = Boolean(data && !ready && connected && !active && job?.status === "succeeded");

  const startError = start.isError
    ? t("未能开始同步，请检查账户连接后重试。", "Could not start the sync. Check your account connection and retry.")
    : null;
  const confirmError = confirm.isError
    ? t("数据可能已更新，请重新核对当前金额。", "Data may have changed. Check the current balances again.")
    : null;
  const syncError = failed && !active
    ? t("上次同步未完成。已保存的连接和数据仍在，可以查看原因后重试。", "The last sync did not complete. Saved connections and data remain available; check its status and retry.")
    : null;
  const readinessError = readinessBlocked
    ? t("同步任务已结束，数据就绪检查尚未通过。请查看数据状态。", "The sync finished, but readiness checks have not passed. Check Data status.")
    : null;
  const waitingForWorker = t("等待任务开始", "Waiting for the worker");
  const syncing = t("正在同步…", "Syncing…");
  const progressLabel = t("同步进度", "Sync progress");
  const setupTitle = t("开始使用你的本地工作区", "Set up your local workspace");
  const announcement = startError ?? confirmError ?? syncError ?? readinessError ??
    (active
      ? total > 0 ? syncing + ` ${completed} / ${total}` : waitingForWorker
      : data?.canConfirm && !data.confirmed
        ? t("首次同步已完成，请核对下方账户价值并完成设置。", "First sync finished. Compare the updated account balances below to complete setup.")
        : undefined);

  const status = <QueryReadStatus label={setupTitle} failed={query.isError && !data}
    refreshFailureMessage={statusError} ready={Boolean(data) && !stale} error={query.error} />;
  if (!data) return <>{status}{query.isPending ? pending : <QueryError retry={query.refetch} error={query.error} />}</>;

  const step1Current = !stale && !connected;
  const step2Current = !stale && connected && !data.canConfirm && !data.confirmed;
  const step3Current = !stale && data.canConfirm && !data.confirmed;
  const showProgress = !stale && (active || ((failed || readinessBlocked) && total > 0));
  const hasSyncAlert = !stale && Boolean(syncError || readinessError || startError);

  return <>{status}<Panel id="local-onboarding" title={setupTitle}>
    <StatusMessage message={stale ? undefined : announcement} />
    <div className="flex flex-col gap-mx-lg">
      <div>
        <p className="text-[0.9375rem] leading-[1.55] font-semibold">{data.name}</p>
        <p className="wrap-anywhere text-[0.8125rem] leading-[1.45] text-muted-foreground">{data.path}</p>
      </div>
      <ol role="list" className="m-0 flex list-none flex-wrap items-center gap-mx-xl p-0" aria-label={t("设置进度", "Setup progress")}>
        <li aria-current={step1Current ? "step" : undefined} className={`text-[0.8125rem] leading-[1.45] ${step1Current ? "font-bold" : "font-normal"}`}>
          {connected ? "✓" : "1"} {t("连接账户", "Connect account")}
        </li>
        <li
          aria-current={step2Current ? "step" : undefined}
          aria-describedby={hasSyncAlert ? syncStatusId : undefined}
          className={`text-[0.8125rem] leading-[1.45] ${step2Current ? "font-bold" : "font-normal"}`}
        >
          {data.canConfirm || data.confirmed ? "✓" : "2"} {t("首次同步", "First sync")}
        </li>
        <li
          aria-current={step3Current ? "step" : undefined}
          aria-describedby={confirm.isError ? confirmErrorId : undefined}
          className={`text-[0.8125rem] leading-[1.45] ${step3Current ? "font-bold" : "font-normal"}`}
        >
          {data.confirmed ? "✓" : "3"} {t("核对金额", "Check balances")}
        </li>
      </ol>
      {statusError && <Notice tone="warn">
        <span id={statusErrorId}>{statusError}</span>{" "}
        <Button
          type="button"
          variant="link"
          className="-my-2 px-1"
          loading={query.isFetching}
          loadingLabel={t("正在重试…", "Retrying…")}
          onClick={() => void query.refetch()}
        >{t("重试", "Retry")}</Button>
      </Notice>}
      {!stale && !connected && <Notice>{t("先连接 Invest 或 ISA 账户。测试通过后再保存，只需连接你实际使用的账户。密钥只保存在这台 Mac 的钥匙串里。", "Connect Invest or ISA first. Test before saving, and connect only the accounts you use. Credentials stay in this Mac’s Keychain.")}</Notice>}
      {!stale && connected && !failed && !data.confirmed && !data.canConfirm && !active && <Notice>{t("账户已连接。接下来同步账户、交易记录与公开市场数据；首次同步可能需要几分钟。", "Your account is connected. Sync accounts, transactions and public market data next; the first run can take a few minutes.")}</Notice>}
      {showProgress && <div>
        <p className="mb-mx-sm text-[0.8125rem] leading-[1.45]">
          {active ? syncing : readinessBlocked ? t("同步已结束", "Sync finished") : t("同步已停止", "Sync stopped")}{" "}
          {total > 0 ? `${completed} / ${total}` : waitingForWorker}
        </p>
        {total > 0
          ? <Progress value={completed} max={total} aria-label={progressLabel} />
          : <progress className="tm-sync-progress" aria-label={progressLabel} />}
        {active && <p className="mt-mx-sm text-xs leading-[1.4] text-muted-foreground">{t("可离开此页面；请保持 App 打开和网络连接。", "You can leave this page; keep the App open and connected.")}</p>}
      </div>}
      {hasSyncAlert && <div id={syncStatusId} className="flex flex-col gap-mx-md">
        {syncError && <Notice tone="warn">{syncError}</Notice>}
        {readinessError && <Notice tone="warn">{readinessError}</Notice>}
        {startError && <Notice tone="warn">{startError}</Notice>}
      </div>}
      {confirmError && <div id={confirmErrorId}><Notice tone="warn">{confirmError}</Notice></div>}
      {data.canConfirm && !data.confirmed && data.readiness.latestRunId && (
        <BalanceConfirmation
          key={data.readiness.latestRunId}
          runId={data.readiness.latestRunId}
          errorId={stale ? statusErrorId : confirm.isError ? confirmErrorId : undefined}
          onConfirm={(run) => { if (!stale) confirm.mutate(run); }}
          busy={confirm.isPending}
          disabled={stale}
        />
      )}
      {!stale && data.confirmed && <Notice tone="good">{t("账户金额已核对，工作区设置完成。", "Balances checked. Your workspace is set up.")}</Notice>}
      <div className="flex flex-wrap items-center gap-mx-md">
        {showAccountLink && <Link href="/settings?tab=accounts&onboarding=1" data-slot="button" className={buttonVariants({ variant: "secondary" })}>{t("账户连接", "Account connections")}</Link>}
        {!data.confirmed && !data.canConfirm && (
          <Button
            type="button"
            aria-describedby={stale ? statusErrorId : hasSyncAlert ? syncStatusId : undefined}
            disabled={stale || !connected || active}
            loading={start.isPending}
            loadingLabel={t("正在开始…", "Starting…")}
            onClick={() => start.mutate()}
          >
            {failed ? t("重试同步", "Retry sync") : t("开始首次同步", "Start first sync")}
          </Button>
        )}
        {!stale && data.confirmed && ready && <Link href="/" data-slot="button" className={buttonVariants()}>{t("进入工作区", "Open workspace")}</Link>}
        {job && <Link href="/health" data-slot="button" className={buttonVariants({ variant: "ghost" })}>{t("查看同步详情", "View sync details")}</Link>}
      </div>
      <p className="text-xs leading-[1.4] text-muted-foreground">{t("App 打开期间可在「更新计划」开启自动记录。退出 App 或 Mac 休眠后暂停更新；模型与 Alpaca 都是可选项。", "Enable automatic recording in Update schedule while the App is open. Updates pause when you quit or the Mac sleeps. Models and Alpaca are optional.")}</p>
    </div>
  </Panel></>;
}

function BalanceConfirmation({
  runId,
  errorId,
  onConfirm,
  busy,
  disabled,
}: {
  runId: string;
  errorId?: string;
  onConfirm: (run: string) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const t = useCopy();
  const [checked, setChecked] = useState(false);
  const query = useQuery({
    queryKey: ["local-balance-check", runId],
    queryFn: async ({ signal }) => {
      const lens = await api<DashboardLens>("/dashboard/lens/overview?detail=summary", { signal });
      if (lens.runId !== runId) throw new Error("The balance snapshot does not match the completed sync.");
      return lens;
    },
    retry: 1,
  });
  const valid = query.data?.runId === runId && !query.isError;
  const accounts = valid ? query.data?.accounts?.filter((account) => account.isInvestable) ?? [] : [];
  return <>
    <QueryReadStatus label={t("核对账户金额", "Balance check")} failed={!query.isPending && !valid}
      ready={valid && accounts.length > 0} error={query.error} />
    {query.isPending ? <Pending /> : !valid ? <QueryError retry={query.refetch} error={query.error} />
      : <div className="flex flex-col gap-mx-md">
        <p className="text-[0.8125rem] leading-[1.45]">{t("请对照 Trading 212，确认下面的账户价值合理。", "Compare these account values with Trading 212 before continuing.")}</p>
        {accounts.map((account) => <div key={account.code} className="flex flex-wrap items-center justify-between gap-mx-md"><p className="text-[0.9375rem] leading-[1.55]">{account.code === "A" ? "Invest" : "ISA"}</p><p className="text-[0.9375rem] leading-[1.55] font-semibold tabular-nums">{currency(account.totalValueGbp, "GBP", 2)}</p></div>)}
        <p className="text-xs leading-[1.4] text-muted-foreground">{t("按 GBP 统一展示；外币账户需对照折算后的金额。", "Values are shown in GBP; compare converted values for foreign-currency accounts.")}</p>
        <Checkbox label={t("我已核对，账户价值合理", "I have checked that the account values are plausible")} checked={checked} disabled={disabled} onCheckedChange={(checked) => setChecked(checked)} />
        <div className="flex flex-wrap items-center gap-mx-md">
          <Button
            type="button"
            aria-describedby={errorId}
            loading={busy}
            loadingLabel={t("保存中…", "Saving…")}
            disabled={disabled || !checked || !accounts.length}
            onClick={() => onConfirm(runId)}
          >
            {t("完成设置", "Finish setup")}
          </Button>
        </div>
      </div>}
  </>;
}
