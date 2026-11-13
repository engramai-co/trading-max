import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { industryName } from "./exposure-names";
import { adaptWorldSectors, worldIndustryRows, type GlobalSectorBoard } from "./global-sectors";
import { groupName } from "./sectors-map";

type Node = {
  sectorCode: string;
  sectorName: string;
  industryGroupCode: string;
  industryGroupName: string;
};

describe("Global sector labels", () => {
  it("matches the shared names for all 11 sectors and 25 industry groups in both languages", () => {
    const { nodes } = JSON.parse(readFileSync(
      new URL("../../../backend/src/trading_max/reference/data/gics-nodes-2026.json", import.meta.url), "utf8",
    )) as { nodes: Node[] };
    const sectorNames = new Map(nodes.map(({ sectorCode, sectorName }) => [sectorCode, sectorName]));
    const groupNames = new Map(nodes.map(({ industryGroupCode, industryGroupName }) => [industryGroupCode, industryGroupName]));
    const reading = (gics: string, name: string) => ({ gics, name, indexCode: null, move: 0.01 });
    const board: GlobalSectorBoard = {
      referenceDate: null, phase: null, asOf: null, acwiMove: null, acwiLevel: null,
      weightsAsOf: null, weightsStale: false, pricesStale: false, rankSessions: [],
      sectors: [...sectorNames].map(([gics, name]) => ({
        ...reading(gics, name), weight: 0.05, contribution: null, intraday: [], ranks: [], holdings: [],
        groups: [...groupNames].filter(([code]) => code.startsWith(gics)).map(([code, label]) => reading(code, label)),
      })),
    };
    const { groups } = adaptWorldSectors(board);
    expect(groups).toHaveLength(11);
    expect(board.sectors.flatMap(({ groups }) => groups)).toHaveLength(25);
    for (const locale of ["zh", "en"] as const) {
      for (const sector of groups) {
        const name = sectorNames.get(sector.key);
        const label = groupName(sector, "gics", locale);
        expect(label).toBe(industryName(name, locale));
        if (locale === "zh") expect(label).not.toBe(name);
      }
      for (const { groups } of board.sectors) {
        for (const { gics, label } of worldIndustryRows(groups, locale)) {
          const name = groupNames.get(gics);
          expect(label).toBe(industryName(name, locale));
          if (locale === "zh") expect(label).not.toBe(name);
        }
      }
    }
  });
});
