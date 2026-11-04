"use client";

import { Button, Group, Popover } from "@mantine/core";
import { ArrowClockwise, Sparkle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocale } from "@/components/locale-provider";
import {
  analysisRunKey,
  getAnalysisRunState,
  getServerAnalysisRunState,
  registerAnalysisRefresh,
  startAnalysisRun,
  subscribeToAnalysisRuns,
} from "@/lib/analysis-runs";
import type { AccountCode, AnalysisArtifact } from "@/lib/types";
import { Freshness, Notice, Panel, useCopy } from "./foundation";

/**
 * What the panel offers. Generating always replaces the stored review, so nothing
 * until the lookup answers, a retry if it failed, a first review only once it
 * found none, and a regeneration that asks first when one exists.
 */
export function narrativeAction(lookup: {
  isPending: boolean;
  isError: boolean;
  data: AnalysisArtifact | null | undefined;
}) {
  if (lookup.data) return "regenerate";
  if (lookup.isError) return "retry";
  return lookup.isPending || lookup.data === undefined ? "wait" : "generate";
}

/**
 * An on-demand AI reading of this account's decisions: the pattern behind them,
 * linked to the market and company events listed beside each decision.
 */
export function DecisionNarrative({ account, dataAsOf }: { account: AccountCode; dataAsOf?: string | null }) {
  const t = useCopy();
  const { locale } = useLocale();
  const key = analysisRunKey("decision_review", account);
  const run = useSyncExternalStore(subscribeToAnalysisRuns, () => getAnalysisRunState(key), getServerAnalysisRunState);
  const active = run.status === "queued" || run.status === "running";
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({
    queryKey: ["decision-narrative", account],
    retry: 0,
    queryFn: async () => {
      const response = await fetch("/api/backend/analysis?lens=decision_review&ticker=" + account, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Analysis unavailable");
      return response.json() as Promise<AnalysisArtifact>;
    },
  });
  const refetch = query.refetch;
  useEffect(() => registerAnalysisRefresh(() => void refetch()), [refetch]);
  const offer = narrativeAction(query);
  const content = query.data?.content;
  const generatedAt = query.data?.generatedAt;
  // The review usually predates the figures beside it; say when it was written only then.
  const older = Boolean(generatedAt && dataAsOf && Date.parse(generatedAt) < Date.parse(dataAsOf));
  const generate = () => void startAnalysisRun({ lens: "decision_review", ticker: account });
  // Regenerating replaces a review the owner may still be reading, so it asks first.
  const regenerate = (
    <Popover
      opened={confirming}
      onChange={setConfirming}
      position="bottom-end"
      width={260}
      offset={8}
      middlewares={{ flip: true, shift: { padding: 16 } }}
      trapFocus
      returnFocus
      transitionProps={{ duration: 0 }}
      shadow="md"
    >
      <Popover.Target>
        <Button
          variant="default"
          size="xs"
          loading={active}
          leftSection={<ArrowClockwise size={14} />}
          onClick={() => setConfirming((open) => !open)}
        >
          {t("重新生成", "Regenerate")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown className="mx-help-popover">
        <p className="mx-body-copy">
          {t("重新生成会替换当前的 AI 复盘，约需半分钟。", "A new review replaces this one and takes about half a minute.")}
        </p>
        <Group justify="flex-end" gap="xs" mt="md">
          <Button variant="default" size="xs" data-autofocus onClick={() => setConfirming(false)}>
            {t("保留", "Keep")}
          </Button>
          <Button
            size="xs"
            onClick={() => {
              setConfirming(false);
              generate();
            }}
          >
            {t("重新生成", "Regenerate")}
          </Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
  return (
    <Panel
      className="mx-decision-narrative"
      title={
        <Group gap={8}>
          <Sparkle size={17} />
          {t("AI 复盘", "AI review")}
        </Group>
      }
      description={content && older ? <Freshness date={generatedAt} label={t("生成于", "Written")} /> : undefined}
      action={
        offer === "regenerate" ? (
          regenerate
        ) : offer === "retry" ? (
          <Button
            variant="default"
            size="xs"
            loading={query.isFetching}
            leftSection={<ArrowClockwise size={14} />}
            onClick={() => void refetch()}
          >
            {t("重新加载", "Try again")}
          </Button>
        ) : (
          <Button
            variant="default"
            size="xs"
            loading={active}
            disabled={offer === "wait"}
            leftSection={<ArrowClockwise size={14} />}
            onClick={generate}
          >
            {t("生成复盘", "Generate")}
          </Button>
        )
      }
    >
      {offer === "retry" && (
        <Notice tone="bad">{t("暂时无法读取 AI 复盘。", "The AI review could not be loaded.")}</Notice>
      )}
      {run.status === "failed" && (
        <Notice tone="bad">
          {t("生成未完成。请在设置中连接模型后重试。", "Generation did not complete. Connect a model in Settings and retry.")}
        </Notice>
      )}
      {content && (
        <div className="mx-prose">
          <h3>{content.headline[locale]}</h3>
          <p>{content.summary[locale]}</p>
          {content.evidence.length > 0 && (
            <ul>
              {content.evidence.map((item, index) => (
                <li key={index}>
                  <strong>{item.label[locale]}</strong> · {item.detail[locale]}
                </li>
              ))}
            </ul>
          )}
          {content.nextObservations.length > 0 && (
            <>
              <h4>{t("下次决定前", "Before the next decision")}</h4>
              <ul>
                {content.nextObservations.map((item, index) => (
                  <li key={index}>{item[locale]}</li>
                ))}
              </ul>
            </>
          )}
          {content.counterpoints.length > 0 && (
            <>
              <h4>{t("保留意见", "Caveats")}</h4>
              <ul>
                {content.counterpoints.map((item, index) => (
                  <li key={index}>{item[locale]}</li>
                ))}
              </ul>
            </>
          )}
          {query.data!.fake && <Notice>{t("这是测试提供商生成的示例内容。", "This content was generated by a test provider.")}</Notice>}
        </div>
      )}
    </Panel>
  );
}

