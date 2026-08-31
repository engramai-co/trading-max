"use client";

import { Stack } from "@mantine/core";

import { Localized } from "@/components/locale-provider";
import { PageHeader } from "@/components/page-header";
import { SystemHealthDashboard } from "@/components/system-health-dashboard";

export function HealthPageView() {
  return (
    <Stack gap="xl">
      <PageHeader
        density="utility"
        title={<Localized zh="系统健康" en="System health" />}
        description={
          <Localized
            zh="检查账户数据、自动更新和后台服务是否正常。"
            en="Check account data, automatic updates, and background services."
          />
        }
      />
      <SystemHealthDashboard />
    </Stack>
  );
}
