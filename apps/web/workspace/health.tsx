"use client";

import { WorkspaceSheet } from "./overlay";
import {
  Activity,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock,
  RotateCw,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "./link";
import { Fragment, useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  deriveHealthDecision,
  durationBetween,
  flowVerificationText,
  formatAge,
  shortRunId,
  type HealthLocale,
} from "@/lib/health";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { HealthDetails, RefreshJob } from "@/lib/types";
import { formatDateTime } from "@/ui/formatters";
import { api, ApiError, isReadTimeout, jsonRequest, number } from "@/workspace/data";
import {
  Empty,
  Facts,
  Freshness,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  StatusMessage,
  Tag,
  useCopy,
} from "./foundation";

import { useOptionalAssistant } from "./assistant/context";
import { PageInspection } from "./assistant/inspection-entry";
import { useSearchParams } from "next/navigation";
import { DemoAsOf } from "./demonstration";
import { collapseRoutineRuns } from "./job-history";
import { JobOutcomeSummary } from "./job-outcomes";
import { SelectPicker } from "./picker";

export function HealthWorkspace({ localWorkspace = false, desktop = false, initialScope = "all", readOnly = false }: { localWorkspace?: boolean; desktop?: boolean; initialScope?: RefreshJob["scope"]; readOnly?: boolean }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const query = useQuery({
    queryKey: ["workspace-health"],
    queryFn: ({ signal }) => api<HealthDetails>("/health/details", { signal }),
    refetchInterval: 5000,
    retry: 1,
  });
  const demoSnapshot = useDashboardLens("overview", undefined, readOnly, { detail: "summary" });
  const [scope, setScope] = useState<RefreshJob["scope"]>(initialScope);
  const assistantReady = useOptionalAssistant()?.ready ?? false;
  const params=useSearchParams();
  const [selected, setSelected] = useState<string | null>(()=>params?.get("job") ?? null);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [everyRun, setEveryRun] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(initialScope !== "all");
  const start = useMutation({
    mutationFn: () =>
      api<RefreshJob>(
        "/refresh",
        jsonRequest("POST", { scope, skipSync: false, tickers: [] }),
      ),
    onSuccess: (job) => {
      setSelected(job.jobId);
      void query.refetch();
    },
  });
  const Controls = desktop ? "details" : Fragment;
  const Actions = desktop ? "div" : Fragment;
  const controlsProps = desktop ? { className: "mx-activity-controls", open: controlsOpen, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setControlsOpen(event.currentTarget.open) } : {};
  const [manualChecking, setManualChecking] = useState(false);
  const manualCheckingRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const lastSemanticKeyRef = useRef<string | null>(null);
  const scopes = [
    { value: "all", label: t("账户、流水与研究", "Accounts, history & research") },
    { value: "accounts", label: t("账户与流水", "Accounts & history") },
    { value: "research", label: t("研究", "Research") },
    { value: "live", label: t("最新账户状态", "Latest account state") },
    { value: "intraday", label: t("日内走势", "Intraday history") },
    { value: "performance", label: t("收益与风险", "Performance") },
    { value: "cfd", label: t("CFD 复盘", "CFD review") },
  ];
  const scopeLabel = (value: string) => scopes.find((item) => item.value === value)?.label ?? value;
  const data = query.data;
  const viewOptions = { localWorkspace, readOnly, locale, t, scopeLabel };
  const statusView = summarizeHealthView(data, query.error, viewOptions);
  const { semanticKey, liveMessage } = statusView;
  useEffect(() => {
    if (!semanticKey || manualCheckingRef.current) return;
    const previous = lastSemanticKeyRef.current;
    lastSemanticKeyRef.current = semanticKey;
    if (previous !== semanticKey && (previous || query.isError || statusView.stale || statusView.tone === "degraded" || statusView.tone === "unavailable")) {
      setAnnouncement(liveMessage);
    }
  }, [semanticKey, liveMessage, query.isError, statusView.stale, statusView.tone]);

  async function runManualCheck() {
    if (manualCheckingRef.current) return;
    manualCheckingRef.current = true;
    setManualChecking(true);
    setAnnouncement(t("正在检查数据状态…", "Checking data status…"));
    try {
      const result = await query.refetch();
      const next = summarizeHealthView(result.data, result.error, viewOptions);
      lastSemanticKeyRef.current = next.semanticKey ?? null;
      const prefix = result.isError
        ? t("检查未完成：", "Check failed: ")
        : t("检查完成：", "Check complete: ");
      setAnnouncement(prefix + next.liveMessage);
    } finally {
      manualCheckingRef.current = false;
      setManualChecking(false);
    }
  }
  const {
    latestRunId, failures, tone, snapshot, stale, queued, running, worker, apiReachable,
    bootstrapIssue, readinessIssue, serviceIssue, serviceErrors, scheduleUnavailable, showStaleHeadline,
    jobsUnavailable, lastSuccess, snapshotTime, title, subtitle,
  } = statusView;
  const job =
    data?.jobs.find((j) => j.jobId === selected) ?? failures.find((j) => j.jobId === selected) ??
    (start.data?.jobId === selected ? start.data : null);
  const currentStage = job?.stages.find((stage) => stage.status === "running");
  const drawerStatus = query.isError ? liveMessage : job && [
    statusText(job.status, t),
    currentStage && stageText(currentStage.name, t),
    job.stages.length > 0 ? `${job.stages.filter((stage) => ["succeeded", "skipped"].includes(stage.status)).length} / ${job.stages.length}` : null,
  ].filter(Boolean).join(" · ");
  const lastFailed = failures[0];
  const heroIssue = tone === "degraded" && lastFailed ? lastFailed.jobId : stale ? "stale" : null;
  function why(issue: string, label: string, location: string) {
    if (!assistantReady || readOnly) return null;
    const key = location + issue;
    return <div className="mx-inspection-anchor"><button type="button" className="mx-why" aria-expanded={diagnosis===key}
      onClick={() => setDiagnosis(diagnosis===key ? null : key)}>✦ {t("为什么","Why")}</button>
      {diagnosis===key && <PageInspection role="diagnosis" object={label} snapshotId={latestRunId ?? undefined}
        anchored context={issue==="stale" ? {issue:"stale"} : {issue:"job",job:issue}} onClose={() => setDiagnosis(null)}/>}</div>;
  }
  const schedule = data && (
    <Panel title={t("下一次自动更新", "Next scheduled updates")}
      description={t("运行服务的设备需要保持开机，且任务服务正在运行。", "Scheduled updates run while the host device and its worker are running.")}>
      {scheduleUnavailable ? (
        <Notice tone="warn">{t("暂时无法读取更新计划。", "Scheduled updates are temporarily unavailable.")}</Notice>
      ) : (
        <Facts
          rows={(
            [
              [t("账户、流水与研究", "Accounts, history & research"), data.refresh?.nightly],
              [t("日内采样", "Intraday sampling"), data.refresh?.intraday],
              [t("账户状态", "Account state"), data.refresh?.live],
              [t("收益与风险", "Performance"), data.refresh?.performance],
              [t("研究", "Research"), data.refresh?.research],
              [t("板块行情", "Sector quotes"), data.refresh?.sectors],
            ] as const
          ).map(([label, schedule]) => [
            label,
            !schedule ? (
              "—"
            ) : !schedule.enabled ? (
              <span key={label} className="mx-muted">{t("未启用", "Disabled")}</span>
            ) : schedule.nextRunAt ? (
              formatDateTime(schedule.nextRunAt, locale, timeZone)
            ) : (
              "—"
            ),
          ])}
        />
      )}
      {Boolean(data.health?.eventRefreshes?.length) && (
        <details className="mx-chart-data" open={statusView.eventFailures.length > 0}>
          <summary>{t("新闻与日历数据时间", "News and calendar freshness")}</summary>
          <Facts rows={(data.health?.eventRefreshes ?? []).map((source) => [
            eventSourceLabel(source.kind, t),
            <div key={source.kind} className="flex flex-wrap items-center gap-mx-xs">
              {source.asOf ? formatDateTime(source.asOf, locale, timeZone) : t("暂无数据", "No observations")}
              {source.failedSources > 0 && <Tag tone="warn">{sourceFailureLabel(source.failedSources, t)}</Tag>}
            </div>,
          ])} />
          {(data.health?.eventRefreshes ?? []).flatMap((source) => (source.failures ?? []).map((failure) => (
            <div key={source.kind + failure.source} className="mx-health-source-failure">
              <span>{failure.source}</span>
              {failure.checkedAt && <small><span>{t("上次尝试", "Last attempt")}</span> {formatDateTime(failure.checkedAt, locale, timeZone)}</small>}
            </div>
          )))}
        </details>
      )}
      <details className="mx-chart-data">
        <summary>{t("更新范围说明", "What each schedule updates")}</summary>
        <ul className="mx-review-prerequisites">
          <li>{t("账户状态与日内采样：在活动时段刷新余额、持仓并保存日内观测点。", "Account state and intraday sampling: refresh balances and positions and record intraday readings during the active window.")}</li>
          <li>{t("绩效：使用已核对的账户历史计算收益、回撤和风险。", "Performance: calculate returns, drawdowns and risk from reconciled account history.")}</li>
          <li>{t("研究、板块与每日对账：更新研究资料，在交易时段采集板块行情，并每日核对账户流水。", "Research, sectors and daily reconciliation: update research, collect sector quotes during market hours and reconcile account transactions daily.")}</li>
        </ul>
      </details>
      <details className="mx-chart-data">
        <summary>{t("运行诊断详情", "Runtime diagnostics")}</summary>
        <Facts
          rows={[
            [t("工作进程主机", "Worker host"), worker?.host ?? "—"],
            [t("进程 ID", "Process ID"), number(worker?.pid, 0)],
            [
              t("工作进程版本", "Worker version"),
              worker?.worker_version ?? "—",
            ],
            [
              t("最近心跳", "Last heartbeat"),
              <Freshness
                key="heartbeat"
                date={worker?.last_seen_at}
                label=""
              />,
            ],
            [
              t("写入身份验证", "Write authentication"),
              data.health == null
                ? "—"
                : data.health.writeAuthEnabled
                  ? t("已启用", "Enabled")
                  : t("未启用", "Disabled"),
            ],
            [
              t("出入金记录覆盖", "Deposit and withdrawal coverage"),
              flowVerificationText(data.refresh?.live ?? data.refresh?.intraday, locale),
            ],
            [
              t("覆盖检查快照", "Coverage snapshot"),
              shortRunId((data.refresh?.live ?? data.refresh?.intraday)?.flowSnapshotRunId),
            ],
          ]}
        />
        <p>
          {t(
            "统计当前快照中保留的估值点，不是历史更新任务数；出入金覆盖不等于时间加权收益已验证。",
            "Counts retained valuations in the current snapshot, not past update jobs. Deposit and withdrawal coverage does not certify time-weighted returns.",
          )}
        </p>
      </details>
    </Panel>
  );
  return (
    <Page
      title={t("数据状态", "Data status")}
      description={readOnly ? t("这是只读演示，展示示例资料，不会执行账户更新。", "This read-only demo displays synthetic records and does not run account updates.") : undefined}
      className={desktop ? "mx-health-page mx-activity-page" : "mx-health-page"}
      actions={
        <Actions {...(desktop ? { className: "flex flex-wrap items-center gap-mx-sm" } : {})}>{desktop && <Button variant="outline" onClick={() => setControlsOpen((open) => !open)}>{readOnly ? t("查看服务详情", "Service details") : t("更新数据", "Update data")}</Button>}<Button
          variant="outline"
          loading={manualChecking}
          loadingLabel={t("检查中…", "Checking…")}
          focusableWhenDisabled
          onClick={() => void runManualCheck()}
        >
          <RotateCw size={16} aria-hidden="true" />
          {t("重新检查", "Check now")}
        </Button></Actions>
      }
    >
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {query.isPending ? (
        <Pending />
      ) : query.isError || !data ? (
        <QueryError error={query.error} showDataStatusLink={false} />
      ) : (
        <>
          <section
            className={
              "mx-health-hero" + (tone === "ready" && !stale ? " mx-health-ready" : "")
            }
          >
            <div className="mx-health-symbol">
              {tone === "running" ? (
                <Activity aria-hidden="true" size={20} />
              ) : showStaleHeadline ? (
                <Clock aria-hidden="true" size={20} />
              ) : tone === "ready" ? (
                <CircleCheck aria-hidden="true" size={20} />
              ) : tone === "setup" ? (
                <Clock aria-hidden="true" size={20} />
              ) : (
                <CircleAlert aria-hidden="true" size={20} />
              )}
            </div>
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
              {readOnly && tone === "ready" ? (
                <DemoAsOf date={demoSnapshot.data?.brokerAsOf} />
              ) : snapshotTime ? (
                <Freshness date={snapshotTime} label={t("已发布快照", "Published snapshot")} />
              ) : serviceIssue || !lastSuccess ? (
                <Freshness date={data.checkedAt} label={t("检查时间", "Checked")} />
              ) : (
                <Freshness date={lastSuccess} label={t("最近成功更新", "Last successful update")} />
              )}
            </div>
            {heroIssue && why(heroIssue,heroIssue==="stale" ? t("快照未更新","Stale snapshot") : scopes.find(item=>item.value===lastFailed.scope)?.label ?? t("更新失败","Update failure"),"hero:")}
            {!diagnosis && <PageInspection role="diagnosis" object={t("数据状态","Data status")} />}
            {/* Ready and fresh is the normal state: the heading says it, no tag repeats it. */}
            {!(tone === "ready" && !stale) && (
              <Tag tone={tone === "setup" ? "neutral" : "warn"}>
                {stale && tone === "running"
                  ? t("更新中 · 数据未更新", "Updating · stale")
                  : stale
                  ? t("数据未更新", "Not updated")
                  : tone === "setup"
                  ? t("待设置", "Setup needed")
                  : tone === "running"
                    ? t("更新中", "Updating")
                    : t("需要关注", "Needs attention")}
              </Tag>
            )}
          </section>
          {!readOnly && failures.length > 0 && <Notice tone="warn">
            <div className="mx-toolbar">
              <span>
                {t("需要检查的范围：", "Scopes needing attention: ")}
                {failures.map((job) => scopeLabel(job.scope)).join(" · ")}
              </span>
              {failures.length === 1 ? (
                <Button variant="ghost" onClick={() => setSelected(failures[0].jobId)}>
                  {t("查看原因", "View issue")}
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-mx-xs">
                  {failures.map((item) => (
                    <Button key={item.jobId} variant="ghost" onClick={() => setSelected(item.jobId)}>
                      {t("查看", "View ")}{scopeLabel(item.scope)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </Notice>}
          <Controls {...controlsProps}>
          {desktop && <summary>{t("更新范围、服务与计划", "Update scope, service & schedule")}</summary>}
          <div className="mx-grid-two">
            <Panel
              title={t("更新数据", "Update data")}
            >
              <div className="flex flex-col gap-mx-md">
                {tone === "setup" ? <>
                  <Notice>{desktop && initialScope === "cfd" ? t("CSV 已保存。请先完成账户的首次同步，再更新 CFD 复盘，以便核对账户间的转账。", "Your CSV is saved. Complete the first account sync before updating CFD review so transfers between accounts can be reconciled.") : t("从账户连接开始；首次同步完成后再核对金额。", "Start by connecting an account, then check balances after the first sync.")}</Notice>
                  <div className="flex flex-wrap items-center gap-mx-md"><Link href="/settings?tab=accounts&onboarding=1" data-slot="button" className={buttonVariants()}>{t("继续设置账户", "Continue account setup")}</Link></div>
                </> : <>
                <SelectPicker
                  label={t("更新范围", "Update scope")}
                  value={scope}
                  onChange={(v) => setScope(v as RefreshJob["scope"])}
                  options={scopes}
                  disabled={start.isPending || queued > 0 || running > 0}
                />
                {start.isError && (
                  <Notice tone="bad">
                    {start.error instanceof ApiError &&
                    start.error.status === 409
                      ? t(
                          "已有相关更新在排队或执行。请在更新记录中查看进度。",
                          "A related update is already queued or running. Open its task history to see progress.",
                        )
                      : t(
                          "任务未能提交。请检查服务与账户连接后重试。",
                          "The task could not be submitted. Check the service and account connections, then retry.",
                        )}
                  </Notice>
                )}
                {start.isSuccess && (
                  <Notice tone="good">
                    {t(
                      "任务已加入队列，可在更新记录中查看进度。",
                      "Task queued. Follow its progress in update history.",
                    )}
                  </Notice>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    loading={start.isPending}
                    loadingLabel={t("正在开始…", "Starting…")}
                    disabled={readOnly || !data.health || queued > 0 || running > 0}
                    onClick={() => start.mutate()}
                  >
                    <RotateCw size={16} aria-hidden="true" />
                    {queued > 0 || running > 0 ? t("更新进行中", "Update in progress") : t("开始更新", "Start update")}
                  </Button>
                  <Link
                    href="/settings?tab=automation"
                    data-slot="button"
                    className={buttonVariants({ variant: "ghost" })}
                  >
                    {t("管理更新计划", "Manage schedule")}
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </div>
                </>}
              </div>
            </Panel>
            {serviceIssue ? (
              <Panel title={t("服务与快照", "Service & snapshot")}>
                <Facts
                  rows={[
                    ...(apiReachable
                      ? []
                      : [[t("账户数据服务", "Account data service"), <Tag key="api" tone="warn">{t("无法访问", "Unreachable")}</Tag>] as [string, React.ReactNode]]),
                    ...(readinessIssue && worker?.healthy
                      ? [[t("数据就绪状态", "Data readiness"), <Tag key="readiness" tone="warn">{t("未就绪", "Not ready")}</Tag>] as [string, React.ReactNode]]
                      : []),
                    ...(worker?.healthy
                      ? []
                      : [[t("任务执行服务", "Task worker"), <Tag key="worker" tone="warn">{t("未就绪", "Not ready")}</Tag>] as [string, React.ReactNode]]),
                    [
                      t("最近成功更新", "Last successful update"),
                      <Freshness
                        key="last"
                        date={lastSuccess}
                        label=""
                      />,
                    ],
                  ]}
                />
                {bootstrapIssue && (
                  <Notice tone="bad"><code className="mx-diagnostic-code">{bootstrapIssue}</code></Notice>
                )}
                {serviceErrors.length > 0 && (
                  <Notice tone="warn">
                    {t("暂时无法读取服务状态。", "Service status is temporarily unavailable.")}
                    <code className="mx-diagnostic-code">{serviceErrors.map((error) => error.detail).join("\n")}</code>
                  </Notice>
                )}
              </Panel>
            ) : (
              schedule
            )}
          </div>
          {serviceIssue && schedule}
          </Controls>
          <Panel
            title={t("更新记录", "Update history")}
            action={
              jobsUnavailable ? undefined : (
                <SelectPicker
                  className="phone:w-[180px]"
                  aria-label={t("筛选任务状态", "Filter task status")}
                  value={filter}
                  onChange={(v) => setFilter(v ?? "all")}
                  options={[
                    { value: "all", label: t("全部状态", "All statuses") },
                    ...[
                      "queued",
                      "running",
                      "succeeded",
                      "failed",
                      "interrupted",
                    ].map((value) => ({ value, label: statusText(value, t) })),
                  ]}
                />
              )
            }
          >
            {!desktop && (queued > 0 || running > 0) && <div className="mx-metric-grid mx-metric-grid-three">
              <Metric
                label={t("等待执行", "In queue")}
                value={number(queued, 0)}
              />
              <Metric
                label={t("执行中", "Running")}
                value={number(running, 0)}
              />
            </div>}
            <JobOutcomeSummary outcomes={data.outcomes} scopeLabel={scopeLabel} />
            {jobsUnavailable ? (
              <Notice tone="warn">{t("暂时无法读取更新记录。", "Update history is temporarily unavailable.")}</Notice>
            ) : data.jobs.filter((j) => filter === "all" || j.status === filter).length ? (<>
              <div className="mx-job-list">
                {(filter === "all" && !everyRun
                  ? collapseRoutineRuns(data.jobs)
                  : data.jobs.filter((j) => filter === "all" || j.status === filter).map((job) => ({ job, repeats: 0 }))
                ).map(({ job: j, repeats }) => {
                  const row = <button
                      className="mx-job-row"
                      key={j.jobId}
                      onClick={() => setSelected(j.jobId)}
                    >
                      <span
                        className={
                          "mx-job-icon mx-" +
                          (j.status === "failed" || j.status === "interrupted"
                            ? "down"
                            : "up")
                        }
                      >
                        {j.status === "succeeded" ? (
                          <CircleCheck aria-hidden="true" size={20} />
                        ) : j.status === "failed" ? (
                          <CircleAlert aria-hidden="true" size={20} />
                        ) : (
                          <Clock aria-hidden="true" size={20} />
                        )}
                      </span>
                      <span className="mx-job-name">
                        <strong>
                          {scopes.find((s) => s.value === j.scope)?.label ??
                            j.scope}
                        </strong>
                        <span className="mx-job-meta">
                          <Freshness date={j.createdAt} label="" />
                          {repeats > 0 && <small>{locale === "zh" ? `更早 ${repeats} 次成功` : `${repeats} earlier successes`}</small>}
                        </span>
                      </span>
                      <span className="mx-job-duration">
                        {durationBetween(j.startedAt, j.finishedAt, locale)}
                      </span>
                      {j.status === "succeeded" ? (
                        <span className="sr-only">{statusText(j.status, t)}</span>
                      ) : (
                        <Tag tone={statusTone(j.status)}>
                          {statusText(j.status, t)}
                        </Tag>
                      )}
                      <ArrowRight aria-hidden="true" size={18} />
                    </button>;
                  return assistantReady && !readOnly && ["failed","interrupted"].includes(j.status)
                    ? <div className="mx-job-with-why" key={j.jobId}>{row}{why(j.jobId,scopes.find(item=>item.value===j.scope)?.label ?? j.scope,"history:")}</div> : row;
                })}
              </div>
              {filter === "all" && data.jobs.some((j) => j.status === "succeeded") && (
                <Button variant="ghost" className="mt-mx-sm" onClick={() => setEveryRun((value) => !value)}>
                  {everyRun ? t("合并重复的成功记录", "Combine repeated successes") : t("显示每一次更新", "Show every update")}
                </Button>
              )}
            </>) : (
              <Empty
                title={
                  data.jobs.length
                    ? t("没有符合筛选的任务", "No matching tasks")
                    : desktop && readOnly
                      ? t("演示不执行更新任务", "The demo does not run updates")
                      : snapshot === "setup"
                        ? t("完成设置后才会有记录", "Update history starts after setup")
                        : t("暂无更新任务记录", "No update jobs recorded")
                }
                description={data.jobs.length
                  ? t("选择其他状态查看任务。", "Choose another status to find updates.")
                  : readOnly
                    ? t("此处显示工作区采集的进度和结果。", "This list shows collection progress and results for your workspace.")
                    : snapshot === "published"
                      ? t("现有快照仍可查看。开始更新后，任务会显示在这里。", "The published snapshot remains available. New jobs will appear here after you start an update.")
                      : snapshot === "setup"
                        ? t("先在设置中连接账户，再开始首次同步。", "Connect an account in Settings to start your first sync.")
                        : t("在上方选择范围并开始更新；如果无法启动，请检查服务状态。", "Choose a scope and start an update above. If it cannot start, check the service status.")}
              />
            )}
          </Panel>
        </>
      )}
      <WorkspaceSheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={t("更新任务详情", "Update task details")}
        closeLabel={t("关闭任务详情", "Close task details")}
        width={520}
        className="mx-health-drawer"
      >
        <StatusMessage message={drawerStatus ?? undefined} />
        {query.isError && <Notice tone="warn">{liveMessage}</Notice>}
        {job && (
          <div className="mx-health-drawer-body flex flex-col gap-mx-lg">
            <div className="flex flex-wrap items-center justify-between gap-mx-md">
              <h3>{scopes.find((s) => s.value === job.scope)?.label}</h3>
              <Tag tone={statusTone(job.status)}>
                {statusText(job.status, t)}
              </Tag>
            </div>
            <Facts
              rows={[
                [
                  t("创建时间", "Created"),
                  <Freshness key="created" date={job.createdAt} label="" />,
                ],
                [
                  t("耗时", "Duration"),
                  durationBetween(job.startedAt, job.finishedAt, locale),
                ],
                [
                  t("已发布快照", "Published snapshot"),
                  shortRunId(job.snapshotRunId),
                ],
              ]}
            />
            {job.error && <Notice tone="bad"><code className="mx-diagnostic-code">{job.error}</code></Notice>}
            {job.status === "queued" && !worker?.healthy && (
              <Notice tone="warn">
                {t(
                  "任务执行服务尚未就绪，任务会保留在队列中。启动本地任务服务后可继续处理。",
                  "The task service is not ready. Your request remains queued and can proceed when the local task service starts.",
                )}
              </Notice>
            )}
            <ol className="mx-stage-list">
              {job.stages.map((stage, index) => (
                <li key={stage.name}>
                  <span
                    className={
                      "mx-stage-number" +
                      (stage.status === "succeeded" ? " mx-stage-complete" : "")
                    }
                  >
                    {stage.status === "succeeded" ? (
                      <CircleCheck aria-hidden="true" size={20} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div>
                    <div className="mx-toolbar">
                      <strong>{stageText(stage.name, t)}</strong>
                      <Tag tone={statusTone(stage.status)}>
                        {statusText(stage.status, t)}
                      </Tag>
                    </div>
                    {stage.startedAt && (
                      <p>
                        {durationBetween(
                          stage.startedAt,
                          stage.finishedAt,
                          locale,
                        )}
                      </p>
                    )}
                    {stage.error && <Notice tone="bad"><code className="mx-diagnostic-code">{stage.error}</code></Notice>}
                  </div>
                </li>
              ))}
            </ol>
            {!job.stages.length && (
              <Notice>
                {desktop && job.status !== "queued"
                  ? job.status === "running"
                    ? t("任务正在执行，尚无阶段进度。", "The task is running; no stage progress has been reported yet.")
                    : t("本次任务没有留下阶段记录，请以上方任务状态和错误信息为准。", "No stage details were recorded. Refer to the task status and any error above.")
                  : t(
                    "任务已排队，执行后将显示各阶段进度。",
                    "The task is queued. Stages appear when execution begins.",
                  )}
              </Notice>
            )}
            {(job.status === "failed" || job.status === "interrupted") && (
              <Button
                variant="secondary"
                className="h-auto py-2 whitespace-normal text-center"
                onClick={() => {
                  setScope(job.scope);
                  setControlsOpen(true);
                  setSelected(null);
                }}
              >
                {t(
                  "使用相同范围重新准备更新",
                  "Prepare another update with this scope",
                )}
              </Button>
            )}
          </div>
        )}
      </WorkspaceSheet>
    </Page>
  );
}
function stageText(
  name: string,
  t: (zh: string, en: string) => string,
) {
  const labels: Record<string, string> = {
    "broker.sync": t("读取券商账户与流水", "Read broker accounts and history"),
    "accounts.snapshot": t(
      "核对账户余额与持仓",
      "Reconcile balances and holdings",
    ),
    "reference.security_master": t(
      "识别代码与市场分类",
      "Identify tickers and market classifications",
    ),
    "portfolio.lookthrough": t(
      "展开基金底层持仓",
      "Resolve fund look-through",
    ),
    "accounts.diluted_cost": t(
      "计算持仓摊薄成本",
      "Calculate diluted holding cost",
    ),
    "accounts.policy": t("分析账户配置", "Analyse account allocation"),
    "accounts.capital_recovery": t(
      "核对现金回收",
      "Reconcile recovered capital",
    ),
    "accounts.intraday_nav": t("更新日内账户估值", "Update intraday account valuations"),
    "accounts.nav": t("更新账户价值历史", "Update account value history"),
    "accounts.cfd": t("整理 CFD 账本与复盘", "Build the CFD ledger and review"),
    "accounts.performance": t(
      "计算账户收益与风险",
      "Calculate returns and risk",
    ),
    "accounts.review": t(
      "生成账户历史复盘",
      "Build historical account reviews",
    ),
    "market.snapshot": t("读取市场行情", "Read market prices"),
    "research.taxonomy": t("整理研究分类", "Organise research classifications"),
    "research.technical": t("更新技术研究", "Update technical research"),
    "research.options": t("更新期权研究", "Update options research"),
    "research.adr": t("更新 ADR 研究", "Update ADR research"),
    "research.fundamentals": t("更新基本面研究", "Update fundamentals"),
    "research.financials": t("更新财务报表", "Update financial statements"),
    "research.analyst": t("更新分析师共识", "Update analyst consensus"),
    "research.valuation": t("更新估值模型", "Update valuation models"),
    "research.security_news": t("更新证券新闻", "Refresh security news"),
    "research.macro_calendar": t("更新宏观日历", "Refresh official macro calendars"),
    "research.earnings": t("更新盈利研究", "Update earnings research"),
    "snapshot.publish": t("发布完整数据快照", "Publish the completed snapshot"),
  };
  return labels[name] ?? t("更新数据", "Update data");
}
function statusTone(value: string) {
  return value === "succeeded"
    ? ("good" as const)
    : value === "failed" || value === "interrupted"
      ? ("bad" as const)
      : value === "running"
        ? ("warn" as const)
        : ("neutral" as const);
}
function statusText(value: string, t: (zh: string, en: string) => string) {
  return (
    {
      queued: t("排队中", "Queued"),
      running: t("执行中", "Running"),
      succeeded: t("已完成", "Complete"),
      failed: t("失败", "Failed"),
      interrupted: t("已中断", "Interrupted"),
      skipped: t("已跳过", "Skipped"),
    }[value] ?? value
  );
}

function eventSourceLabel(kind: "news" | "macro", t: (zh: string, en: string) => string) {
  return kind === "news" ? t("证券新闻", "Security news") : t("宏观日历", "Macro calendar");
}

function sourceFailureLabel(count: number, t: (zh: string, en: string) => string) {
  return count === 1 ? t("1 个来源更新失败", "1 source refresh failed")
    : t("{count} 个来源更新失败", "{count} source refreshes failed").replace("{count}", String(count));
}

function summarizeHealthView(
  data: HealthDetails | undefined,
  error: unknown,
  options: {
    localWorkspace: boolean;
    readOnly: boolean;
    locale: HealthLocale;
    t: (zh: string, en: string) => string;
    scopeLabel: (scope: string) => string;
  },
) {
  const { readOnly, locale, t, scopeLabel } = options;
  const decision = deriveHealthDecision(data, options);
  if (error) {
    const timeout = isReadTimeout(error);
    return {
      ...decision,
      title: "",
      subtitle: null,
      semanticKey: timeout ? "error:timeout" : "error:unavailable",
      showStaleHeadline: false,
      liveMessage: timeout
        ? t("数据请求超时", "Data request timed out")
        : t("暂时无法读取数据", "Data is temporarily unavailable"),
    };
  }
  const { tone, snapshot, stale, serviceHealthy, failures, eventFailures, scheduleUnavailable, jobsUnavailable, serviceErrors } = decision;
  const staleAge = formatAge(data?.health?.artifactAgeSeconds, locale);
  const showStaleHeadline = stale && serviceHealthy && !failures.length && !eventFailures.length && tone !== "running";
  const title = readOnly && tone === "ready" ? t("演示快照", "Demo snapshot")
    : tone === "setup" ? t("等待首次同步", "Awaiting first sync")
    : tone === "running" ? t("正在更新你的数据", "Your data is updating")
    : tone === "unavailable" ? t("需要启动本地服务", "Start your local service")
    : showStaleHeadline ? locale === "zh"
      ? `服务在线，但已 ${staleAge}没有完成更新`
      : `Service online · no completed update for ${staleAge}`
    : tone === "ready" ? t("数据服务运行正常", "Your data service is ready")
    : t("数据服务需要检查", "The data service needs attention");
  const subtitle = tone === "setup" ? t(
    "本地服务已经启动。连接账户并完成首次同步后，这里会显示记录和更新状态。",
    "Local services are running. Connect your account and complete the first sync to see records and update status here.",
  ) : stale && !showStaleHeadline ? locale === "zh"
    ? `最近一次已发布快照停留在 ${staleAge}前。`
    : `The last published snapshot is ${staleAge} old.` : tone === "running" ? snapshot === "published" ? t(
    "更新完成前，仍可查看上一次成功发布的快照。",
    "Your last successfully published snapshot stays available while the update runs.",
  ) : t(
    "正在准备首次账户数据。完成后即可查看资产与收益；请保持 App 打开和网络连接。",
    "Preparing your first account data. Investments and returns will appear when it finishes; keep the App open and connected.",
  ) : null;
  const liveParts = [title];
  if (!readOnly && failures.length > 0) {
    liveParts.push(t("需要检查的范围：", "Scopes needing attention: ") + failures.map((job) => scopeLabel(job.scope)).join(" · "));
  }
  for (const event of eventFailures) {
    const sources = event.failures?.map((failure) => failure.source).sort().join(", ");
    liveParts.push([eventSourceLabel(event.kind, t), sourceFailureLabel(event.failedSources, t), sources].filter(Boolean).join(" · "));
  }
  if (scheduleUnavailable) liveParts.push(t("暂时无法读取更新计划。", "Scheduled updates are temporarily unavailable."));
  if (jobsUnavailable) liveParts.push(t("暂时无法读取更新记录。", "Update history is temporarily unavailable."));
  if (serviceErrors.length > 0) liveParts.push(t("暂时无法读取服务状态。", "Service status is temporarily unavailable."));
  return { ...decision, title, subtitle, showStaleHeadline, liveMessage: liveParts.join(locale === "zh" ? " " : ". ") };
}
