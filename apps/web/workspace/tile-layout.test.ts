import { describe, expect, it } from "vitest";
import {
  estimateTextWidth,
  fitRoomySectorHeader,
  fitTileLabel,
  partitionNormalisedTreemap,
  scaledTileBudgets,
  scaleNormalisedTiles,
  TILE_TIERS,
} from "./tile-layout";

describe("unified heat-tile label fitting", () => {
  it("never inflates narrow or tiny tiles (8px overflow class) with non-zero padding", () => {
    const tinyBoxes: Array<[number, number]> = [
      [0, 0],
      [4, 40],
      [8, 60],
      [8, 8],
      [12, 12],
      [40, 12],
      [100, 14],
    ];
    for (const [width, height] of tinyBoxes) {
      const fit = fitTileLabel({
        names: { full: "Hong Kong", short: "HK", tiny: "HK" },
        change: "+0.88%",
        rounded: "+0.9%",
        width,
        height,
        measure: estimateTextWidth,
      });
      expect(fit.tier, `box ${width}x${height}`).toBe("none");
      expect(fit.showName).toBe(false);
      expect(fit.showChange).toBe(false);
      expect(fit.complete).toBe(false);
      expect(TILE_TIERS[fit.tier].padX).toBe(0);
      expect(TILE_TIERS[fit.tier].padY).toBe(0);
    }
  });

  it("enforces the padding <= box-size invariant across all widths, heights and long strings", () => {
    const samples = [
      { full: "Information Technology", short: "Tech", tiny: "Tech", change: "+12.34%", rounded: "+12.3%" },
      { full: "非日常生活消费品", short: "可选消费", tiny: "可选消费", change: "−1,234.56%", rounded: "−1,234.6%" },
      { full: "Communication Services", short: "Comms", tiny: "Comms", change: "+0.05%", rounded: "+0.1%" },
      { full: "NVDA", short: "NVDA", tiny: "NVDA", change: "+14.01%", rounded: "+14.0%" },
    ];
    for (const sample of samples) {
      for (const width of [1, 6, 8, 15, 24, 36, 48, 64, 96, 140, 220]) {
        for (const height of [1, 8, 16, 24, 32, 46, 64, 90]) {
          const fit = fitTileLabel({
            names: { full: sample.full, short: sample.short, tiny: sample.tiny },
            change: sample.change,
            rounded: sample.rounded,
            width,
            height,
            measure: estimateTextWidth,
            allowChangeOnly: true,
          });
          const spec = TILE_TIERS[fit.tier];
          if (fit.tier === "none") {
            expect(fit.showName).toBe(false);
            expect(fit.showChange).toBe(false);
            expect(spec.padX).toBe(0);
            expect(spec.padY).toBe(0);
          } else {
            expect(spec.padX * 2).toBeLessThan(width);
            expect(spec.padY * 2 + spec.line).toBeLessThanOrEqual(height);
            expect(spec.size).toBeGreaterThanOrEqual(12);
          }
        }
      }
    }
  });

  it("uses roomy stacked layout when generous, inline for wide short bars, and tight before dropping move", () => {
    const roomy = fitTileLabel({
      names: { full: "信息技术", short: "科技" },
      change: "+1.45%",
      rounded: "+1.5%",
      width: 160,
      height: 80,
      measure: estimateTextWidth,
    });
    expect(roomy).toMatchObject({ tier: "roomy", showName: true, showChange: true, inline: false, wrap: false, complete: true });

    const inline = fitTileLabel({
      names: { full: "科技", short: "科技" },
      change: "+1.45%",
      rounded: "+1.5%",
      width: 140,
      height: 30,
      measure: estimateTextWidth,
    });
    expect(inline).toMatchObject({ showName: true, showChange: true, inline: true, complete: true });

    const tight = fitTileLabel({
      names: { full: "Materials", short: "Materials", tiny: "Matl." },
      change: "−1.25%",
      rounded: "−1.3%",
      width: 44,
      height: 46,
      measure: estimateTextWidth,
    });
    expect(tight).toMatchObject({ tier: "tight", name: "Matl.", change: "−1.3%", showName: true, showChange: true, complete: false });
  });

  it("keeps change-only when requested for narrow non-roomy sector blocks", () => {
    const moveOnly = fitTileLabel({
      names: { full: "Communication Services" },
      change: "+0.43%",
      rounded: "+0.4%",
      width: 52,
      height: 30,
      measure: estimateTextWidth,
      allowChangeOnly: true,
    });
    expect(moveOnly.showName).toBe(false);
    expect(moveOnly.showChange).toBe(true);
    expect(moveOnly.complete).toBe(false);
  });

  it("accounts for gapY and guards non-positive or NaN boxes", () => {
    // compact padY=5 (10px), 2 lines of 16px = 32px; with gapY=2 needs 44px, so 43px cannot stack 2 rows.
    const snug = fitTileLabel({
      names: { full: "NVDA" },
      change: "+1.25%",
      rounded: "+1.3%",
      width: 56,
      height: 43,
      measure: estimateTextWidth,
      startTier: "compact",
      allowInline: false,
      gapY: 2,
    });
    expect(snug.showName).toBe(true);
    expect(snug.showChange).toBe(false);

    for (const [width, height] of [[-10, 40], [40, -1], [Number.NaN, 40]] as Array<[number, number]>) {
      const invalid = fitTileLabel({
        names: { full: "NVDA" },
        change: "+1.25%",
        width,
        height,
        measure: estimateTextWidth,
      });
      expect(invalid.tier).toBe("none");
      expect(invalid.showName).toBe(false);
      expect(invalid.showChange).toBe(false);
    }
  });

  it("preserves the normalised 100x100 constituent partition on landscape boxes and excludes sub-pixel tiles", () => {
    const basket = [
      { id: "SYN1", weight: 0.65 },
      { id: "SYN2", weight: 0.25 },
      { id: "SYN3", weight: 0.1 },
    ];
    const norm = partitionNormalisedTreemap(basket);
    expect(norm[0].rect).toEqual({ x: 0, y: 0, w: 100, h: 65 });

    // On a wide landscape panel (1000x300), the 65% constituent must remain a full-width top block.
    const landscape = scaleNormalisedTiles(basket, { w: 1000, h: 300 }, 2);
    expect(landscape).toHaveLength(3);
    expect(landscape[0]).toMatchObject({ x: 0, y: 0, w: 1000 });
    expect(landscape[0].h).toBeLessThan(300);
    expect(landscape[1].y).toBe(landscape[0].h + 2);
    expect(landscape[2].y).toBe(landscape[1].y);
    expect(landscape[2].x).toBe(landscape[1].x + landscape[1].w + 2);

    // Positive weight smaller than one rendered pixel is dropped from interactive heatmap tiles.
    const withSubpixel = scaleNormalisedTiles(
      [
        { id: "MAIN", weight: 0.999 },
        { id: "TINY", weight: 0.001 },
      ],
      { w: 400, h: 240 },
      2,
    );
    expect(withSubpixel.map((tile) => tile.item.id)).toEqual(["MAIN"]);
  });

  it("respects enlarged 20px root font scaling in tile fitting and roomy sector header completeness", () => {
    const budgets16 = scaledTileBudgets(16);
    const budgets20 = scaledTileBudgets(20);
    expect(budgets20.tiers.compact).toEqual({ padX: 7.5, padY: 5, size: 15, line: 20 });
    expect(budgets20.gapInline).toBe(7.5);
    expect(budgets20.gapStack).toBe(2.5);

    // A 44px-tall compact tile stacks 2 lines cleanly at 16px root (5+5+16+2+16=44),
    // but at 20px root (5+5+20+2.5+20=52.5) it must not claim a stacked complete fit.
    const fitAt16 = fitTileLabel({
      names: { full: "NVDA" },
      change: "+1.25%",
      rounded: "+1.3%",
      width: 68,
      height: 44,
      measure: estimateTextWidth,
      tiers: budgets16.tiers,
      startTier: "compact",
      allowInline: false,
      gapX: budgets16.gapInline,
      gapY: budgets16.gapStack,
    });
    expect(fitAt16).toMatchObject({ showName: true, showChange: true, complete: true });

    const fitAt20 = fitTileLabel({
      names: { full: "NVDA" },
      change: "+1.25%",
      rounded: "+1.3%",
      width: 68,
      height: 44,
      measure: estimateTextWidth,
      tiers: budgets20.tiers,
      startTier: "compact",
      allowInline: false,
      gapX: budgets20.gapInline,
      gapY: budgets20.gapStack,
    });
    expect(fitAt20.showChange).toBe(false);
    expect(fitAt20.complete).toBe(false);

    // Roomy sector header: name alone fits 180-20=160px, yet sharing the row with move+gap clips it.
    const header = fitRoomySectorHeader({
      name: "Consumer Discretionary",
      change: "+1.45%",
      chip: "",
      width: 185,
      narrow: false,
      measure: estimateTextWidth,
      budgets: budgets16,
    });
    expect(header.nameFits).toBe(false);

    // With a streak chip at 20px root, chip padding/text scaling also shrinks available width for name.
    const chipHeader20 = fitRoomySectorHeader({
      name: "Information Technology",
      change: "+1.45%",
      chip: "Top 3 · 2d",
      width: 310,
      narrow: false,
      measure: estimateTextWidth,
      budgets: budgets20,
    });
    expect(chipHeader20.showChip).toBe(false);
    expect(chipHeader20.nameFits).toBe(true);
  });
});
