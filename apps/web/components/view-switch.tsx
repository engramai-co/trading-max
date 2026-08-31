"use client";

import { SegmentedControl } from "@mantine/core";

export function ViewSwitch({
  data,
  label,
  onChange,
  value,
}: {
  data: Array<{ label: React.ReactNode; value: string }>;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <SegmentedControl
      aria-label={label}
      className="tm-view-switch"
      data={data}
      onChange={onChange}
      size="md"
      value={value}
    />
  );
}
