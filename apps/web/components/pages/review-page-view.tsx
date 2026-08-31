"use client";

import {
  Badge,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";

import { LensContent, LensError, LensSkeleton } from "@/components/lens-state";
import { Localized, useLocale } from "@/components/locale-provider";
import { PageHeader } from "@/components/page-header";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { deltaPct, gbp, shortDate } from "@/lib/format";
import type { AccountCode, DashboardLens } from "@/lib/types";

export function ReviewPageView() {
  const lens = useDashboardLens("review");

  return (
    <Stack gap="xl">
      <PageHeader
        description={
          <Localized
            zh="按账户查看收益、亏损、交易和风险。"
            en="Review returns, losses, trades, and risk by account."
          />
        }
        title={<Localized zh="账户复盘" en="Account review" />}
      />
      {lens.isPending ? <LensSkeleton cards={3} columns={3} height={300} /> : null}
      {lens.isError ? <LensError retry={() => void lens.refetch()} /> : null}
      {lens.data ? (
        <LensContent>
          <ReviewHub data={lens.data} />
        </LensContent>
      ) : null}
    </Stack>
  );
}

function ReviewHub({ data }: { data: DashboardLens }) {
  const { locale } = useLocale();
  const invest = data.accounts?.find((account) => account.code === "A");
  const isa = data.accounts?.find((account) => account.code === "B");
  const cfd = data.cfd;
  const cfdHistoricalMode = Boolean(
    cfd && (cfd.accountStatus === "retired" || !cfd.staleRemindersEnabled),
  );
  const cfdStatus = !cfd
    ? { color: "gray", label: locale === "zh" ? "等待数据" : "Awaiting data" }
    : cfdHistoricalMode
      ? { color: "gray", label: locale === "zh" ? "历史记录模式" : "Historical mode" }
      : cfd.isStale
        ? { color: "yellow", label: locale === "zh" ? "数据可能过期" : "Possibly stale" }
        : { color: "green", label: locale === "zh" ? "数据在有效期内" : "Data current" };

  return (
    <Stack gap="xl">
      <section aria-labelledby="choose-review-title">
        <Stack gap="md">
          <Title id="choose-review-title" order={2} size="h3">
            <Localized zh="选择账户" en="Choose an account" />
          </Title>
          <SimpleGrid cols={{ base: 1, lg: 3 }}>
            <ReviewCard
              account="A"
              available={Boolean(invest || data.risk?.A)}
              metrics={[
                [<Localized key="value" zh="账户价值" en="Account value" />, invest ? gbp(invest.totalValueGbp, 2) : "—"],
                ["TWR", deltaPct(data.risk?.A?.twr)],
                [<Localized key="drawdown" zh="当前回撤" en="Current drawdown" />, deltaPct(data.risk?.A?.currentDrawdown)],
              ]}
              name="Invest"
              scope={data.brokerAsOf ? shortDate(data.brokerAsOf, locale) : "—"}
              status={{ color: "green", label: locale === "zh" ? "可复盘" : "Ready" }}
            />
            <ReviewCard
              account="B"
              available={Boolean(isa || data.risk?.B)}
              metrics={[
                [<Localized key="value" zh="账户价值" en="Account value" />, isa ? gbp(isa.totalValueGbp, 2) : "—"],
                ["TWR", deltaPct(data.risk?.B?.twr)],
                [<Localized key="drawdown" zh="当前回撤" en="Current drawdown" />, deltaPct(data.risk?.B?.currentDrawdown)],
              ]}
              name="ISA"
              scope={data.brokerAsOf ? shortDate(data.brokerAsOf, locale) : "—"}
              status={{ color: "green", label: locale === "zh" ? "可复盘" : "Ready" }}
            />
            <ReviewCard
              account="C"
              available={Boolean(cfd)}
              metrics={[
                [<Localized key="proxy" zh="已实现权益代理值" en="Realised equity proxy" />, cfd ? gbp(cfd.endingValueGbp, 2) : "—"],
                [<Localized key="pnl" zh="净已实现损益" en="Net realised P&L" />, cfd ? gbp(cfd.netRealisedPnlGbp ?? cfd.realizedPnlGbp, 2) : "—"],
                [<Localized key="equity" zh="当前券商权益" en="Current broker equity" />, <Localized key="none" zh="不可由导入数据确定" en="Unavailable from imports" />],
              ]}
              name="CFD"
              scope={cfd?.asOf ? shortDate(cfd.asOf, locale) : "—"}
              status={cfdStatus}
            />
          </SimpleGrid>
        </Stack>
      </section>

    </Stack>
  );
}

function ReviewCard({
  account,
  available,
  metrics,
  name,
  scope,
  status,
}: {
  account: AccountCode;
  available: boolean;
  metrics: Array<[React.ReactNode, React.ReactNode]>;
  name: string;
  scope: string;
  status: { color: string; label: string };
}) {
  return (
    <Card
      aria-label={available ? `${name} account review` : `${name} account review unavailable`}
      className="tm-interactive-card tm-review-account-link"
      component={Link}
      href={`/account-analysis?account=${account}`}
      h="100%"
      withBorder
    >
      <Stack gap="lg" h="100%">
        <Group align="flex-start" justify="space-between" wrap="nowrap">
          <div>
            <Title order={3}>{name}</Title>
            <Text c="dimmed" size="xs"><Localized zh="截至" en="As of" /> {scope}</Text>
          </div>
          <Badge color={available ? status.color : "gray"} variant="light">
            {available ? status.label : <Localized zh="等待数据" en="Awaiting data" />}
          </Badge>
        </Group>
        <Stack gap="md">
          {metrics.map(([label, value], index) => (
            <Group justify="space-between" key={`${account}-${index}`} wrap="nowrap">
              <Text c="dimmed" size="sm">{label}</Text>
              <Text fw={700} ta="right">{value}</Text>
            </Group>
          ))}
        </Stack>
        <Group gap={6} justify="space-between" mt="auto" wrap="nowrap">
          <Text fw={700} size="sm"><Localized zh="查看账户复盘" en="View account review" /></Text>
          <ArrowRight aria-hidden size={17} />
        </Group>
      </Stack>
    </Card>
  );
}
