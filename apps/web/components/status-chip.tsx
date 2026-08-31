"use client";

import { Clock } from "@phosphor-icons/react";
import { Badge } from "@mantine/core";

import { useLocale } from "@/components/locale-provider";
import { shortDate } from "@/lib/format";

export function StatusChip({
  label,
  value,
  tone = "neutral",
}: {
  label: React.ReactNode;
  value: string;
  tone?: "neutral" | "good" | "warn";
}) {
  const { locale } = useLocale();
  return (
    <Badge
      className="tm-status-chip"
      data-tone={tone}
      leftSection={<Clock size={14} />}
      size="lg"
      variant="light"
    >
      {label} · {shortDate(value, locale)}
    </Badge>
  );
}
