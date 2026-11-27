"use client";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useBreakpoint } from "@/lib/hooks";
import { PORTFOLIO_RANGES } from "@/lib/portfolio/history";
import type { Range } from "@/lib/portfolio/nav";
import { Segments, useCopy } from "./foundation";
import { scheduleLoadingStatus } from "./loading-state";

export function rangeName(range: Range, all: string) {
  return range === "ALL" ? all : range === "1W" ? "5D" : range;
}

const phoneRanges = new Set<Range>(["3M", "YTD", "1Y"]);

export function DashboardRanges({ value, onChange, label, intraday = true }: {
  value: Range;
  onChange: (range: Range) => void;
  label: string;
  intraday?: boolean;
}) {
  const t = useCopy();
  const phone = useBreakpoint("phone");
  const options = PORTFOLIO_RANGES.filter((range) => intraday || range !== "1D")
    .map((range) => ({ value: range, label: rangeName(range, t("全部", "All")), compact: phoneRanges.has(range) }));
  const more = options.filter((item) => !item.compact);
  const selected = more.find((item) => item.value === value);
  const moreLabel = t("更多区间", "More periods");

  return (
    <div className="mx-dashboard-ranges">
      <Segments label={label} value={value} onChange={onChange} options={options} shortcuts compact={phone} />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<button className="mx-range-more" data-selected={Boolean(selected)} type="button"
            aria-label={moreLabel + (selected ? " · " + selected.label : "")}>
            {selected?.label ?? t("更多", "More")} <ChevronDown size={16} className="-mx-[2px] shrink-0" aria-hidden="true" />
          </button>} />
        <DropdownMenuContent align="end" aria-label={moreLabel}>
          {more.map((item) => (
            <DropdownMenuItem key={item.value} aria-current={value === item.value || undefined}
              onClick={() => onChange(item.value)}>{item.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function WaitingAsOf({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => scheduleLoadingStatus(() => setVisible(true)), []);
  return <span className="mx-waiting-as-of" role="status">{visible ? label : ""}</span>;
}

export function InlineRetry({ label, retry }: { label: string; retry: () => unknown }) {
  const t = useCopy();
  return <div className="mx-retry-reading">
    <span>{label}</span>
    <Button variant="outline" type="button" aria-label={t("重试：", "Retry: ") + label} onClick={() => void retry()}>{t("重试", "Retry")}</Button>
  </div>;
}
