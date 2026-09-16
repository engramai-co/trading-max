"use client";

import { Button, Drawer, Group, Select, Stack } from "@mantine/core";
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  Clock,
  Pulse,
  WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import {
  deriveHealthTone,
  durationBetween,
  formatAge,
  shortRunId,
} from "@/lib/health";
import type { HealthDetails, RefreshJob } from "@/lib/types";
import { api, ApiError, jsonRequest, number } from "./data";
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
  Tag,
  useCopy,
} from "./foundation";

export function HealthWorkspace() {
  const t = useCopy();
  const { locale } = useLocale();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["workspace-health"],
    queryFn: () => api<HealthDetails>("/health/details"),
    refetchInterval: 5000,
    retry: 1,
  });
  const [scope, setScope] = useState<RefreshJob["scope"]>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const start = useMutation({
    mutationFn: () =>
      api<RefreshJob>(
        "/refresh",
        jsonRequest("POST", { scope, skipSync: false, tickers: [] }),
      ),
    onSuccess: (job) => {
      setSelected(job.jobId);
      void query.refetch();
      void client.invalidateQueries({ queryKey: ["dashboard-lens", "latest"] });
    },
  });
  const data = query.data;
  const latestRunId = data?.health?.latestRunId;
  useEffect(() => {
    if (latestRunId) {
      void client.invalidateQueries({ queryKey: ["dashboard-lens", "latest"] });
      void client.invalidateQueries({ queryKey: ["workspace-research"] });
      void client.invalidateQueries({ queryKey: ["workspace-research-shell"] });
    }
  }, [client, latestRunId]);
  const tone = deriveHealthTone(data ?? null);
  const job =
    data?.jobs.find((j) => j.jobId === selected) ??
    (start.data?.jobId === selected ? start.data : null);
  const queued = data?.health?.queue.queued ?? 0;
  const running = data?.health?.queue.running ?? 0;
  const worker = data?.health?.worker ?? data?.readiness?.worker;
  const scopes = [
    { value: "all", label: t("账户、流水与研究", "Accounts, history & research") },
    { value: "accounts", label: t("账户与流水", "Accounts & history") },
    { value: "research", label: t("证券研究", "Research") },
    { value: "live", label: t("最新账户状态", "Latest account state") },
    { value: "intraday", label: t("日内走势", "Intraday history") },
    { value: "performance", label: t("收益与风险", "Performance") },
    { value: "cfd", label: t("CFD 复盘", "CFD review") },
  ];
  const title =
    tone === "ready"
      ? t("数据服务运行正常", "Your data service is ready")
      : tone === "running"
        ? t("正在更新你的数据", "Your data is updating")
        : tone === "unavailable"
          ? t("需要启动本地服务", "Start your local service")
          : t("数据服务需要检查", "The data service needs attention");
  const subtitle =
    tone === "ready"
      ? null
      : tone === "running"
        ? t(
            "更新完成前，仍可查看上一次成功发布的快照。",
            "Your last successfully published snapshot stays available while the update runs.",
          )
        : t(
            "查看下面的服务状态和任务详情，定位未完成的步骤。",
            "Check the service status and task details below to find the unfinished step.",
          );
  return (
    <Page
      title={t("数据状态", "Data status")}
      actions={
        <Button
          variant="default"
          leftSection={<ArrowClockwise size={16} />}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t("重新检查", "Check now")}
        </Button>
      }
    >
      {query.isPending ? (
        <Pending />
      ) : query.isError || !data ? (
        <QueryError retry={query.refetch} />
      ) : (
        <>
          <section
            className={
              "mx-health-hero" + (tone === "ready" ? " mx-health-ready" : "")
            }
          >
            <div className="mx-health-symbol">
              {tone === "ready" ? (
                <CheckCircle size={35} />
              ) : tone === "running" ? (
                <Pulse size={35} />
              ) : (
                <WarningCircle size={35} />
              )}
            </div>
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
              <Freshness
                date={data.checkedAt}
                label={t("检查时间", "Checked")}
              />
            </div>
            <Tag tone={tone === "ready" ? "good" : "warn"}>
              {tone === "ready"
                ? t("就绪", "Ready")
                : tone === "running"
                  ? t("更新中", "Updating")
                  : t("待检查", "Needs attention")}
            </Tag>
          </section>
          <div className="mx-grid-two">
            <Panel
              title={t("更新数据", "Update data")}
            >
              <Stack gap="md">
                <Select
                  label={t("更新范围", "Update scope")}
                  value={scope}
                  onChange={(v) => setScope(v as RefreshJob["scope"])}
                  data={scopes}
                  disabled={start.isPending}
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
                <Group>
                  <Button
                    leftSection={<ArrowClockwise size={16} />}
                    loading={start.isPending}
                    disabled={!data.health}
                    onClick={() => start.mutate()}
                  >
                    {t("开始更新", "Start update")}
                  </Button>
                  <Button
                    component={Link}
                    href="/settings?tab=automation"
                    variant="subtle"
                    rightSection={<ArrowRight size={15} />}
                  >
                    {t("管理更新计划", "Manage schedule")}
                  </Button>
                </Group>
              </Stack>
            </Panel>
            <Panel title={t("服务与快照", "Service & snapshot")}>
              <Facts
                rows={[
                  [
                    t("账户数据服务", "Account data service"),
                    <Tag
                      key="api"
                      tone={data.health?.status === "ok" ? "good" : "warn"}
                    >
                      {data.health
                        ? t("可访问", "Reachable")
                        : t("无法访问", "Unreachable")}
                    </Tag>,
                  ],
                  [
                    t("任务执行服务", "Task worker"),
                    <Tag key="worker" tone={worker?.healthy ? "good" : "warn"}>
                      {worker?.healthy
                        ? t("在线", "Online")
                        : t("未就绪", "Not ready")}
                    </Tag>,
                  ],
                  [
                    t("最新快照", "Latest snapshot"),
                    shortRunId(data.health?.latestRunId),
                  ],
                  [
                    t("快照生成距今", "Snapshot age"),
                    formatAge(data.health?.artifactAgeSeconds, locale),
                  ],
                  [
                    t("最近成功更新", "Last successful update"),
                    <Freshness
                      key="last"
                      date={data.health?.queue.last_success_at}
                      label=""
                    />,
                  ],
                ]}
              />
              {data.health?.bootstrapError && (
                <Notice tone="bad">{data.health.bootstrapError}</Notice>
              )}
              {data.errors.length > 0 && (
                <Notice tone="warn">
                  {t("部分状态未能读取：", "Some status checks failed: ")}
                  {data.errors
                    .map(
                      (e) =>
                        e.scope + (e.status ? " (HTTP " + e.status + ")" : ""),
                    )
                    .join(" · ")}
                </Notice>
              )}
            </Panel>
          </div>
          <Panel title={t("下一次自动更新", "Next scheduled updates")}>
            <Facts
              rows={(
                [
                  [t("账户、流水与研究", "Accounts, history & research"), data.refresh?.nightly],
                  [t("日内采样", "Intraday sampling"), data.refresh?.intraday],
                  [t("账户状态", "Account state"), data.refresh?.live],
                  [t("绩效计算", "Performance"), data.refresh?.performance],
                  [t("证券研究", "Research"), data.refresh?.research],
                ] as const
              ).map(([label, schedule]) => [
                label,
                !schedule ? (
                  "—"
                ) : !schedule.enabled ? (
                  t("已关闭", "Disabled")
                ) : (
                  <Freshness key={label} date={schedule.nextRunAt} label="" />
                ),
              ])}
            />
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
                ]}
              />
            </details>
          </Panel>
          <Panel
            title={t("更新记录", "Update history")}
            action={
              <Select
                aria-label={t("筛选任务状态", "Filter task status")}
                value={filter}
                onChange={(v) => setFilter(v ?? "all")}
                data={[
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
            }
          >
            <div className="mx-metric-grid mx-metric-grid-three">
              <Metric
                label={t("等待执行", "In queue")}
                value={number(queued, 0)}
              />
              <Metric
                label={t("正在执行", "Running")}
                value={number(running, 0)}
              />
              <Metric
                label={t("已成功完成", "Succeeded")}
                value={number(data.health?.queue.succeeded, 0)}
              />
            </div>
            {data.jobs.filter((j) => filter === "all" || j.status === filter)
              .length ? (
              <div className="mx-job-list">
                {data.jobs
                  .filter((j) => filter === "all" || j.status === filter)
                  .map((j) => (
                    <button
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
                          <CheckCircle size={22} />
                        ) : j.status === "failed" ? (
                          <WarningCircle size={22} />
                        ) : (
                          <Clock size={22} />
                        )}
                      </span>
                      <span className="mx-job-name">
                        <strong>
                          {scopes.find((s) => s.value === j.scope)?.label ??
                            j.scope}
                        </strong>
                        <Freshness date={j.createdAt} label="" />
                      </span>
                      <span className="mx-job-duration">
                        {durationBetween(j.startedAt, j.finishedAt, locale)}
                      </span>
                      <Tag tone={statusTone(j.status)}>
                        {statusText(j.status, t)}
                      </Tag>
                      <ArrowRight size={17} />
                    </button>
                  ))}
              </div>
            ) : (
              <Empty
                title={
                  data.jobs.length
                    ? t("没有符合筛选的任务", "No matching tasks")
                    : t(
                        "第一次更新，从这里开始",
                        "Your first update starts here",
                      )
                }
                description={t(
                  "连接账户后，选择更新范围并开始更新。",
                  "Connect an account, choose a scope, and start an update.",
                )}
              />
            )}
          </Panel>
        </>
      )}
      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={t("更新任务详情", "Update task details")}
        position="right"
        size={520}
      >
        {job && (
          <Stack gap="lg">
            <Group justify="space-between">
              <h3>{scopes.find((s) => s.value === job.scope)?.label}</h3>
              <Tag tone={statusTone(job.status)}>
                {statusText(job.status, t)}
              </Tag>
            </Group>
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
                  t("生成快照", "Published snapshot"),
                  shortRunId(job.snapshotRunId),
                ],
              ]}
            />
            {job.error && <Notice tone="bad">{job.error}</Notice>}
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
                      <CheckCircle size={20} />
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
                    {stage.error && <Notice tone="bad">{stage.error}</Notice>}
                  </div>
                </li>
              ))}
            </ol>
            {!job.stages.length && (
              <Notice>
                {t(
                  "任务已排队，执行后将显示各阶段进度。",
                  "The task is queued. Stages appear when execution begins.",
                )}
              </Notice>
            )}
            {(job.status === "failed" || job.status === "interrupted") && (
              <Button
                variant="default"
                onClick={() => {
                  setScope(job.scope);
                  setSelected(null);
                }}
              >
                {t(
                  "使用相同范围重新准备更新",
                  "Prepare another update with this scope",
                )}
              </Button>
            )}
          </Stack>
        )}
      </Drawer>
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
      "Reconcile balances and positions",
    ),
    "reference.security_master": t(
      "识别证券与市场分类",
      "Identify securities and market classifications",
    ),
    "portfolio.lookthrough": t(
      "展开基金底层资产",
      "Resolve underlying fund exposure",
    ),
    "accounts.diluted_cost": t(
      "计算持仓摊薄成本",
      "Calculate diluted position cost",
    ),
    "accounts.policy": t("分析账户配置", "Analyze account allocation"),
    "accounts.capital_recovery": t(
      "核对现金回收",
      "Reconcile recovered capital",
    ),
    "accounts.intraday_nav": t("更新日内账户估值", "Update intraday account valuations"),
    "accounts.nav": t("更新账户净值历史", "Update account value history"),
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
    "research.taxonomy": t("整理研究分类", "Organize research classifications"),
    "research.technical": t("更新技术研究", "Update technical research"),
    "research.options": t("更新期权研究", "Update options research"),
    "research.adr": t("更新 ADR 研究", "Update ADR research"),
    "research.fundamentals": t("更新基本面研究", "Update fundamentals"),
    "research.financials": t("更新财务报表", "Update financial statements"),
    "research.analyst": t("更新分析师共识", "Update analyst consensus"),
    "research.valuation": t("更新估值模型", "Update valuation models"),
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
