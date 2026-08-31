"use client";

import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  ArrowRight,
  ChartLineUp,
  CheckCircle,
  Clock,
  Lightning,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useLocale, useMessages } from "@/components/locale-provider";
import {
  activeAccountJob,
  deriveHealthTone,
  durationBetween,
  formatAge,
  formatInterval,
  latestFullAccountJob,
  latestStage,
  shortRunId,
} from "@/lib/health";
import { healthDetailsQueryKey } from "@/lib/health-query";
import type { HealthDetails, RefreshJob } from "@/lib/types";
import {
  formatDateTime,
  formatScheduleTimes,
  formatTimeZoneLabel,
} from "@/ui/formatters";

async function fetchHealth() {
  const response = await fetch("/api/backend/health/details", { cache: "no-store" });
  if (!response.ok) throw new Error(`health details ${response.status}`);
  return response.json() as Promise<HealthDetails>;
}

export function SystemHealthDashboard() {
  const { locale, timeZone } = useLocale();
  const messages = useMessages();
  const router = useRouter();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryFn: fetchHealth,
    queryKey: healthDetailsQueryKey,
    refetchInterval: (query) => activeAccountJob(query.state.data ?? null) ? 2_000 : 15_000,
    refetchIntervalInBackground: false,
  });
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/backend/refresh", {
        body: JSON.stringify({ scope: "accounts", skipSync: false }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json() as { detail?: string; jobId?: string };
      if (!response.ok || !payload.jobId) {
        throw new Error(payload.detail || messages.pipeline.refreshStartFailed);
      }
      return payload.jobId;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: healthDetailsQueryKey });
      router.refresh();
    },
  });
  const details = healthQuery.data ?? null;
  const tone = deriveHealthTone(details);
  const fullJob = latestFullAccountJob(details);
  const activeJob = activeAccountJob(details);
  const stage = latestStage(activeJob ?? fullJob);
  const health = details?.health;
  const readiness = details?.readiness;
  const worker = health?.worker ?? readiness?.worker;
  const queue = health?.queue ?? readiness?.queue;
  const refresh = details?.refresh;
  const liveSchedule = refresh?.live ?? refresh?.intraday;
  const performanceSchedule = refresh?.performance;
  const researchSchedule = refresh?.research ?? refresh?.nightly;
  const zh = locale === "zh";
  const researchSourceTimes = researchSchedule?.localTimes?.length
    ? researchSchedule.localTimes
    : researchSchedule?.localTime
      ? [researchSchedule.localTime]
      : [];
  const researchDisplayTimes = researchSchedule
    ? formatScheduleTimes(
        researchSourceTimes,
        locale,
        researchSchedule.timezone,
        timeZone,
      ).join(" · ")
    : "";
  const displayTimeZoneLabel = formatTimeZoneLabel(timeZone, locale);
  const refreshFailed = fullJob?.status === "failed" || fullJob?.status === "interrupted";
  const snapshotAvailable = Boolean(health?.latestRunId ?? readiness?.latestRunId);
  const dataUsable = snapshotAvailable;
  const updatePathHealthy = readiness?.status === "ready" && worker?.healthy === true;
  const latestValidAt = fullJob?.status === "succeeded"
    ? fullJob.finishedAt
    : queue?.last_success_at;
  const trustColor = activeJob ? "blue" : dataUsable ? (refreshFailed || !updatePathHealthy ? "yellow" : "green") : "red";
  const trustTitle = activeJob
    ? zh ? "正在更新" : "Updating"
    : dataUsable
      ? refreshFailed
        ? zh ? "上次完整更新失败" : "The last full update failed"
        : !updatePathHealthy
          ? zh ? "自动更新需要处理" : "Automatic updates need attention"
          : zh ? "账户数据正常" : "Account data is healthy"
      : zh ? "账户数据状态未知" : "Account data status is unknown";
  const trustDetail = activeJob
    ? zh
      ? "更新完成前会继续显示上次成功的数据。"
      : "The last successful data remains visible until the update completes."
    : dataUsable
      ? zh
        ? "当前显示上次成功更新的数据。"
        : "The last successful account data remains visible."
      : zh
        ? "请重新检查；如果仍有问题，再运行一次完整更新。"
        : "Check again. If the issue remains, run a full update.";
  const probeScopeLabel = (scope: HealthDetails["errors"][number]["scope"]) => ({
    backend: zh ? "后台服务" : "Backend service",
    health: zh ? "状态检查" : "Health check",
    jobs: zh ? "运行记录" : "Run history",
    readiness: zh ? "更新服务" : "Update service",
    refresh: zh ? "更新计划" : "Refresh schedule",
  })[scope];
  const currentIssues = [
    ...(details?.errors ?? []).map((item) => zh
      ? `${probeScopeLabel(item.scope)}暂时无法检查。`
      : `${probeScopeLabel(item.scope)} is temporarily unavailable.`),
    ...(worker && !worker.healthy
      ? [zh ? "后台服务未正常响应。" : "The background service is not responding normally."]
      : []),
    ...(refreshFailed
      ? [zh ? "最近一次账户完整更新失败；页面仍显示上次成功的数据。" : "The latest full account update failed; the previous successful data remains visible."]
      : []),
  ];
  const statusLabel = (status: RefreshJob["status"] | RefreshJob["stages"][number]["status"]) => {
    const labels: Record<string, string> = {
      failed: messages.health.failedStatus,
      interrupted: messages.health.interruptedStatus,
      queued: messages.health.queuedStatus,
      running: messages.health.runningStatus,
      skipped: messages.health.skippedStatus,
      succeeded: messages.health.succeededStatus,
    };
    return labels[status] ?? status;
  };
  const scopeLabel = (scope: RefreshJob["scope"]) => ({
    accounts: messages.health.accountScope,
    all: messages.health.allScope,
    cfd: messages.health.cfdScope,
    intraday: messages.health.intradayScope,
    live: zh ? "实时账户与持仓" : "Live account & holdings",
    performance: zh ? "绩效与复盘" : "Performance & review",
    research: messages.health.researchScope,
  })[scope] ?? scope;
  const triggerLabel = (trigger: RefreshJob["trigger"]) => ({
    intraday: messages.health.intradayTrigger,
    live: zh ? "实时更新" : "Live update",
    nightly: messages.health.nightlyTrigger,
    on_demand: messages.health.onDemand,
    performance: zh ? "绩效更新" : "Performance update",
    reconciliation: zh ? "完整对账" : "Full reconciliation",
    research: zh ? "研究更新" : "Research update",
  })[trigger] ?? trigger;
  const stageLabel = (name: string, fallback: string) => ({
    "accounts.capital_recovery": messages.health.stageCapitalRecovery,
    "accounts.cfd": zh ? "生成 CFD 账本与分析" : "Build CFD ledger and analysis",
    "accounts.diluted_cost": messages.health.stageDilutedCost,
    "accounts.intraday_nav": zh ? "记录账户价值" : "Record account value",
    "accounts.nav": messages.health.stageNav,
    "accounts.performance": messages.health.stagePerformance,
    "accounts.policy": messages.health.stagePolicy,
    "accounts.review": zh ? "生成账户复盘" : "Build account reviews",
    "accounts.snapshot": messages.health.stageAccountsSnapshot,
    "broker.sync": messages.health.stageBrokerSync,
    "market.snapshot": messages.health.stageMarketSnapshot,
    "portfolio.lookthrough": messages.health.stageLookthrough,
    "reference.security_master": zh ? "核对证券与市场分类" : "Resolve securities and market profiles",
    "research.adr": messages.health.stageAdr,
    "research.analyst": messages.health.stageAnalyst,
    "research.earnings": messages.health.stageEarnings,
    "research.financials": messages.health.stageFinancials,
    "research.fundamentals": messages.health.stageFundamentals,
    "research.options": messages.health.stageOptions,
    "research.taxonomy": messages.health.stageTaxonomy,
    "research.technical": messages.health.stageTechnical,
    "research.valuation": messages.health.stageValuation,
    "snapshot.publish": messages.health.stagePublish,
  }[name] ?? fallback) || name;

  if (healthQuery.isPending) {
    return <SimpleGrid cols={{ base: 1, md: 2 }}>{Array.from({ length: 6 }, (_, index) => <Skeleton h={160} key={index} />)}</SimpleGrid>;
  }

  return (
    <Stack className="tm-lens-enter" gap="xl">
      {healthQuery.isError ? (
        <Alert color="red" icon={<WarningCircle size={18} />} title={zh ? "无法读取运行状态" : "Unable to load operations"}>
          {healthQuery.error.message}
        </Alert>
      ) : null}
      {refreshMutation.isError ? (
        <Alert color="red" icon={<WarningCircle size={18} />}>{refreshMutation.error.message}</Alert>
      ) : null}
      <Card>
        <Stack gap="lg">
          <Group align="flex-start" justify="space-between" wrap="wrap">
            <Group align="flex-start" gap="md" wrap="nowrap">
              <ThemeIcon color={trustColor} size="xl" variant="light">
                {dataUsable ? <CheckCircle size={24} /> : <WarningCircle size={24} />}
              </ThemeIcon>
              <div>
                <Title aria-live="polite" order={2}>{trustTitle}</Title>
                <Text c="dimmed" maw={760}>{trustDetail}</Text>
              </div>
            </Group>
            <Group>
              <Badge color={trustColor} size="lg">
                {dataUsable
                  ? zh ? "可用" : "Usable"
                  : zh ? "需处理" : "Needs attention"}
              </Badge>
              {!dataUsable || currentIssues.length ? (
                <Button
                  leftSection={<ArrowClockwise size={17} />}
                  loading={healthQuery.isFetching}
                  onClick={() => void healthQuery.refetch()}
                  variant="default"
                >
                  {messages.health.checkAgain}
                </Button>
              ) : null}
              <Button
                color="brand.8"
                disabled={Boolean(activeJob) || tone === "unavailable"}
                leftSection={<ArrowClockwise size={17} />}
                loading={refreshMutation.isPending || Boolean(activeJob)}
                onClick={() => refreshMutation.mutate()}
              >
                {activeJob ? messages.health.refreshing : messages.health.refreshAccount}
              </Button>
            </Group>
          </Group>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Metric
              label={zh ? "全量更新" : "Full refresh"}
              value={latestValidAt ? formatDateTime(latestValidAt, locale, timeZone) : "—"}
            />
            <Metric
              label={zh ? "最新数据" : "Latest data"}
              value={health?.artifactAgeSeconds == null ? "—" : formatAge(health.artifactAgeSeconds, locale)}
            />
            <Metric
              label={zh ? "状态检查" : "Status check"}
              value={details ? formatDateTime(details.checkedAt, locale, timeZone) : "—"}
            />
            <Metric
              label={zh ? "显示时区" : "Display timezone"}
              value={displayTimeZoneLabel}
            />
          </SimpleGrid>
          {activeJob ? (
            <Text c="dimmed" size="sm">
              {messages.health.activeStage}: {stage ? stageLabel(stage.name, stage.label) : messages.health.noPipeline}
            </Text>
          ) : null}
        </Stack>
      </Card>

      {currentIssues.length ? (
        <Alert color="yellow" icon={<WarningCircle size={18} />} title={zh ? "当前需要处理" : "Current issues"}>
          <List spacing="xs">
            {currentIssues.map((issue) => <List.Item key={issue}>{issue}</List.Item>)}
          </List>
        </Alert>
      ) : null}

      {refresh && liveSchedule && researchSchedule ? (
        <section aria-labelledby="automatic-updates-title">
          <Stack gap="md">
            <Group align="center" justify="space-between" wrap="wrap">
              <Title id="automatic-updates-title" order={2} size="h3">
                {zh ? "自动化" : "Automation"}
              </Title>
              <Anchor component={Link} href="/settings" style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }}>
                <Group gap={6}><Text fw={700} size="sm">{zh ? "管理自动化" : "Manage automation"}</Text><ArrowRight size={17} /></Group>
              </Anchor>
            </Group>
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <UpdateSummary
                enabled={liveSchedule.enabled}
                icon={<Lightning size={20} />}
                nextRunAt={liveSchedule.nextRunAt}
                schedule={zh
                  ? `每 ${formatInterval(liveSchedule.intervalSeconds, locale)} · 全天候`
                  : `Every ${formatInterval(liveSchedule.intervalSeconds, locale)} · 24/7`}
                title={zh ? "实时账户与持仓" : "Live account & holdings"}
              />
              <UpdateSummary
                enabled={performanceSchedule?.enabled ?? false}
                icon={<ChartLineUp size={20} />}
                nextRunAt={performanceSchedule?.nextRunAt ?? null}
                schedule={zh
                  ? `每 ${formatInterval(performanceSchedule?.intervalSeconds ?? 1_800, locale)} · 账户重大变化时`
                  : `Every ${formatInterval(performanceSchedule?.intervalSeconds ?? 1_800, locale)} · on material account changes`}
                title={zh ? "绩效与复盘" : "Performance & review"}
              />
              <UpdateSummary
                enabled={researchSchedule.enabled}
                icon={<MagnifyingGlass size={20} />}
                nextRunAt={researchSchedule.nextRunAt}
                schedule={zh
                  ? `${displayTimeZoneLabel} ${researchDisplayTimes} · 周末照常`
                  : `${displayTimeZoneLabel} ${researchDisplayTimes} · weekends included`}
                title={zh ? "研究与穿透" : "Research & look-through"}
              />
            </SimpleGrid>
          </Stack>
        </section>
      ) : null}

      <Accordion multiple variant="contained" defaultValue={refreshFailed ? ["pipeline"] : []}>
        <Accordion.Item value="pipeline">
          <Accordion.Control>{zh ? "账户更新记录" : "Account update history"}</Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, xl: 2 }}>
              <Pipeline job={fullJob} stageLabel={stageLabel} statusLabel={statusLabel} />
              <RecentJobs jobs={details?.jobs ?? []} scopeLabel={scopeLabel} statusLabel={statusLabel} triggerLabel={triggerLabel} />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="runtime">
          <Accordion.Control>{zh ? "技术详情" : "Technical details"}</Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 2, md: 4 }}>
              <Metric label={messages.health.service} value={health?.service ?? "—"} />
              <Metric label={messages.health.workerId} value={worker?.worker_id ?? "—"} />
              <Metric label={messages.health.host} value={worker?.host ?? "—"} />
              <Metric label={messages.health.version} value={worker?.worker_version ?? "—"} />
              <Metric label={messages.health.pid} value={String(worker?.pid ?? "—")} />
              <Metric label={messages.health.heartbeat} value={worker?.last_seen_at ? formatDateTime(worker.last_seen_at, locale, timeZone) : "—"} />
              <Metric label={messages.health.queueTotals} value={`${queue?.succeeded ?? 0} / ${queue?.failed ?? 0}`} />
              <Metric label={messages.health.writeAuth} value={health?.writeAuthEnabled ? messages.health.enabled : messages.health.disabled} />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><Text c="dimmed" size="xs">{label}</Text><Text fw={700}>{value}</Text></div>;
}

