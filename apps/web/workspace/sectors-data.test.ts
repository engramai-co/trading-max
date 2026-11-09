import { describe, expect, it } from "vitest";
import {
  byStanding, displaySymbol, heat, issuerName, marketPhase, neighbour, sectorMarket, sessionPosition, sparkline, squarify,
  strongestGroup,
} from "./sectors-data";
import type { SectorGroup } from "@/lib/types";

const box = { x: 0, y: 0, w: 600, h: 400 };

describe("sector map layout", () => {
  it("gives every positive weight an area in proportion, inside the box", () => {
    const items = [
      { key: "45", weight: 0.32 }, { key: "40", weight: 0.13 }, { key: "50", weight: 0.1 },
      { key: "25", weight: 0.1 }, { key: "35", weight: 0.09 }, { key: "20", weight: 0.08 },
      { key: "30", weight: 0.05 }, { key: "10", weight: 0.03 }, { key: "55", weight: 0.025 },
      { key: "60", weight: 0.02 }, { key: "15", weight: 0.02 }, { key: "zero", weight: 0 },
    ];
    const tiles = squarify(items, box);
    expect(tiles.map((tile) => tile.key).sort()).toEqual(items.filter((item) => item.weight > 0).map((item) => item.key).sort());
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    for (const tile of tiles) {
      const weight = items.find((item) => item.key === tile.key)!.weight;
      expect(tile.w * tile.h).toBeCloseTo((weight / total) * box.w * box.h, 6);
      expect(tile.x).toBeGreaterThanOrEqual(-1e-9);
      expect(tile.y).toBeGreaterThanOrEqual(-1e-9);
      expect(tile.x + tile.w).toBeLessThanOrEqual(box.w + 1e-6);
      expect(tile.y + tile.h).toBeLessThanOrEqual(box.h + 1e-6);
    }
    // Squarified rows keep tiles readable rather than slivers.
    const worst = Math.max(...tiles.map((tile) => Math.max(tile.w / tile.h, tile.h / tile.w)));
    expect(worst).toBeLessThan(4);
  });

  it("lays nothing out for an empty or zero-size box", () => {
    expect(squarify([], box)).toEqual([]);
    expect(squarify([{ key: "a", weight: 1 }], { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
    expect(squarify([{ key: "a", weight: 1 }], box)).toEqual([{ key: "a", ...box }]);
  });

  it("moves to the nearest tile in an arrow's direction", () => {
    const tiles = [
      { key: "a", x: 0, y: 0, w: 100, h: 100 },
      { key: "b", x: 100, y: 0, w: 100, h: 50 },
      { key: "c", x: 100, y: 50, w: 100, h: 50 },
      { key: "d", x: 0, y: 100, w: 200, h: 50 },
    ];
    expect(neighbour(tiles, "a", "right")).toBe("b");
    expect(neighbour(tiles, "b", "down")).toBe("c");
    expect(neighbour(tiles, "c", "left")).toBe("a");
    expect(neighbour(tiles, "a", "down")).toBe("d");
    expect(neighbour(tiles, "a", "left")).toBeNull();
    expect(neighbour(tiles, "missing", "up")).toBe("a");
  });
});

describe("market phase", () => {
  const hk = [
    { date: "2026-11-06", open: "2026-11-06T01:30:00Z", close: "2026-11-06T08:00:00Z", breakStart: "2026-11-06T04:00:00Z", breakEnd: "2026-11-06T05:00:00Z" },
    { date: "2026-11-09", open: "2026-11-09T01:30:00Z", close: "2026-11-09T08:00:00Z", breakStart: "2026-11-09T04:00:00Z", breakEnd: "2026-11-09T05:00:00Z" },
  ];
  const phase = (instant: string) => marketPhase(hk, "Asia/Hong_Kong", new Date(instant)).phase;

  it("reads open, lunch break, closed and pre-open in the exchange's day", () => {
    expect(phase("2026-11-09T02:00:00Z")).toBe("open");
    expect(phase("2026-11-09T04:30:00Z")).toBe("break");
    expect(phase("2026-11-09T08:00:00Z")).toBe("closed");
    // Saturday in Hong Kong: Friday's session was the last one.
    expect(phase("2026-11-07T03:00:00Z")).toBe("closed");
    // Monday 08:00 in Hong Kong, before the 09:30 open.
    expect(phase("2026-11-09T00:00:00Z")).toBe("pre-open");
    expect(marketPhase([], "Asia/Hong_Kong", new Date()).phase).toBe("unknown");
  });

  it("places bars along the trading day, skipping the lunch break", () => {
    const session = hk[1];
    expect(sessionPosition(session, "2026-11-09T01:30:00Z")).toBe(0);
    expect(sessionPosition(session, "2026-11-09T04:00:00Z")).toBeCloseTo(150 / 330, 6);
    expect(sessionPosition(session, "2026-11-09T04:30:00Z")).toBeCloseTo(150 / 330, 6);
    expect(sessionPosition(session, "2026-11-09T05:00:00Z")).toBeCloseTo(150 / 330, 6);
    expect(sessionPosition(session, "2026-11-09T08:00:00Z")).toBe(1);
    expect(sessionPosition(null, "2026-11-09T05:00:00Z")).toBeNull();
  });
});

describe("intraday line and colour", () => {
  it("keeps the previous close in view and breaks the line at gaps", () => {
    const line = sparkline([0.01, 0.02, null, 0.015], [0, 0.25, 0.5, 0.75], 200, 100, 0);
    expect(line.zero).toBe(100);
    expect(line.path).toBe("M0.0 50.0L50.0 0.0M150.0 25.0");
    expect(line.peak?.value).toBe(0.02);
    expect(line.last?.value).toBe(0.015);
  });

  it("saturates at the scale and stays neutral inside the unchanged band", () => {
    expect(heat(0.0004)).toBe(0);
    // 6.000 → 5.997 is −0.05% give or take floating-point error: still unchanged.
    expect(heat(5.997 / 6 - 1)).toBe(0);
    expect(heat(0.0006)).toBeGreaterThan(0);
    expect(heat(null)).toBe(0);
    expect(heat(0.05)).toBe(1);
    expect(heat(-0.05)).toBe(-1);
    expect(heat(0.015)).toBeGreaterThan(0.5);
    expect(heat(-0.015)).toBeLessThan(-0.5);
  });

  it("opens on the best-ranked group and validates markets", () => {
    const groups = [
      { key: "a", change: -0.01, ranks: [1, 2] },
      { key: "b", change: 0.02, ranks: [2, 1] },
      { key: "c", change: null, ranks: [3, null] },
      // One priced name: a big move, but too thin to rank.
      { key: "thin", change: 0.09, ranks: [null, null] },
    ] as SectorGroup[];
    expect(strongestGroup(groups)).toBe("b");
    expect([...groups].sort(byStanding).map((group) => group.key)).toEqual(["b", "a", "thin", "c"]);
    expect(strongestGroup([{ key: "c", change: null, ranks: [] }] as unknown as SectorGroup[])).toBe("c");
    expect(strongestGroup([])).toBeNull();
    expect(sectorMarket("hk")).toBe("hk");
    expect(sectorMarket("cn")).toBeNull();
  });

  it("reads exchange symbols and shouted issuer names plainly", () => {
    expect(displaySymbol("0700.HK")).toBe("0700");
    expect(displaySymbol("005930.KS")).toBe("005930");
    expect(displaySymbol("BT-A.L")).toBe("BT-A");
    expect(displaySymbol("BRK-B")).toBe("BRK-B");
    expect(issuerName("SAMSUNG ELECTRONICS LTD")).toBe("Samsung Electronics Ltd");
    expect(issuerName("AIA GROUP LTD")).toBe("AIA Group Ltd");
    expect(issuerName("NVIDIA Corporation")).toBe("NVIDIA Corporation");
  });
});
