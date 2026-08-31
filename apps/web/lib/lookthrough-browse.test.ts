import { describe, expect, it } from "vitest";

import {
  browseLookthroughPositions,
  lookthroughSector,
  unclassifiedSector,
} from "@/lib/lookthrough-browse";
import type { LookthroughPosition } from "@/lib/types";

function position(
  name: string,
  overrides: Partial<LookthroughPosition> = {},
): LookthroughPosition {
  return {
    allocationPct: 0.1,
    country: "United States",
    directValueGbp: 0,
    entityId: name,
    etfContributors: [],
    gics: null,
    gicsStatus: "pending-classification",
    identitySource: "synthetic-test",
    indirectValueGbp: 100,
    isin: `ISIN-${name}`,
    name,
    resolutionConfidence: 1,
    resolutionMethod: "isin",
    securityType: "Equity",
    ticker: name.slice(0, 3).toUpperCase(),
    valueGbp: 100,
    ...overrides,
  };
}

describe("browseLookthroughPositions", () => {
  const rows = [
    position("Alpha", {
      directValueGbp: 80,
      gics: {
        asOf: "2026-08-25",
        confidence: 1,
        industryCode: "1",
        industryGroupCode: "1",
        industryGroupName: "Software",
        industryName: "Software",
        method: "official",
        sectorCode: "45",
        sectorName: "Information Technology",
        source: "fixture",
        subIndustryCode: "1",
        subIndustryName: "Application Software",
        version: "2026",
      },
      indirectValueGbp: 20,
      valueGbp: 100,
    }),
    position("Beta", {
      country: "United Kingdom",
      indirectValueGbp: 250,
      valueGbp: 250,
    }),
    position("Gamma", {
      directValueGbp: 150,
      indirectValueGbp: 0,
      valueGbp: 150,
    }),
  ];

  it("filters across query, country, sector, and exposure provenance", () => {
    expect(browseLookthroughPositions(rows, "alp", {
      country: "United States",
      exposure: "mixed",
      sector: "Information Technology",
      sort: "exposure",
    }).map((row) => row.name)).toEqual(["Alpha"]);
  });

  it("sorts the evidence set before pagination", () => {
    expect(browseLookthroughPositions(rows, "", {
      country: "all",
      exposure: "all",
      sector: "all",
      sort: "direct",
    }).map((row) => row.name)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("keeps unresolved classification explicit", () => {
    expect(lookthroughSector(rows[1])).toBe(unclassifiedSector);
    expect(browseLookthroughPositions(rows, "", {
      country: "all",
      exposure: "all",
      sector: unclassifiedSector,
      sort: "name",
    })).toHaveLength(2);
  });
});
