"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Segments, useCopy } from "./foundation";
import { SearchPicker } from "./picker";

type MarketOption<T extends string> = {
  value: T;
  label: string;
  short?: string;
  marker?: string;
};

const common = ["global", "us", "eu", "uk", "jp"];
const regions = [
  { markets: ["cn", "hk", "kr", "tw", "in", "au"], zh: "亚太", en: "Asia Pacific" },
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
    <SearchPicker
      className="mx-sector-market-picker"
      aria-label={label}
      value={value}
      onChange={pick}
      nothingFoundMessage={t("没有匹配的市场", "No matching market")}
      options={[
        ...fixed.map(({ value, label }) => ({ value, label })),
        ...grouped.filter(({ options }) => options.length).map(({ group, options }) => ({
          group, items: options.map(({ value, label }) => ({ value, label })),
        })),
      ]}
      renderOption={(option) => {
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
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={
          <Button
            variant="outline"
            aria-label={t("更多市场", "More markets") + (selected ? `: ${selected.label}` : "")}
            data-selected-market={selected ? "" : undefined}
          >
            {selected?.label ?? t("更多", "More")}
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
        } />
        <DropdownMenuContent align="end" aria-label={t("更多市场", "More markets")}>
          {grouped.filter(({ options }) => options.length).map(({ group, options }) => (
            <DropdownMenuGroup key={group}>
              <DropdownMenuLabel>{group}</DropdownMenuLabel>
              {options.map((option) => (
                <DropdownMenuItem key={option.value} aria-current={option.value === value ? "true" : undefined} onClick={() => pick(option.value)}>
                  {option.marker && <span className="mx-segment-marker" aria-label={option.marker} />} {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
