"use client";

import {
  Accordion,
  Alert,
  Badge,
  Button,
  Divider,
  Drawer,
  Group,
  List,
  Paper,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { ArrowClockwise, ArrowRight, Brain, CheckCircle, Warning } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useLocale } from "@/components/locale-provider";
import {
  analysisRunKey,
  getAnalysisRunState,
  getServerAnalysisRunState,
  registerAnalysisRefresh,
  startAnalysisRun,
  subscribeToAnalysisRuns,
} from "@/lib/analysis-runs";
import type { AnalysisArtifact, AnalysisLens, LocalizedAnalysisText } from "@/lib/types";
import { formatDateTime, formatNumber, formatPercent } from "@/ui/formatters";

function localized(value: LocalizedAnalysisText, locale: "zh" | "en") {
  return value[locale];
}

function displayMetric(value: string | null, locale: "zh" | "en") {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return Math.abs(numeric) <= 2
    ? formatPercent(numeric, locale)
    : formatNumber(numeric, locale, { maximumFractionDigits: 2 });
}

export function AnalysisPanel({
  analysis,
  lens,
  ticker,
  compact = false,
  scope,
  onAnalysisComplete,
}: {
  analysis: AnalysisArtifact | null;
  lens: AnalysisLens;
  ticker?: string;
  compact?: boolean;
  scope?: LocalizedAnalysisText;
  onAnalysisComplete?: () => void;
}) {
  const { locale, timeZone } = useLocale();
  const router = useRouter();
  const [opened, drawer] = useDisclosure(false);
  const mobile = useMediaQuery("(max-width: 48em)");
  const runKey = analysisRunKey(lens, ticker);
  const runState = useSyncExternalStore(
    subscribeToAnalysisRuns,
    () => getAnalysisRunState(runKey),
    getServerAnalysisRunState,
  );
  const [now, setNow] = useState(() => Date.now());
  const mutation = useMutation({
    mutationFn: async () => startAnalysisRun({ lens, ticker }),
  });
  const completionHandler = useRef(onAnalysisComplete);

  useEffect(() => {
    completionHandler.current = onAnalysisComplete;
  }, [onAnalysisComplete]);
  useEffect(
    () =>
      registerAnalysisRefresh(() => {
        if (completionHandler.current) {
          completionHandler.current();
        } else {
          router.refresh();
        }
      }),
    [router],
  );
  useEffect(() => {
    if (runState.status !== "queued" && runState.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runState.status]);

  const zh = locale === "zh";
  const busy = mutation.isPending || runState.status === "queued" || runState.status === "running";
  const failed = mutation.isError || runState.status === "failed";
  const elapsed = runState.startedAt ? Math.max(0, Math.round((now - runState.startedAt) / 1000)) : 0;
  const scopeLabel = scope ? localized(scope, locale) : ticker ?? (zh ? "我的组合" : "Your portfolio");
  const action = busy
    ? zh ? "分析中" : "Analyzing"
    : failed
      ? zh ? "重试" : "Retry"
      : analysis
        ? zh ? "查看分析" : "Open analysis"
        : zh ? "生成分析" : "Generate analysis";
  const auditSections: Array<{
    icon: typeof CheckCircle;
    items: LocalizedAnalysisText[];
    label: string;
  }> = analysis ? [
    { icon: CheckCircle, items: analysis.content.counterpoints, label: zh ? "相反信息" : "Contrary evidence" },
    { icon: Warning, items: analysis.content.risks, label: zh ? "主要风险" : "Principal risks" },
    { icon: Warning, items: analysis.content.invalidationConditions, label: zh ? "失效条件" : "Invalidation" },
    { icon: CheckCircle, items: analysis.content.nextObservations, label: zh ? "下一步观察" : "Watch next" },
  ] : [];
  const triggerAction = () => {
    if (analysis && !failed) {
      drawer.open();
      return;
    }
    mutation.mutate();
  };

  return (
    <>
      <Paper component="article" p="md" radius="lg" withBorder>
        <Stack gap="xs">
          <Group align="center" justify="space-between" wrap="wrap">
            <Group gap="sm" style={{ flex: "1 1 28rem", minWidth: 0 }} wrap="nowrap">
              <ThemeIcon color="dark" size="lg" variant="light">
                <Brain aria-hidden="true" size={20} weight="duotone" />
              </ThemeIcon>
              <Stack gap={1} style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap">
                  <Text c="dimmed" fw={700} size="xs" tt="uppercase">
                    {zh ? "分析" : "Analysis"} · {scopeLabel}
                  </Text>
                  {analysis ? (
                    <Badge color={analysis.fake ? "yellow" : "brand"} size="xs" variant="light">
                      {analysis.fake ? (zh ? "模拟" : "Simulated") : (zh ? "已保存" : "Saved")}
                    </Badge>
                  ) : null}
                </Group>
                <Text fw={analysis ? 700 : 500} lineClamp={1} size="sm">
                  {analysis
                    ? localized(analysis.content.headline, locale)
                    : busy
                      ? (zh ? `正在后台生成 · ${elapsed} 秒，可继续浏览` : `Generating in the background · ${elapsed}s; keep browsing`)
                      : failed
                        ? (runState.error ?? (zh ? "本次分析失败，请检查模型连接。" : "This run failed. Check the model connection."))
                        : (zh ? "当前数据还没有分析结果。" : "No analysis is available for the current data yet.")}
                </Text>
              </Stack>
            </Group>
            <Group gap="xs">
              {analysis ? (
                <Badge color="gray" variant="light">
                  {zh ? "置信度" : "Confidence"} {Math.round(analysis.confidence * 100)}%
                </Badge>
              ) : null}
              <Button
                disabled={busy}
                leftSection={analysis && !failed ? undefined : <ArrowClockwise size={16} />}
                loading={busy}
                onClick={triggerAction}
                rightSection={analysis && !failed ? <ArrowRight size={16} /> : undefined}
                variant="subtle"
              >
                {action}
              </Button>
            </Group>
          </Group>
          {busy ? <Progress aria-label={zh ? "分析进度" : "Analysis progress"} animated value={100} /> : null}
          {failed ? (
            <Text c="red" role="alert" size="xs">
              {zh ? "分析没有修改页面数据；修复连接后可安全重试。" : "The failed run did not change page data; retry safely after fixing the connection."}
            </Text>
          ) : null}
        </Stack>
      </Paper>

      <Drawer
        onClose={drawer.close}
        opened={opened}
        position={mobile ? "bottom" : "right"}
        size={mobile ? "92%" : compact ? "md" : "lg"}
        title={zh ? "模型分析" : "Model analysis"}
      >
        {analysis ? (
          <Stack gap="lg">
            <Group justify="space-between" wrap="wrap">
              <Group>
                <ThemeIcon color="dark" size="lg" variant="light">
                  <Brain aria-hidden="true" size={20} weight="duotone" />
                </ThemeIcon>
                <div>
                  <Text c="dimmed" fw={700} size="xs" tt="uppercase">{scopeLabel}</Text>
                  <Text fw={700}>{analysis.analysisId.replaceAll("_", " ")}</Text>
                </div>
              </Group>
              <Button
                leftSection={<ArrowClockwise size={16} />}
                loading={busy}
                onClick={() => mutation.mutate()}
                variant="light"
              >
                {zh ? "重新分析" : "Run again"}
              </Button>
            </Group>
            {busy ? <Progress animated value={100} /> : null}
            {failed ? (
              <Alert color="red" icon={<Warning size={18} />} title={zh ? "分析失败" : "Analysis failed"}>
                {runState.error ?? (zh ? "请检查模型连接后重试。" : "Check the model connection and retry.")}
              </Alert>
            ) : null}
            <Divider />
            <Stack gap="sm">
              <Text c="dimmed" fw={700} size="xs" tt="uppercase">{zh ? "分析师解读" : "Analyst read"}</Text>
              <Title order={2}>{localized(analysis.content.headline, locale)}</Title>
              <Text c="dimmed">{localized(analysis.content.summary, locale)}</Text>
            </Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {analysis.content.evidence.slice(0, 4).map((item) => (
                <Paper key={`${item.label.en}-${item.metric}`} p="md" withBorder>
                  <Text c="dimmed" size="xs">{localized(item.label, locale)}</Text>
                  {item.metric ? <Text fw={800} size="lg">{displayMetric(item.metric, locale)}</Text> : null}
                  <Text size="sm">{localized(item.detail, locale)}</Text>
                </Paper>
              ))}
            </SimpleGrid>
            <Accordion variant="separated">
              {auditSections.map(({ label, items, icon: Icon }) => (
                <Accordion.Item key={label} value={label}>
                  <Accordion.Control icon={<Icon size={17} />}>{label}</Accordion.Control>
                  <Accordion.Panel>
                    <List spacing="xs">
                      {items.map((item) => <List.Item key={item.en}>{localized(item, locale)}</List.Item>)}
                    </List>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
            <Group c="dimmed" gap="lg" wrap="wrap">
              <Text size="xs">{analysis.model} · {analysis.promptVersion}</Text>
              <Text size="xs">{formatDateTime(analysis.generatedAt, locale, timeZone)}</Text>
              <Text size="xs">Data · {analysis.snapshotRunId.slice(0, 12)}</Text>
            </Group>
          </Stack>
        ) : (
          <Stack><Skeleton h={26} w="55%" /><Skeleton h={16} /><Skeleton h={16} w="78%" /></Stack>
        )}
      </Drawer>
    </>
  );
}