function UpdateSummary({
  enabled,
  icon,
  nextRunAt,
  schedule,
  title,
}: {
  enabled: boolean;
  icon: React.ReactNode;
  nextRunAt: string | null;
  schedule: string;
  title: string;
}) {
  const { locale, timeZone } = useLocale();
  const zoneLabel = formatTimeZoneLabel(timeZone, locale);
  return (
    <Card h="100%">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon color={enabled ? "green" : "gray"} variant="light">{icon}</ThemeIcon>
            <Text fw={700}>{title}</Text>
          </Group>
          <Badge color={enabled ? "green" : "gray"} variant="light">
            {enabled
              ? locale === "zh" ? "继续运行" : "Running"
              : locale === "zh" ? "已关闭" : "Off"}
          </Badge>
        </Group>
        <Text c="dimmed" size="sm">{schedule}</Text>
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Text c="dimmed" size="xs">{locale === "zh" ? `下次 · ${zoneLabel}` : `Next · ${zoneLabel}`}</Text>
          <Text fw={600} size="xs">
            {nextRunAt ? formatDateTime(nextRunAt, locale, timeZone) : "—"}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}

function statusColor(status: RefreshJob["status"] | RefreshJob["stages"][number]["status"]) {
  if (status === "succeeded") return "green";
  if (status === "running" || status === "queued") return "blue";
  if (status === "failed" || status === "interrupted") return "red";
  return "gray";
}

type StageGroup = "broker" | "accounts" | "research" | "publish";

function stageGroup(name: string): StageGroup {
  if (name.startsWith("broker.") || name.startsWith("market.")) return "broker";
  if (name.startsWith("accounts.")) return "accounts";
  if (name.startsWith("snapshot.")) return "publish";
  return "research";
}

function stageGroupLabel(group: StageGroup, locale: "zh" | "en") {
  const labels = {
    accounts: locale === "zh" ? "账户分析" : "Account analysis",
    broker: locale === "zh" ? "券商与市场" : "Broker & market",
    publish: locale === "zh" ? "发布快照" : "Publish snapshot",
    research: locale === "zh" ? "持仓与研究" : "Portfolio & research",
  } satisfies Record<StageGroup, string>;
  return labels[group];
}

function Pipeline({ job, stageLabel, statusLabel }: { job: RefreshJob | null; stageLabel: (name: string, fallback: string) => string; statusLabel: (status: RefreshJob["status"] | RefreshJob["stages"][number]["status"]) => string }) {
  const { locale } = useLocale();
  const messages = useMessages();
  const exceptions = job?.stages.filter((stage) => stage.status !== "succeeded" && stage.status !== "skipped") ?? [];
  const groups = (["broker", "accounts", "research", "publish"] as const)
    .map((group) => {
      const stages = job?.stages.filter((stage) => stageGroup(stage.name) === group) ?? [];
      return {
        completed: stages.filter((stage) => stage.status === "succeeded" || stage.status === "skipped").length,
        group,
        stages,
      };
    })
    .filter((group) => group.stages.length > 0);
  return (
    <Card>
      <Stack gap="md">
        <Group justify="space-between"><Title order={2} size="h3">{messages.health.pipelineTitle}</Title>{job ? <Badge color={statusColor(job.status)}>{statusLabel(job.status)}</Badge> : null}</Group>
        {job ? (
          <Stack gap="md">
            {exceptions.length ? (
              <List spacing="md">
                {exceptions.map((stage) => (
                  <List.Item
                    icon={stage.status === "failed" || stage.status === "interrupted"
                      ? <WarningCircle color="var(--mantine-color-red-6)" size={20} />
                      : <Clock size={20} />}
                    key={`${job.jobId}-${stage.name}`}
                  >
                    <Group justify="space-between">
                      <div>
                        <Text fw={600}>{stageLabel(stage.name, stage.label)}</Text>
                        <Text c="dimmed" size="xs">{statusLabel(stage.status)}</Text>
                      </div>
                      <Text c="dimmed" size="xs">{durationBetween(stage.startedAt, stage.finishedAt, locale)}</Text>
                    </Group>
                    {stage.error ? <Alert color="red" mt="xs">{stage.error}</Alert> : null}
                  </List.Item>
                ))}
              </List>
            ) : (
              <Stack gap={0}>
                {groups.map((group) => (
                  <Group className="tm-health-diagnostic-row" justify="space-between" key={group.group}>
                    <Text fw={600} size="sm">{stageGroupLabel(group.group, locale)}</Text>
                    <Group gap="xs" wrap="nowrap">
                      <Text c="dimmed" size="xs">{group.completed}/{group.stages.length}</Text>
                      <CheckCircle color="var(--tm-positive)" size={18} />
                    </Group>
                  </Group>
                ))}
              </Stack>
            )}
            <Accordion variant="separated">
              <Accordion.Item value="full-pipeline">
                <Accordion.Control>{locale === "zh" ? `完整流水线 · ${job.stages.length} 个阶段` : `Full pipeline · ${job.stages.length} stages`}</Accordion.Control>
                <Accordion.Panel>
                  <List spacing="md">
                    {job.stages.map((stage) => (
                      <List.Item
                        icon={stage.status === "succeeded"
                          ? <CheckCircle color="var(--tm-positive)" size={20} />
                          : stage.status === "failed" || stage.status === "interrupted"
                            ? <WarningCircle color="var(--mantine-color-red-6)" size={20} />
                            : <Clock size={20} />}
                        key={`${job.jobId}-full-${stage.name}`}
                      >
                        <Group justify="space-between">
                          <div>
                            <Text fw={600}>{stageLabel(stage.name, stage.label)}</Text>
                            <Text c="dimmed" size="xs">{statusLabel(stage.status)}</Text>
                          </div>
                          <Text c="dimmed" size="xs">{durationBetween(stage.startedAt, stage.finishedAt, locale)}</Text>
                        </Group>
                        {stage.error ? <Alert color="red" mt="xs">{stage.error}</Alert> : null}
                      </List.Item>
                    ))}
                  </List>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Stack>
        ) : <Text c="dimmed">{messages.health.noPipeline}</Text>}
      </Stack>
    </Card>
  );
}

function RecentJobs({ jobs, scopeLabel, statusLabel, triggerLabel }: { jobs: RefreshJob[]; scopeLabel: (scope: RefreshJob["scope"]) => string; statusLabel: (status: RefreshJob["status"] | RefreshJob["stages"][number]["status"]) => string; triggerLabel: (trigger: RefreshJob["trigger"]) => string }) {
  const { locale, timeZone } = useLocale();
  const messages = useMessages();
  const rows = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
  const exceptions = rows.filter((job) => job.status !== "succeeded");
  return (
    <Card>
      <Stack gap="md">
        <Title order={2} size="h3">{locale === "zh" ? "近期异常" : "Recent exceptions"}</Title>
        {exceptions.length ? (
          <Stack gap={0}>
            {exceptions.map((job) => (
              <Group className="tm-health-diagnostic-row" justify="space-between" key={job.jobId} wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">{scopeLabel(job.scope)} · {triggerLabel(job.trigger)}</Text>
                  <Text c="dimmed" size="xs">{formatDateTime(job.createdAt, locale, timeZone)}</Text>
                </div>
                <Badge color={statusColor(job.status)}>{statusLabel(job.status)}</Badge>
              </Group>
            ))}
          </Stack>
        ) : (
          <Group gap="sm" wrap="nowrap">
            <CheckCircle color="var(--tm-positive)" size={20} />
            <Text fw={600} size="sm">
              {locale === "zh" ? `最近 ${rows.length} 次运行均成功` : `The last ${rows.length} runs succeeded`}
            </Text>
          </Group>
        )}
        <Accordion variant="separated">
          <Accordion.Item value="all-runs">
            <Accordion.Control>{locale === "zh" ? `全部运行 · ${rows.length}` : `All runs · ${rows.length}`}</Accordion.Control>
            <Accordion.Panel>
              <Table.ScrollContainer
                minWidth={620}
                scrollAreaProps={{
                  viewportProps: { "aria-label": locale === "zh" ? "运行历史表" : "Run history table", tabIndex: 0 },
                }}
              >
                <Table striped>
                  <Table.Thead><Table.Tr><Table.Th>{messages.health.created}</Table.Th><Table.Th>{messages.health.scope}</Table.Th><Table.Th>{messages.health.trigger}</Table.Th><Table.Th>{messages.health.status}</Table.Th><Table.Th>{messages.health.duration}</Table.Th><Table.Th>{messages.health.runId}</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {rows.map((job) => <Table.Tr key={job.jobId}><Table.Td>{formatDateTime(job.createdAt, locale, timeZone)}</Table.Td><Table.Td>{scopeLabel(job.scope)}</Table.Td><Table.Td>{triggerLabel(job.trigger)}</Table.Td><Table.Td><Badge color={statusColor(job.status)}>{statusLabel(job.status)}</Badge></Table.Td><Table.Td>{durationBetween(job.startedAt, job.finishedAt, locale)}</Table.Td><Table.Td>{shortRunId(job.snapshotRunId)}</Table.Td></Table.Tr>)}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Card>
  );
}
