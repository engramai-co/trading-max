import type { Locale } from "@/components/locale-provider";
import type { LookthroughPosition } from "@/lib/types";
import { countryCode, countryName, industryName } from "./exposure-names";

/** Rows mounted per yielded batch during incremental expansion. */
export const LOOKTHROUGH_BATCH_SIZE = 50;

type OwnershipCategory = "direct" | "indirect" | "both";
export type LookthroughOwnership = "all" | OwnershipCategory;
export type LookthroughSort = "total" | "direct" | "indirect" | "name";
export type LookthroughOption = { value: string; label: string };

export type PreparedLookthroughRow = {
  position: LookthroughPosition;
  key: string;
  countryKey: string;
  countryLabel: string;
  sectorKey: string;
  ownership: OwnershipCategory | null;
  searchText: string;
};

export type PreparedLookthroughData = {
  items: PreparedLookthroughRow[];
  sectors: LookthroughOption[];
  countries: LookthroughOption[];
};

export type LookthroughFilterCriteria = {
  search: string;
  country: string;
  sector: string;
  ownership: LookthroughOwnership;
};

const collators = new Map<Locale, Intl.Collator>();
function labelCollator(locale: Locale) {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale === "zh" ? "zh-CN" : "en-GB");
    collators.set(locale, collator);
  }
  return collator;
}

const nameCollator = new Intl.Collator();

type SchedulerLike = { yield?: () => Promise<void> };

/** Yields to the main thread using scheduler.yield() when available, or a timer fallback. */
export function yieldToMain(): Promise<void> {
  const schedulerObj = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (typeof schedulerObj?.yield === "function") {
    return schedulerObj.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Normalizes country names to canonical ISO keys matching filter totals ("Taiwan" / "Taiwan Region"). */
export function lookthroughCountryKey(name: string | null | undefined) {
  return countryCode(name) ?? name ?? "";
}

/**
 * Prepares per-position search strings, cached labels, unique filter options and stable keys
 * once per snapshot/locale change instead of on every render or keystroke.
 */
export function prepareLookthroughPositions(
  positions: LookthroughPosition[],
  locale: Locale,
): PreparedLookthroughData {
  const countryKeyCache = new Map<string, string>();
  const countryLabelCache = new Map<string, string>();
  const industryCache = new Map<string, string>();
  const sectorSet = new Set<string>();
  const countryMap = new Map<string, LookthroughOption>();
  const seenKeys = new Set<string>();

  const getCountryKey = (raw: string | null | undefined) => {
    const k = raw ?? "";
    let cached = countryKeyCache.get(k);
    if (cached === undefined) {
      cached = lookthroughCountryKey(raw);
      countryKeyCache.set(k, cached);
    }
    return cached;
  };

  const getCountryLabel = (raw: string | null | undefined) => {
    const k = raw ?? "";
    let cached = countryLabelCache.get(k);
    if (cached === undefined) {
      cached = countryName(raw, locale);
      countryLabelCache.set(k, cached);
    }
    return cached;
  };

  const getIndustryLabel = (raw: string | null | undefined) => {
    const k = raw ?? "";
    let cached = industryCache.get(k);
    if (cached === undefined) {
      cached = industryName(raw, locale);
      industryCache.set(k, cached);
    }
    return cached;
  };

  const items: PreparedLookthroughRow[] = new Array(positions.length);

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const cKey = getCountryKey(p.country);
    const cLabel = getCountryLabel(p.country);
    const sectorName = p.gics?.sectorName;
    const subIndustryName = p.gics?.subIndustryName;

    if (sectorName) sectorSet.add(sectorName);
    if (p.country && !countryMap.has(cKey)) {
      countryMap.set(cKey, { value: cKey, label: cLabel });
    }

    const direct = p.directValueGbp;
    const indirect = p.indirectValueGbp;
    let ownership: OwnershipCategory | null = null;
    if (direct > 0 && indirect === 0) ownership = "direct";
    else if (indirect > 0 && direct === 0) ownership = "indirect";
    else if (direct > 0 && indirect > 0) ownership = "both";

    const key = p.entityId && !seenKeys.has(p.entityId) ? `entity:${p.entityId}` : `row:${i}`;
    seenKeys.add(p.entityId);

    const searchText = [
      p.name,
      p.ticker,
      p.isin,
      sectorName,
      p.gics?.industryName,
      subIndustryName,
      getIndustryLabel(sectorName),
      getIndustryLabel(subIndustryName),
      cLabel,
    ]
      .join(" ")
      .toLowerCase();

    items[i] = {
      position: p,
      key,
      countryKey: cKey,
      countryLabel: cLabel,
      sectorKey: sectorName ?? "",
      ownership,
      searchText,
    };
  }

  const compare = labelCollator(locale).compare;
  const sectors = Array.from(sectorSet, (value) => ({
    value,
    label: getIndustryLabel(value),
  })).sort((a, b) => compare(a.label, b.label));

  const countries = Array.from(countryMap.values()).sort((a, b) =>
    compare(a.label, b.label),
  );

  return { items, sectors, countries };
}

/** Sorts prepared rows without mutating the source array. */
export function sortPreparedPositions(
  items: PreparedLookthroughRow[],
  sort: LookthroughSort,
): PreparedLookthroughRow[] {
  const copy = items.slice();
  copy.sort((a, b) =>
    sort === "name"
      ? nameCollator.compare(a.position.name, b.position.name)
      : sort === "direct"
        ? b.position.directValueGbp - a.position.directValueGbp
        : sort === "indirect"
          ? b.position.indirectValueGbp - a.position.indirectValueGbp
          : b.position.valueGbp - a.position.valueGbp,
  );
  return copy;
}

function matchesRow(
  row: PreparedLookthroughRow,
  { country, sector, ownership }: LookthroughFilterCriteria,
  query: string,
): boolean {
  if (country !== "all" && row.countryKey !== country) return false;
  if (sector !== "all" && row.sectorKey !== sector) return false;
  if (ownership !== "all" && row.ownership !== ownership) return false;
  return query === "" || row.searchText.includes(query);
}

/** Filters sorted prepared rows synchronously, preserving relative sort order. */
export function filterPreparedPositions(
  items: PreparedLookthroughRow[],
  criteria: LookthroughFilterCriteria,
): PreparedLookthroughRow[] {
  const query = criteria.search.trim().toLowerCase();
  if (
    query === "" &&
    criteria.country === "all" &&
    criteria.sector === "all" &&
    criteria.ownership === "all"
  ) {
    return items;
  }
  const result: PreparedLookthroughRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    if (matchesRow(row, criteria, query)) {
      result.push(row);
    }
  }
  return result;
}
