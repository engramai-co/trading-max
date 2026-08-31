"use client";

import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";

import { useLocale } from "@/components/locale-provider";

export function ResearchRefreshButton({
  onQueued,
  ticker,
}: {
  onQueued?: () => void;
  ticker: string;
}) {
  const { locale } = useLocale();
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/backend/watchlist/${encodeURIComponent(ticker)}`, {
        body: JSON.stringify({ action: "refresh" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = await response.json() as { detail?: string };
        throw new Error(payload.detail ?? `Research refresh ${response.status}`);
      }
    },
    onError: (error) => notifications.show({ color: "red", message: error.message }),
    onSuccess: () => {
      onQueued?.();
      notifications.show({
        color: "green",
        message: locale === "zh" ? `${ticker} 已加入研究队列` : `${ticker} queued for research`,
      });
      router.refresh();
    },
  });
  return (
    <Button
      leftSection={<ArrowClockwise size={17} />}
      loading={mutation.isPending}
      onClick={() => mutation.mutate()}
      variant="default"
    >
      {locale === "zh" ? "更新数据" : "Refresh data"}
    </Button>
  );
}
