import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookthroughPosition } from "@/lib/types";
import {
  filterPreparedPositions,
  prepareLookthroughPositions,
  sortPreparedPositions,
  yieldToMain,
} from "./look-through-data";

const makeGics = (sectorName: string) => ({
  asOf: "2026-11-04",
  confidence: 1,
  industryCode: "4510",
  industryGroupCode: "4510",
  industryGroupName: "Software & Services",
  industryName: "Software & Services",
  method: "official" as const,
  sectorCode: "45",
  sectorName,
  source: "synthetic",
  subIndustryCode: "45103010",
  subIndustryName: "Application Software",
  version: "2023",
});

const position = (
  index: number,
  overrides: Partial<LookthroughPosition> = {},
): LookthroughPosition => ({
  entityId: `ent-${index}`,
  ticker: `T${index}`,
  name: `Company ${index}`,
  isin: `US000000${String(index).padStart(4, "0")}`,
  country: index % 2 === 0 ? "United States" : "United Kingdom",
  valueGbp: 1000 - index,
  allocationPct: (1000 - index) / 100000,
  directValueGbp: index % 3 === 0 ? 1000 - index : 0,
  indirectValueGbp: index % 3 === 0 ? 0 : 1000 - index,
  gics: makeGics(index % 2 === 0 ? "Information Technology" : "Financials"),
  gicsStatus: "classified",
  identitySource: "synthetic",
  resolutionConfidence: 1,
  resolutionMethod: "isin",
  securityType: "EQUITY",
  etfContributors: [],
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepareLookthroughPositions", () => {
  it("normalizes country aliases, localizes options and preserves guaranteed-unique keys", () => {
    const positions = [
      position(1, { entityId: "", country: "Taiwan", gics: makeGics("Financials") }),
      position(2, { entityId: "", country: "Taiwan Region", gics: makeGics("Information Technology") }),
      position(3, { entityId: "dup", country: "United States", gics: makeGics("Financials") }),
      position(4, { entityId: "dup", country: null, gics: null }),
    ];

    const en = prepareLookthroughPositions(positions, "en");
    expect(en.countries).toEqual([
      { value: "TW", label: "Taiwan" },
      { value: "US", label: "United States" },
    ]);
    expect(en.sectors).toEqual([
      { value: "Financials", label: "Financials" },
      { value: "Information Technology", label: "Information Technology" },
    ]);
    expect(new Set(en.items.map((item) => item.key)).size).toBe(4);
    expect(en.items[0].countryKey).toBe("TW");
    expect(en.items[1].countryKey).toBe("TW");

    const zh = prepareLookthroughPositions(positions, "zh");
    expect(zh.sectors.map((s) => s.value)).toEqual(["Financials", "Information Technology"]);
    expect(zh.sectors.map((s) => s.label)).toEqual(["金融", "信息技术"]);
    expect(zh.items[0].searchText).toContain("金融");
  });
});

describe("sortPreparedPositions & filterPreparedPositions", () => {
  const sample = prepareLookthroughPositions(
    [
      position(1, { name: "Zeta Corp", valueGbp: 500, directValueGbp: 500, indirectValueGbp: 0, country: "United States" }),
      position(2, { name: "Alpha Corp", valueGbp: 300, directValueGbp: 0, indirectValueGbp: 300, country: "Taiwan Region" }),
      position(3, { name: "Beta Corp", valueGbp: 400, directValueGbp: 150, indirectValueGbp: 250, country: "Taiwan" }),
    ],
    "en",
  ).items;

  it("sorts across all four modes without mutating input", () => {
    expect(sortPreparedPositions(sample, "total").map((r) => r.position.name)).toEqual([
      "Zeta Corp",
      "Beta Corp",
      "Alpha Corp",
    ]);
    expect(sortPreparedPositions(sample, "direct").map((r) => r.position.name)).toEqual([
      "Zeta Corp",
      "Beta Corp",
      "Alpha Corp",
    ]);
    expect(sortPreparedPositions(sample, "indirect").map((r) => r.position.name)).toEqual([
      "Alpha Corp",
      "Beta Corp",
      "Zeta Corp",
    ]);
    expect(sortPreparedPositions(sample, "name").map((r) => r.position.name)).toEqual([
      "Alpha Corp",
      "Beta Corp",
      "Zeta Corp",
    ]);
    expect(sample[0].position.name).toBe("Zeta Corp");
  });

  it("filters by country alias, sector, ownership and multi-word search while preserving order", () => {
    const byName = sortPreparedPositions(sample, "name");
    expect(
      filterPreparedPositions(byName, { search: "", country: "TW", sector: "all", ownership: "all" })
        .map((r) => r.position.name),
    ).toEqual(["Alpha Corp", "Beta Corp"]);

    expect(
      filterPreparedPositions(byName, { search: "", country: "all", sector: "all", ownership: "direct" })
        .map((r) => r.position.name),
    ).toEqual(["Zeta Corp"]);
    expect(
      filterPreparedPositions(byName, { search: "", country: "all", sector: "all", ownership: "indirect" })
        .map((r) => r.position.name),
    ).toEqual(["Alpha Corp"]);
    expect(
      filterPreparedPositions(byName, { search: "", country: "all", sector: "all", ownership: "both" })
        .map((r) => r.position.name),
    ).toEqual(["Beta Corp"]);

    expect(
      filterPreparedPositions(byName, { search: "  zeta corp  ", country: "US", sector: "all", ownership: "all" })
        .map((r) => r.position.name),
    ).toEqual(["Zeta Corp"]);
  });

  it("keeps zero and negative values outside the ownership categories", () => {
    const positions = [
      position(1, { directValueGbp: 0, indirectValueGbp: 0 }),
      position(2, { directValueGbp: -5, indirectValueGbp: 0 }),
      position(3, { directValueGbp: 10, indirectValueGbp: -5 }),
      position(4, { directValueGbp: -5, indirectValueGbp: 10 }),
    ];
    const { items } = prepareLookthroughPositions(positions, "en");
    const criteria = { search: "", country: "all", sector: "all" };
    expect(items.map((row) => row.ownership)).toEqual([null, null, null, null]);
    expect(filterPreparedPositions(items, { ...criteria, ownership: "all" })).toEqual(items);
    for (const ownership of ["direct", "indirect", "both"] as const) {
      expect(filterPreparedPositions(items, { ...criteria, ownership })).toEqual([]);
    }
  });

  it("handles 5,100 rows cleanly", () => {
    const raw = Array.from({ length: 5100 }, (_, i) => position(i));
    const prepared = prepareLookthroughPositions(raw, "en");
    const sorted = sortPreparedPositions(prepared.items, "name");
    const filtered = filterPreparedPositions(sorted, {
      search: "T5099",
      country: "all",
      sector: "all",
      ownership: "all",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].position.ticker).toBe("T5099");
  });
});

describe("yieldToMain", () => {
  it("uses scheduler.yield when available and falls back to a timer otherwise", async () => {
    const yieldSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("scheduler", { yield: yieldSpy });
    await yieldToMain();
    expect(yieldSpy).toHaveBeenCalledTimes(1);

    vi.stubGlobal("scheduler", undefined);
    await expect(yieldToMain()).resolves.toBeUndefined();
  });
});
