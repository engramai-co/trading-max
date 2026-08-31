import { describe, expect, it } from "vitest";

import {
  pendingResearchInstrument,
  researchDataRunId,
  researchShellNeedsPolling,
  researchWorkIsPending,
  taxonomyDisplayStatus,
  visibleWatchlistCategories,
  watchlistAddPayload,
} from "@/lib/watchlist";
import type {
  ResearchInstrument,
  SecuritySearchResult,
  WatchlistCategory,
} from "@/lib/types";

const security: SecuritySearchResult = {
  ticker: "GOOGL",
  name: "Alphabet Inc. Class A",
  exchange: "NASDAQ",
  bloombergTicker: "GOOGL US Equity",
  figi: "BBG009S39JX6",
  securityType: "Common Stock",
  alreadyWatched: false,
};

describe("watchlist addition", () => {
  it("wraps a resolved security in the backend request contract", () => {
    expect(watchlistAddPayload(security)).toEqual({
      refresh: true,
      security,
    });
  });

  it("creates an immediate pending research directory entry", () => {
    expect(pendingResearchInstrument(security, 12)).toMatchObject({
      ticker: "GOOGL",
      name: "Alphabet Inc. Class A",
      categoryId: "",
      researchThemeId: null,
      taxonomyStatus: "classifying",
      order: 12,
      status: "pending",
      hasMarket: false,
      hasTechnical: false,
      hasValuation: false,
    });
  });

  it("never exposes legacy or pending taxonomy buckets as user-facing filters", () => {
    const categories: WatchlistCategory[] = [
      {
        id: "new-ideas",
        labelZh: "新想法",
        labelEn: "New ideas",
        descriptionZh: "",
        descriptionEn: "",
        order: 0,
        taxonomy: "llm-taxonomy",
        code: null,
      },
      {
        id: "taxonomy-pending",
        labelZh: "待分类",
        labelEn: "Pending",
        descriptionZh: "",
        descriptionEn: "",
        order: 1,
        taxonomy: "llm-taxonomy",
        code: null,
      },
      {
        id: "ai-infrastructure",
        labelZh: "AI 基础设施",
        labelEn: "AI infrastructure",
        descriptionZh: "",
        descriptionEn: "",
        order: 2,
        taxonomy: "llm-taxonomy",
        code: null,
      },
    ];

    expect(visibleWatchlistCategories(categories).map((item) => item.id)).toEqual([
      "ai-infrastructure",
    ]);
  });

  it("keeps legacy unclassified items visible under All with a review status", () => {
    const instrument = {
      ...pendingResearchInstrument(security, 12),
      categoryId: "new-ideas",
      taxonomyStatus: undefined,
      status: "ready",
    } satisfies ResearchInstrument;

    expect(taxonomyDisplayStatus(instrument)).toBe("needs-review");
  });

  it("uses explicit taxonomy workflow status independently of research readiness", () => {
    const instrument = pendingResearchInstrument(security, 12);

    expect(taxonomyDisplayStatus({ ...instrument, status: "ready" })).toBe("classifying");
    expect(taxonomyDisplayStatus({ ...instrument, taxonomyStatus: "assigned" })).toBe("assigned");
    expect(taxonomyDisplayStatus({ ...instrument, taxonomyStatus: "needs-review" })).toBe("needs-review");
  });

  it("keeps polling for server-restored research and taxonomy work", () => {
    const pending = pendingResearchInstrument(security, 12);
    const ready = {
      ...pending,
      status: "ready",
      taxonomyStatus: "assigned",
    } satisfies ResearchInstrument;

    expect(researchWorkIsPending(pending)).toBe(true);
    expect(researchShellNeedsPolling([pending])).toBe(true);
    expect(researchShellNeedsPolling([{ ...ready, taxonomyStatus: "classifying" }])).toBe(true);
    expect(researchShellNeedsPolling([ready])).toBe(false);
    expect(researchDataRunId({ ...ready, lastRunId: "ticker-run" }, "global-run"))
      .toBe("ticker-run");
    expect(researchDataRunId(ready, "global-run")).toBe("global-run");
  });
});
