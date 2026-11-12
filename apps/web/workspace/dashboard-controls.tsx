"use client";

import { Menu } from "@mantine/core";
import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
  const options = PORTFOLIO_RANGES.filter((range) => intraday || range !== "1D")
    .map((range) => ({ value: range, label: rangeName(range, t("全部", "All")), compact: phoneRanges.has(range) }));
  const more = options.filter((item) => !item.compact);
  const selected = more.find((item) => item.value === value);
  const moreLabel = t("更多区间", "More periods");

  return (
    <div className="mx-dashboard-ranges">
      <Segments label={label} value={value} onChange={onChange} options={options} shortcuts />
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <button className="mx-range-more" data-selected={Boolean(selected)} type="button"
            aria-label={moreLabel + (selected ? " · " + selected.label : "")}>
            {selected?.label ?? t("更多", "More")} <CaretDown size={12} aria-hidden="true" />
          </button>
        </Menu.Target>
        <Menu.Dropdown aria-label={moreLabel}>
          {more.map((item) => (
            <Menu.Item key={item.value} aria-current={value === item.value || undefined}
              color={value === item.value ? "blue" : undefined} onClick={() => onChange(item.value)}>{item.label}</Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
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
    <span role="status">{label}</span>
    <button className="mx-inline-retry" type="button" onClick={() => void retry()}>{t("重试", "Retry")}</button>
  </div>;
}
