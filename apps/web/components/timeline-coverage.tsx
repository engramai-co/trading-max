"use client";

import { Badge, Group, Stack, Text } from "@mantine/core";

import { useLocale } from "@/components/locale-provider";
import type { TimelineCoverageSummary } from "@/lib/chart-domain";
import { formatDate } from "@/ui/formatters";

function position(index: number, count: number) {
  return count <= 1 ? 0 : index / (count - 1) * 100;
}

export function TimelineCoverage({
  context,
  inverse = false,
  summary,
}: {
  context: "day" | "week" | "month";
  inverse?: boolean;
  summary: TimelineCoverageSummary;
}) {
  const { locale, timeZone } = useLocale();
  const formatPoint = (value: string | null) => value
    ? formatDate(value, locale, context === "day"
      ? { hour: "2-digit", minute: "2-digit", timeZone }
      : { day: "numeric", month: "short", timeZone })
    : "—";
  const leadingGap = summary.gaps.some((range) => range.startIndex === 0);
  const internalGaps = summary.gaps.filter((range) => range.startIndex > 0).length;
  const firstPoint = formatPoint(summary.firstObservedAt);
  const lastPoint = formatPoint(summary.lastObservedAt);
  const copy = {
    zh: {
      complete: "已有记录",
      empty: "暂无记录",
      emptyDetail: "该时段没有已保存的券商价值记录。",
      internalGap: internalGaps ? `；中间有 ${internalGaps} 段未采集` : "",
      leadingDetail: `自 ${firstPoint} 起有记录；此前未采集`,
      partial: "部分覆盖",
      punctuation: "。",
      recordedDetail: `记录至 ${lastPoint}`,
      single: "单点记录",
      singleDetail: `仅有 ${firstPoint} 的记录，暂不能计算变化。`,
    },
    en: {
      complete: "Recorded",
      empty: "No observations",
      emptyDetail: "No retained broker-value observations are available for this period.",
      internalGap: internalGaps
        ? `, with ${internalGaps} uncollected interval${internalGaps === 1 ? "" : "s"}`
        : "",
      leadingDetail: `Observations begin at ${firstPoint}; earlier values were not collected`,
      partial: "Partial coverage",
      punctuation: ".",
      recordedDetail: `Recorded through ${lastPoint}`,
      single: "Single observation",
      singleDetail: `Only ${firstPoint} is recorded, so a change cannot be calculated yet.`,
    },
  }[locale];
  const status = summary.status === "complete"
    ? copy.complete
    : summary.status === "partial"
      ? copy.partial
      : summary.status === "single"
        ? copy.single
        : copy.empty;
  const detail = summary.status === "empty"
    ? copy.emptyDetail
    : summary.status === "single"
      ? copy.singleDetail
      : `${leadingGap ? copy.leadingDetail : copy.recordedDetail}${copy.internalGap}${copy.punctuation}`;
  const label = `${status}. ${detail}`;

  return (
    <Stack className={`tm-coverage${inverse ? " tm-coverage--inverse" : ""}`} gap={6}>
      <Group gap="xs" justify="space-between" wrap="wrap">
        <Text
          c={inverse ? "brand.1" : "dimmed"}
          lineClamp={2}
          size="xs"
          style={{ flex: "1 1 13rem" }}
        >
          {detail}
        </Text>
        <Badge
          color={summary.status === "partial" ? "yellow" : "gray"}
          size="xs"
          style={{ flexShrink: 0 }}
          variant="light"
        >
          {status}
        </Badge>
      </Group>
      <div aria-hidden="true" className="tm-coverage-track" title={label}>
        {summary.observedRanges.map((range) => {
          const left = position(range.startIndex, summary.categoryCount);
          const right = position(range.endIndex, summary.categoryCount);
          return (
            <span
              className="tm-coverage-observed"
              key={`${range.startIndex}-${range.endIndex}`}
              style={{ left: `${left}%`, width: `${Math.max(right - left, 1.25)}%` }}
            />
          );
        })}
      </div>
    </Stack>
  );
}
