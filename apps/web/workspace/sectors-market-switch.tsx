"use client";

import { Button, Menu, Select } from "@mantine/core";
import { CaretDown } from "@phosphor-icons/react";
import { Segments, useCopy } from "./foundation";

type MarketOption<T extends string> = {
  value: T;
  label: string;
  short?: string;
  marker?: string;
};

const common = ["global", "us", "eu", "uk", "jp"];
const regions = [
  { markets: ["hk", "kr", "tw", "in", "au"], zh: "亚太", en: "Asia Pacific" },
  { markets: ["de", "fr", "ch"], zh: "欧洲", en: "Europe" },
  { markets: ["ca"], zh: "美洲", en: "Americas" },
];

export function SectorMarketSwitch<T extends string>({ value, onChange, options, phone }: {
  value: T;
  onChange: (value: T) => void;
  options: MarketOption<T>[];
  phone: boolean;
}) {
  const t = useCopy();
  const label = t("市场", "Market");
  if (options.length <= 5) return <Segments label={label} value={value} onChange={onChange} options={options} shortcuts />;

  const fixed = common.flatMap((id) => options.filter((option) => option.value === id));
  const extra = options.filter((option) => !fixed.includes(option));
  const selected = extra.find((option) => option.value === value);
  const grouped = regions.map((region) => ({
    group: t(region.zh, region.en),
    options: extra.filter((option) => region.markets.includes(option.value)),
  }));
  const other = extra.filter((option) => !grouped.some((group) => group.options.includes(option)));
  if (other.length) grouped.push({ group: t("其他市场", "Other markets"), options: other });
  const pick = (id: string | null) => {
    const next = options.find((option) => option.value === id);
    if (next) onChange(next.value);
  };
  if (phone) return (
    <Select
      className="mx-sector-market-picker"
      styles={{ input: { minHeight: 44 } }}
      aria-label={label}
      value={value}
      onChange={pick}
      searchable
      allowDeselect={false}
      nothingFoundMessage={t("没有匹配的市场", "No matching market")}
      data={[
        ...fixed.map(({ value, label }) => ({ value, label })),
        ...grouped.filter(({ options }) => options.length).map(({ group, options }) => ({
          group, items: options.map(({ value, label }) => ({ value, label })),
        })),
      ]}
      renderOption={({ option }) => {
        const marker = options.find(({ value }) => value === option.value)?.marker;
        return <span className="mx-segment-label">
          {marker && <span className="mx-segment-marker" aria-hidden="true" />}
          {option.label}
          {marker && <span className="sr-only">{`, ${marker}`}</span>}
        </span>;
      }}
    />
  );
  return (
    <div className="mx-sector-market-overflow">
      <Segments label={label} value={value} onChange={onChange} options={fixed} shortcuts />
      <Menu position="bottom-end">
        <Menu.Target>
          <Button
            variant="default"
            rightSection={<CaretDown size={14} aria-hidden="true" />}
            aria-label={t("更多市场", "More markets") + (selected ? `: ${selected.label}` : "")}
            data-selected-market={selected ? "" : undefined}
          >
            {selected?.label ?? t("更多", "More")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {grouped.filter(({ options }) => options.length).map(({ group, options }) => (
            <div key={group}>
              <Menu.Label>{group}</Menu.Label>
              {options.map((option) => (
                <Menu.Item key={option.value} aria-current={option.value === value ? "true" : undefined} onClick={() => pick(option.value)}>
                  {option.marker && <span className="mx-segment-marker" aria-label={option.marker} />} {option.label}
                </Menu.Item>
              ))}
            </div>
          ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
