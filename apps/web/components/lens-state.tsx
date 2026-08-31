"use client";

import { Alert, Button, SimpleGrid, Skeleton, Stack } from "@mantine/core";
import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { useEffect } from "react";

import { Localized } from "@/components/locale-provider";

export function LensContent({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    performance.mark("tm:data-ready");
  }, []);
  return <div className="tm-lens-enter" data-tm-data-ready="true">{children}</div>;
}

export function LensSkeleton({
  cards = 2,
  columns = 2,
  height = 260,
}: {
  cards?: number;
  columns?: number;
  height?: number;
}) {
  return (
    <SimpleGrid aria-busy="true" aria-label="Loading interface" cols={{ base: 1, lg: Math.min(cards, columns) }}>
      {Array.from({ length: cards }, (_, index) => (
        <Skeleton h={height} key={index} radius="xl" />
      ))}
    </SimpleGrid>
  );
}

export function LensError({ retry }: { retry: () => void }) {
  return (
    <Alert
      color="red"
      icon={<WarningCircle size={18} />}
      title={<Localized zh="当前内容无法加载" en="This content could not load" />}
    >
      <Stack align="flex-start" gap="sm">
        <Localized
          zh="其他内容不受影响。请重试当前部分。"
          en="Other content is unaffected. Retry this section."
        />
        <Button leftSection={<ArrowClockwise size={16} />} onClick={retry} variant="light">
          <Localized zh="重试" en="Retry" />
        </Button>
      </Stack>
    </Alert>
  );
}
