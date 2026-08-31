"use client";

import { useQuery } from "@tanstack/react-query";

import { LensContent, LensError, LensSkeleton } from "@/components/lens-state";
import { PageHeader } from "@/components/page-header";
import { Localized, useLocale } from "@/components/locale-provider";
import { SettingsPanel } from "@/components/settings-panel";
import { Group, SegmentedControl, Select, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { ArrowRight, Clock, Heartbeat } from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo } from "react";
import { deriveHealthTone } from "@/lib/health";
import { healthDetailsQueryKey } from "@/lib/health-query";
import {
  settingsBundleQueryKey,
  type SettingsBundle,
} from "@/lib/settings-query";
import type {
  AutomationSettings,
  CfdImportStatus,
  HealthDetails,
  IntegrationOverview,
} from "@/lib/types";
import { formatTimeZoneLabel } from "@/ui/formatters";

async function fetchJson<T>(pathname: string): Promise<T> {
  const response = await fetch(pathname, { cache: "no-store" });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return (await response.json()) as T;
}

async function fetchSettings(): Promise<SettingsBundle> {
  const [integrations, cfdStatus, automation] = await Promise.allSettled([
    fetchJson<IntegrationOverview>("/api/backend/settings/integrations"),
    fetchJson<CfdImportStatus>("/api/backend/imports/trading212/cfd"),
    fetchJson<AutomationSettings>("/api/backend/settings/automation"),
  ]);
  if (integrations.status === "rejected") throw integrations.reason;
  return {
    integrations: integrations.value,
    cfdStatus: cfdStatus.status === "fulfilled" ? cfdStatus.value : null,
    automation: automation.status === "fulfilled" ? automation.value : null,
    partial: cfdStatus.status === "rejected" || automation.status === "rejected",
  };
}

async function fetchHealth(): Promise<HealthDetails> {
  const response = await fetch("/api/backend/health/details", { cache: "no-store" });
  if (!response.ok) throw new Error(`health details returned ${response.status}`);
  return (await response.json()) as HealthDetails;
}

export function SettingsPageView() {
  const {
    browserTimeZone,
    locale,
    setLocale,
    setTimeZonePreference,
    timeZonePreference,
  } = useLocale();
  const timeZoneOptions = useMemo(() => {
    const supportedValuesOf = (Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }).supportedValuesOf;
    const zones = supportedValuesOf
      ? supportedValuesOf.call(Intl, "timeZone")
      : ["UTC", "America/New_York", "Asia/Hong_Kong", "Asia/Seoul", "Asia/Shanghai"];
    const availableZones = Array.from(new Set([
      "UTC",
      browserTimeZone,
      timeZonePreference === "browser" ? browserTimeZone : timeZonePreference,
      ...zones,
    ]));
    return [
      {
        label: locale === "zh" ? "伦敦（默认）" : "London (default)",
        value: "Europe/London",
      },
      {
        label: locale === "zh"
          ? `跟随浏览器 · ${formatTimeZoneLabel(browserTimeZone, locale)}`
          : `Use browser · ${formatTimeZoneLabel(browserTimeZone, locale)}`,
        value: "browser",
      },
      ...availableZones
        .filter((zone) => zone !== "Europe/London")
        .map((zone) => ({
          label: zone.replaceAll("_", " "),
          value: zone,
        })),
    ];
  }, [browserTimeZone, locale, timeZonePreference]);
  const settings = useQuery({
    queryFn: fetchSettings,
    queryKey: settingsBundleQueryKey,
    retry: 1,
    staleTime: 30_000,
  });
  const health = useQuery({
    queryFn: fetchHealth,
    queryKey: healthDetailsQueryKey,
    retry: 1,
    staleTime: 15_000,
  });
  const healthTone = deriveHealthTone(health.data ?? null);
  const healthPresentation = health.isPending
    ? { color: "gray", label: locale === "zh" ? "检查中" : "Checking" }
    : healthTone === "ready"
      ? { color: "green", label: locale === "zh" ? "系统正常" : "System healthy" }
      : healthTone === "running"
        ? { color: "blue", label: locale === "zh" ? "正在更新" : "Updating" }
        : healthTone === "degraded"
          ? { color: "yellow", label: locale === "zh" ? "需要查看" : "Needs attention" }
          : { color: "red", label: locale === "zh" ? "状态未知" : "Status unknown" };

  return (
    <Stack gap="xl">
      <PageHeader
        density="utility"
        description={
          <Localized
            zh="设置语言、账户连接、CFD 导入和自动更新。凭据仅保存在本机。"
            en="Set the language, account connections, CFD imports, and automatic updates. Credentials stay on this machine."
          />
        }
        actions={(
          <Group className="tm-settings-header-actions" gap="sm" wrap="wrap">
            <UnstyledButton
              aria-label={locale === "zh" ? `系统状态：${healthPresentation.label}` : `System status: ${healthPresentation.label}`}
              className="tm-settings-health-link"
              component={Link}
              href="/health"
            >
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon color={healthPresentation.color} size={36} variant="light">
                  <Heartbeat size={19} weight="fill" />
                </ThemeIcon>
                <Stack gap={0}>
                  <Text c="dimmed" size="xs"><Localized zh="系统状态" en="System status" /></Text>
                  <Text fw={700} size="sm">{healthPresentation.label}</Text>
                </Stack>
                <ArrowRight size={17} />
              </Group>
            </UnstyledButton>
            <Select
              allowDeselect={false}
              aria-label={locale === "zh" ? "选择显示时区" : "Choose display timezone"}
              className="tm-settings-time-zone"
              data={timeZoneOptions}
              leftSection={<Clock size={16} />}
              onChange={(value) => value && setTimeZonePreference(value)}
              searchable
              size="sm"
              value={timeZonePreference}
            />
            <SegmentedControl
              aria-label={locale === "zh" ? "选择界面语言" : "Choose interface language"}
              className="tm-settings-language"
              data={[
                { label: locale === "zh" ? "中文" : "Chinese", value: "zh" },
                { label: locale === "zh" ? "英文" : "English", value: "en" },
              ]}
              onChange={(value) => setLocale(value === "en" ? "en" : "zh")}
              size="sm"
              value={locale}
            />
          </Group>
        )}
        title={<Localized zh="设置与连接" en="Settings & connections" />}
      />
      {settings.isPending ? <LensSkeleton cards={2} height={320} /> : null}
      {settings.isError ? <LensError retry={() => void settings.refetch()} /> : null}
      {settings.data ? (
        <LensContent>
          <SettingsPanel
            initial={settings.data.integrations}
            initialAutomation={settings.data.automation}
            initialCfdStatus={settings.data.cfdStatus}
            initialError={settings.data.partial
              ? locale === "zh"
                ? "部分设置暂时无法读取，请稍后刷新。"
                : "Some settings are temporarily unavailable. Refresh and try again."
              : null}
          />
        </LensContent>
      ) : null}
    </Stack>
  );
}
