"use client";

import { Card, Group, Loader, SimpleGrid, Skeleton, Stack, Text } from "@mantine/core";

import { useLocale } from "@/components/locale-provider";

export default function Loading() {
  const { locale } = useLocale();
  return (
    <Stack aria-busy="true" aria-live="polite" gap="xl" role="status">
      <Group>
        <Loader size="sm" />
        <div>
          <Text fw={700}>{locale === "zh" ? "正在加载…" : "Loading…"}</Text>
        </div>
      </Group>
      <Skeleton height={34} radius="md" width="35%" />
      <Skeleton height={18} radius="md" width="60%" />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Skeleton height={120} radius="lg" />
        <Skeleton height={120} radius="lg" />
        <Skeleton height={120} radius="lg" />
      </SimpleGrid>
      <Card><Skeleton height={320} radius="md" /></Card>
    </Stack>
  );
}
