"use client";

import type { ResearchShell } from "@/lib/types";
import { ActionIcon, Checkbox, Select, TextInput } from "@mantine/core";
import { MagnifyingGlass, PushPin } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { evidenceNoticesQuery } from "./evidence-notices";
import { Instrument, useCopy } from "./foundation";
import Link from "./link";
import {
  indexDirectory, researchIndexHref, matchIndices, useIndexCatalog, type IndexIdentity,
} from "./market-indices-data";
import { useListedIndices } from "./listed-indices";

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
        (i.watchlisted !== false || i.held) &&
        (!heldOnly || i.held) &&
        (category === "all" || i.categoryId === category) &&
        (i.ticker + i.name).toLowerCase().includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) =>
      listSort === "az"
        ? a.ticker.localeCompare(b.ticker)
        : Number(b.held) - Number(a.held) || Number(Boolean(a.isFund)) - Number(Boolean(b.isFund))
          || (a.isFund ? a.ticker.localeCompare(b.ticker) : a.order - b.order),
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
  onSearch,
}: {
  wide: boolean;
  pinned: boolean;
  onPin: () => void;
  onSearch: () => void;
}) {
  const t = useCopy();
  return (
    <span className="mx-universe-heading">
      <span>{t("研究清单", "Research list")}</span>
      <span className="flex flex-wrap items-center gap-1">
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
          aria-label={t("搜索", "Search")}
          variant="subtle"
          onClick={onSearch}
        >
          <MagnifyingGlass size={17} />
        </ActionIcon>
      </span>
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
  indexId,
  onSelect,
}: {
  state: ReturnType<typeof useResearchUniverse>;
  categories: ResearchShell["watchlistCategories"];
  instruments: ResearchInstrument[];
  ticker: string;
  /** The index open beside the list, if any. */
  indexId?: string;
  onSelect: (ticker: string) => void;
}) {
  const t = useCopy();
  const listed = useListedIndices();
  const notices = useQuery(evidenceNoticesQuery).data?.notices;
  const isIndexCategory = category === "indices";
  const query = filter.trim();
  const showIndices = !heldOnly && (category === "all" || isIndexCategory);
  const catalog = useIndexCatalog(showIndices && (listed.ids.length > 0 || isIndexCategory || query.length >= 2));
  const inList = listed.ids
    .map((id) => catalog.data?.find((index) => index.id === id))
    .filter((index): index is IndexIdentity => index !== undefined);
  // Listed indices sit in the list like stocks and funds; a filter also finds other indices.
  const indices = !showIndices ? []
    : isIndexCategory && !query ? indexDirectory(catalog.data, listed.ids)
    : query ? matchIndices(catalog.data, query).slice(0, isIndexCategory ? 60 : 5 + inList.length)
    : inList;
  const order = (a: (typeof indices)[number], b: (typeof indices)[number]) =>
    Number(listed.has(b.id)) - Number(listed.has(a.id));
  return (
    <>
      <TextInput
        size="xs"
        aria-label={t("筛选研究清单", "Filter research list")}
        placeholder={t("筛选", "Filter")}
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
          { value: "indices", label: t("指数", "Indices") },
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
        disabled={isIndexCategory}
        onChange={(e) => setHeldOnly(e.currentTarget.checked)}
        label={t("仅看持仓", "Holdings only")}
      />
      <div className="mx-watchlist">
        {!isIndexCategory && displayed.map((i) => (
          <button
            key={i.ticker}
            className="mx-watchlist-item"
            data-selected={ticker === i.ticker || undefined}
            onClick={() => onSelect(i.ticker)}
          >
            <Instrument ticker={i.ticker} name={i.name} small />
            {notices?.some((notice) => notice.ticker === i.ticker.toUpperCase()) && (
              <span className="mx-evidence-dot" role="img" aria-label={t("有新证据", "New evidence")} />
            )}
            {i.held && (
              <span
                className="mx-status-dot"
                role="img"
                aria-label={t("已持有", "Held")}
              />
            )}
          </button>
        ))}
        {[...indices].sort(order).map((index) => (
          <Link
            key={index.id}
            className="mx-watchlist-item mx-research-index-result"
            data-selected={indexId === index.id || undefined}
            href={researchIndexHref(index)}
          >
            <Instrument ticker={t(index.nameZh, index.name)} name={index.symbol ?? index.compiler} small />
            <span className="mx-form-help">{t("指数", "Index")}</span>
          </Link>
        ))}
      </div>
      {(isIndexCategory || !displayed.length) && !indices.length && (
        <p className="mx-form-help">
          {t("没有匹配项", "No matches")}
        </p>
      )}
    </>
  );
}
