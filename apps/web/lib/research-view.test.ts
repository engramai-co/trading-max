import { describe, expect, it } from "vitest";

import {
  filterAndPrioritizeResearchInstruments,
  normalizedFundamentalMetrics,
} from "@/lib/research-view";
import type { ResearchInstrument } from "@/lib/types";

function instrument(
  ticker: string,
  categoryId: string,
  held = false,
): ResearchInstrument {
  return {
    ticker,
    categoryId,
    held,
  } as ResearchInstrument;
}

describe("filterAndPrioritizeResearchInstruments", () => {
  const instruments = [
    instrument("WATCH1", "chips"),
    instrument("HELD1", "cloud", true),
    instrument("WATCH2", "chips"),
    instrument("HELD2", "chips", true),
  ];

  it("pins held positions before watchlist-only names in the overview", () => {
    expect(
      filterAndPrioritizeResearchInstruments(instruments, "all").map(
        ({ ticker }) => ticker,
      ),
    ).toEqual(["HELD1", "HELD2", "WATCH1", "WATCH2"]);
  });

  it("keeps the taxonomy filter while still pinning held positions", () => {
    expect(
      filterAndPrioritizeResearchInstruments(instruments, "chips").map(
        ({ ticker }) => ticker,
      ),
    ).toEqual(["HELD2", "WATCH1", "WATCH2"]);
  });
});

describe("normalizedFundamentalMetrics", () => {
  it("reads the production metrics contract", () => {
    expect(
      normalizedFundamentalMetrics({
        metrics: { forwardPE: 21.5, marketCap: 12_000 },
      }),
    ).toMatchObject({ forwardPE: 21.5, marketCap: 12_000 });
  });

  it("keeps backwards compatibility with legacy info snapshots", () => {
    expect(
      normalizedFundamentalMetrics({
        info: { beta: 1.2 },
        metrics: { beta: 0.9, currentRatio: 2.1 },
      }),
    ).toMatchObject({ beta: 1.2, currentRatio: 2.1 });
  });
});
