import type {
  ResearchInstrument,
  SecuritySearchResult,
  WatchlistCategory,
} from "@/lib/types";

export type TaxonomyDisplayStatus =
  | "classifying"
  | "assigned"
  | "needs-review";

const hiddenTaxonomyCategoryIds = new Set([
  "new-ideas",
  "taxonomy-pending",
  "unclassified",
]);

export function isHiddenTaxonomyCategory(categoryId: string | null | undefined) {
  return !categoryId || hiddenTaxonomyCategoryIds.has(categoryId);
}

export function visibleWatchlistCategories(categories: WatchlistCategory[]) {
  return categories.filter((category) => !isHiddenTaxonomyCategory(category.id));
}

export function taxonomyDisplayStatus(
  instrument: ResearchInstrument,
): TaxonomyDisplayStatus {
  if (instrument.taxonomyStatus === "assigned") return "assigned";
  if (
    instrument.taxonomyStatus === "needs-review"
    || instrument.taxonomyStatus === "unclassified"
  ) return "needs-review";
  if (instrument.taxonomyStatus === "classifying") return "classifying";
  if (!isHiddenTaxonomyCategory(instrument.categoryId)) return "assigned";
  return instrument.status === "pending" || instrument.status === "running"
    ? "classifying"
    : "needs-review";
}

export function researchWorkIsPending(instrument: ResearchInstrument) {
  return instrument.status === "pending" || instrument.status === "running";
}

export function researchShellNeedsPolling(instruments: ResearchInstrument[]) {
  return instruments.some((instrument) => (
    researchWorkIsPending(instrument)
    || taxonomyDisplayStatus(instrument) === "classifying"
  ));
}

export function researchDataRunId(
  instrument: ResearchInstrument | undefined,
  fallbackRunId: string,
) {
  return instrument?.lastRunId ?? fallbackRunId;
}

export function watchlistAddPayload(security: SecuritySearchResult) {
  return {
    refresh: true,
    security,
  };
}

export function pendingResearchInstrument(
  security: SecuritySearchResult,
  order: number,
): ResearchInstrument {
  return {
    ticker: security.ticker,
    name: security.name,
    exchange: security.exchange,
    website: "",
    bloombergTicker: security.bloombergTicker,
    figi: security.figi,
    categoryId: "",
    researchThemeId: null,
    taxonomyStatus: "classifying",
    taxonomyLabelZh: null,
    taxonomyLabelEn: null,
    gics: null,
    order,
    status: "pending",
    lastRunId: null,
    lastError: null,
    hasMarket: false,
    hasTechnical: false,
    hasOptions: false,
    hasValuation: false,
    hasEarnings: false,
    hasFundamentals: false,
    held: false,
    exposureGbp: 0,
  };
}
