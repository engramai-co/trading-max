"use client";

import type { ResearchShell } from "@/lib/types";
import { ActionIcon, Checkbox, Group, Select, TextInput } from "@mantine/core";
import { MagnifyingGlass, Plus, PushPin } from "@phosphor-icons/react";
import { useState } from "react";
import { Instrument, useCopy } from "./foundation";

type ResearchInstrument = ResearchShell["instruments"][number];

/** Filter and order of the research list; the visible order also drives previous/next. */
export function useResearchUniverse(instruments: ResearchInstrument[]) {
  const [filter, setFilter] = useState("");
  const [heldOnly, setHeldOnly] = useState(false);
  const [category, setCategory] = useState("all");
  const [listSort, setListSort] = useState("held");
  const displayed = instruments
    .filter(
      (i) =>
        (!heldOnly || i.held) &&
        (category === "all" || i.categoryId === category) &&
        (i.ticker + i.name).toLowerCase().includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) =>
      listSort === "az"
        ? a.ticker.localeCompare(b.ticker)
        : Number(b.held) - Number(a.held) || a.order - b.order,
    );
  return {
    filter,
    setFilter,
    heldOnly,
    setHeldOnly,
    category,
    setCategory,
    listSort,
    setListSort,
    displayed,
  };
}

export function UniverseHeading({
  wide,
  pinned,
  onPin,
  onAdd,
}: {
  wide: boolean;
  pinned: boolean;
  onPin: () => void;
  onAdd: () => void;
}) {
  const t = useCopy();
  return (
    <span className="mx-universe-heading">
      <span>{t("研究清单", "Research list")}</span>
      <Group component="span" gap={4}>
        {wide && (
          <ActionIcon
            aria-label={
              pinned
                ? t("取消固定研究清单", "Unpin research list")
                : t("固定研究清单", "Pin research list")
            }
            aria-pressed={pinned}
            variant={pinned ? "light" : "subtle"}
            onClick={onPin}
          >
            <PushPin size={17} weight={pinned ? "fill" : "regular"} />
          </ActionIcon>
        )}
        <ActionIcon
          aria-label={t("添加证券", "Add security")}
          size={30}
          onClick={onAdd}
        >
          <Plus size={16} />
        </ActionIcon>
      </Group>
    </span>
  );
}

export function UniverseList({
  state: {
    filter,
    setFilter,
    heldOnly,
    setHeldOnly,
    category,
    setCategory,
    listSort,
    setListSort,
    displayed,
  },
  categories,
  instruments,
  ticker,
  onSelect,
}: {
  state: ReturnType<typeof useResearchUniverse>;
  categories: ResearchShell["watchlistCategories"];
  instruments: ResearchInstrument[];
  ticker: string;
  onSelect: (ticker: string) => void;
}) {
  const t = useCopy();
  return (
    <>
      <TextInput
        size="xs"
        aria-label={t("筛选研究清单", "Filter research list")}
        placeholder={t("筛选研究清单…", "Filter research list…")}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        leftSection={<MagnifyingGlass size={15} />}
      />
      <Select
        mt="sm"
        size="xs"
        aria-label={t("研究分类", "Research category")}
        value={category}
        onChange={(v) => setCategory(v ?? "all")}
        data={[
          { value: "all", label: t("全部分类", "All categories") },
          ...(categories).map((c) => ({
            value: c.id,
            label:
              t(c.labelZh, c.labelEn) +
              " · " +
              instruments.filter((i) => i.categoryId === c.id).length,
          })),
        ]}
      />
      <Select
        mt="sm"
        size="xs"
        aria-label={t("研究清单排序", "Research list order")}
        value={listSort}
        onChange={(v) => setListSort(v ?? "held")}
        data={[
          { value: "held", label: t("持仓优先", "Held first") },
          { value: "az", label: t("代码 A–Z", "Ticker A–Z") },
        ]}
      />
      <Checkbox
        mt="md"
        size="xs"
        checked={heldOnly}
        onChange={(e) => setHeldOnly(e.currentTarget.checked)}
        label={t("仅看我的持仓", "Held in my portfolio")}
      />
      <div className="mx-watchlist">
        {displayed.map((i) => (
          <button
            key={i.ticker}
            className="mx-watchlist-item"
            data-selected={ticker === i.ticker || undefined}
            onClick={() => onSelect(i.ticker)}
            aria-label={t("研究 ", "Research ") + i.ticker}
          >
            <Instrument ticker={i.ticker} name={i.name} small />
            {i.held && (
              <span
                className="mx-status-dot"
                aria-label={t("已持有", "Held")}
              />
            )}
          </button>
        ))}
      </div>
      {!displayed.length && (
        <p className="mx-form-help">
          {t("没有匹配的标的。", "No securities match this filter.")}
        </p>
      )}
    </>
  );
}
