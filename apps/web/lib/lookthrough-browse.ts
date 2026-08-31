import type { LookthroughPosition } from "@/lib/types";

export type LookthroughExposureFilter = "all" | "direct" | "indirect" | "mixed";
export type LookthroughSort = "exposure" | "direct" | "indirect" | "name";

export type LookthroughBrowseState = {
  country: string;
  exposure: LookthroughExposureFilter;
  page: number;
  sector: string;
  sort: LookthroughSort;
};

export const lookthroughExposureFilters: LookthroughExposureFilter[] = [
  "all",
  "direct",
  "indirect",
  "mixed",
];

export const lookthroughSorts: LookthroughSort[] = [
  "exposure",
  "direct",
  "indirect",
  "name",
];

export const unclassifiedSector = "__unclassified__";

export function lookthroughSector(position: LookthroughPosition): string {
  return position.gics?.sectorName || unclassifiedSector;
}

export function browseLookthroughPositions(
  positions: LookthroughPosition[],
  query: string,
  state: Pick<LookthroughBrowseState, "country" | "exposure" | "sector" | "sort">,
): LookthroughPosition[] {
  const normalized = query.trim().toLowerCase();
  const filtered = positions.filter((position) => {
    const matchesQuery = !normalized || [
      position.ticker,
      position.name,
      position.isin,
      position.country,
      position.gics?.sectorName,
      position.gics?.subIndustryName,
    ].some((value) => value?.toLowerCase().includes(normalized));
    const matchesCountry = state.country === "all"
      || (position.country ?? "__unknown__") === state.country;
    const matchesSector = state.sector === "all"
      || lookthroughSector(position) === state.sector;
    const hasDirect = position.directValueGbp > 0.005;
    const hasIndirect = position.indirectValueGbp > 0.005;
    const matchesExposure = state.exposure === "all"
      || (state.exposure === "direct" && hasDirect && !hasIndirect)
      || (state.exposure === "indirect" && hasIndirect && !hasDirect)
      || (state.exposure === "mixed" && hasDirect && hasIndirect);
    return matchesQuery && matchesCountry && matchesSector && matchesExposure;
  });

  return filtered.sort((left, right) => {
    if (state.sort === "name") return left.name.localeCompare(right.name);
    if (state.sort === "direct") return right.directValueGbp - left.directValueGbp;
    if (state.sort === "indirect") return right.indirectValueGbp - left.indirectValueGbp;
    return right.valueGbp - left.valueGbp;
  });
}
