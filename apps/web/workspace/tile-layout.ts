"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Shared heat-tile label sizing rules for every treemap (Overview sectors/world, Markets sector map
 * & constituent tiles, Research index constituent heatmap).
 *
 * Invariant: any tier other than `"none"` is chosen ONLY when `width >= padX * 2` and
 * `height >= padY * 2` and every visible line fits inside the inner box. When nothing fits at the
 * 12px typography floor, `"none"` is returned with zero padding so narrow tiles (e.g. 8px wide)
 * can never be inflated past their laid-out box by padding.
 */
export type TileTier = "roomy" | "compact" | "tight" | "none";

export type TileTierSpec = {
  padX: number;
  padY: number;
  size: number;
  line: number;
};

export type TileTierSpecs = Record<TileTier, TileTierSpec>;

export type TileLayoutBudgets = {
  tiers: TileTierSpecs;
  gapInline: number;
  gapStack: number;
};

export const TILE_TIERS: TileTierSpecs = {
  roomy: { padX: 10, padY: 8, size: 13, line: 18 },
  compact: { padX: 6, padY: 5, size: 12, line: 16 },
  /** Narrowest horizontal padding before a block drops its move, keeping the 12px type floor. */
  tight: { padX: 3, padY: 5, size: 12, line: 16 },
  /** Unlabelled tile: zero padding so CSS box-sizing cannot widen the tile past its layout rect. */
  none: { padX: 0, padY: 0, size: 12, line: 16 },
};

export type TileMeasure = (text: string, size: number) => number;
export type TileRect = { x: number; y: number; w: number; h: number };

export const DEFAULT_TILE_BUDGETS: TileLayoutBudgets = {
  tiers: TILE_TIERS,
  gapInline: 6,
  gapStack: 2,
};

/**
 * Partition items inside a normalised 100×100 square (matching the historical percentage treemap)
 * so landscape containers preserve the exact split order, then convert the rectangles to whole
 * pixel coordinates with `gap` seams whose outer edges align with `size`.
 */
export function partitionNormalisedTreemap<T extends { weight: number }>(
  items: ReadonlyArray<T>,
  rect: TileRect = { x: 0, y: 0, w: 100, h: 100 },
): Array<{ item: T; rect: TileRect }> {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ item: items[0], rect }];
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0)) return [];
  let cursor = 1;
  let first = items[0].weight;
  while (cursor < items.length - 1 && first + items[cursor].weight < total / 2) {
    first += items[cursor++].weight;
  }
  const split = first / total;
  const { x, y, w, h } = rect;
  const horizontal = w > h;
  return [
    ...partitionNormalisedTreemap(items.slice(0, cursor), {
      x,
      y,
      w: horizontal ? w * split : w,
      h: horizontal ? h : h * split,
    }),
    ...partitionNormalisedTreemap(items.slice(cursor), {
      x: horizontal ? x + w * split : x,
      y: horizontal ? y : y + h * split,
      w: horizontal ? w * (1 - split) : w,
      h: horizontal ? h : h * (1 - split),
    }),
  ];
}

export function scaleNormalisedTiles<T extends { weight: number }>(
  items: ReadonlyArray<T>,
  size: { w: number; h: number } | null,
  gap: number,
): Array<{ item: T; x: number; y: number; w: number; h: number }> {
  if (!size || !(size.w > 0 && size.h > 0)) return [];
  const positive = items.filter((item) => item.weight > 0);
  if (!positive.length) return [];
  const scaleX = (size.w + gap) / 100;
  const scaleY = (size.h + gap) / 100;
  return partitionNormalisedTreemap(positive)
    .map(({ item, rect }) => {
      const x = Math.round(rect.x * scaleX);
      const y = Math.round(rect.y * scaleY);
      const w = Math.max(0, Math.round((rect.x + rect.w) * scaleX) - x - gap);
      const h = Math.max(0, Math.round((rect.y + rect.h) * scaleY) - y - gap);
      return { item, x, y, w, h };
    })
    .filter((tile) => tile.w > 0 && tile.h > 0);
}

export type TileNames = {
  full: string;
  short?: string;
  tiny?: string;
};

export type TileLabelFit = {
  name: string;
  change: string;
  showName: boolean;
  showChange: boolean;
  wrap: boolean;
  inline: boolean;
  tier: TileTier;
  /** True only when the full name and full change are both rendered verbatim on the tile. */
  complete: boolean;
};

/** Padding + typography Tailwind classes for each tier. `none` guarantees zero padding. */
export const TILE_TIER_PADDING: Record<TileTier, string> = {
  roomy: "px-2.5 py-2",
  compact: "px-1.5 py-[5px]",
  tight: "px-[3px] py-[5px]",
  none: "p-0",
};

export const TILE_TIER_TEXT: Record<TileTier, string> = {
  roomy: "text-[13px] leading-[18px]",
  compact: "text-xs leading-4",
  tight: "text-xs leading-4",
  none: "text-xs leading-4",
};

/** Rough rendered width fallback when no 2D canvas is available (SSR / JSDOM). */
export function estimateTextWidth(text: string, size: number) {
  return [...text].reduce((width, glyph) => width + (/[\u2e80-\u9fff\uff00-\uffef]/.test(glyph) ? size : size * 0.58), 0);
}

let canvas: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Rendered width of a semibold label in the page's own font; falls back to estimate without canvas. */
export function measureTileText(text: string, size: number, family: string) {
  if (canvas === undefined) {
    canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!canvas || !family) return estimateTextWidth(text, size);
  const key = family + "|" + size + "|" + text;
  let width = widths.get(key);
  if (width == null) {
    canvas.font = "600 " + size + "px " + family;
    width = canvas.measureText(text).width;
    widths.set(key, width);
  }
  return width;
}

/** Lines a name needs at a width: Latin names break between words; single tokens / CJK stay on one line. */
function lineCount(name: string, room: number, size: number, measure: TileMeasure) {
  if (room <= 0) return Infinity;
  if (measure(name, size) <= room) return 1;
  const words = name.split(" ");
  if (words.length < 2) return Infinity;
  const space = measure(" ", size);
  let lines = 1;
  let line = 0;
  for (const word of words) {
    const width = measure(word, size);
    if (width > room) return Infinity;
    if (line === 0) line = width;
    else if (line + space + width <= room) line += space + width;
    else {
      lines += 1;
      line = width;
    }
  }
  return lines;
}

/**
 * Decide which labels and padding tier fit inside a `(width, height)` heat tile.
 *
 * Order of preference:
 * 1. Stacked (name over move) trying roomy -> compact, full -> short -> tiny name, full -> rounded move.
 * 2. Inline (name beside move) for wide, short tiles.
 * 3. Wrapped (two-line name over move) for tall, narrow Latin tiles.
 * 4. Tight horizontal padding (3px at 12px floor) for both name and move.
 * 5. Name alone (the wash already communicates direction), or change alone when `allowChangeOnly`.
 * 6. `"none"` with zero padding: tooltip and accessible name carry the full reading.
 */
export function fitTileLabel({
  names,
  change,
  rounded = change,
  width,
  height,
  measure,
  tiers = TILE_TIERS,
  startTier = "roomy",
  allowWrap = true,
  allowInline = true,
  allowTight = true,
  allowChangeOnly = false,
  gapX = 6,
  gapY = 1,
}: {
  names: TileNames;
  change: string;
  rounded?: string;
  width: number;
  height: number;
  measure: TileMeasure;
  tiers?: TileTierSpecs;
  startTier?: "roomy" | "compact";
  allowWrap?: boolean;
  allowInline?: boolean;
  allowTight?: boolean;
  allowChangeOnly?: boolean;
  gapX?: number;
  gapY?: number;
}): TileLabelFit {
  const full = names.full;
  const short = names.short ?? full;
  const tiny = names.tiny ?? short;
  const hasChange = change !== "";
  if (!(width > 0 && height > 0)) {
    return {
      name: full,
      change,
      showName: false,
      showChange: false,
      wrap: false,
      inline: false,
      tier: "none",
      complete: false,
    };
  }

  const evaluate = (name: string, move: string, tier: Exclude<TileTier, "none">) => {
    const spec = tiers[tier];
    const room = width - spec.padX * 2;
    const innerH = height - spec.padY * 2;
    if (room <= 0 || innerH < spec.line) {
      return {
        name,
        move,
        tier,
        rows: 0,
        oneLine: false,
        twoLines: false,
        fits: false,
        inline: false,
        changeFits: false,
      };
    }
    // Account for the inter-line gap between rows so stacked lines never clip vertically.
    const rows = Math.floor((innerH + gapY + 1e-9) / (spec.line + gapY));
    const lines = name ? lineCount(name, room, spec.size, measure) : Infinity;
    const moveWidth = move ? measure(move, spec.size) : 0;
    const fits = !move || moveWidth <= room;
    return {
      name,
      move,
      tier,
      rows,
      oneLine: lines === 1,
      twoLines: lines <= 2,
      fits,
      changeFits: Boolean(move) && moveWidth <= room && rows >= 1,
      inline: Boolean(move) && lines === 1 && measure(name, spec.size) + gapX + moveWidth <= room,
    };
  };

  const candidates: Array<{ name: string; move: string; tier: Exclude<TileTier, "none"> }> =
    startTier === "roomy"
      ? [
          { name: full, move: change, tier: "roomy" },
          { name: full, move: change, tier: "compact" },
          { name: short, move: change, tier: "roomy" },
          { name: short, move: change, tier: "compact" },
          { name: short, move: rounded, tier: "compact" },
          { name: tiny, move: rounded, tier: "compact" },
        ]
      : [
          { name: full, move: change, tier: "compact" },
          { name: short, move: change, tier: "compact" },
          { name: short, move: rounded, tier: "compact" },
          { name: tiny, move: rounded, tier: "compact" },
        ];

  const attempts = candidates.map((item) => evaluate(item.name, item.move, item.tier));
  const pick = (chosen: ReturnType<typeof evaluate>, shown: Partial<TileLabelFit>): TileLabelFit => {
    const result = {
      name: chosen.name,
      change: chosen.move,
      tier: chosen.tier,
      showName: true,
      showChange: hasChange,
      wrap: false,
      inline: false,
      ...shown,
    };
    const complete =
      result.showName &&
      (!hasChange || result.showChange) &&
      result.name === full &&
      (!hasChange || result.change === change);
    return { ...result, complete };
  };

  if (hasChange) {
    const stacked = attempts.find((a) => a.oneLine && a.fits && a.rows >= 2);
    if (stacked) return pick(stacked, {});
    if (allowInline) {
      const inline = attempts.find((a) => a.inline && a.rows >= 1);
      if (inline) return pick(inline, { inline: true });
    }
    if (allowWrap) {
      const wrapped = attempts.find((a) => a.twoLines && a.fits && a.rows >= 3);
      if (wrapped) return pick(wrapped, { wrap: true });
    }
    if (allowTight) {
      const tight = evaluate(tiny, rounded, "tight");
      if (tight.oneLine && tight.fits && tight.rows >= 2) return pick(tight, {});
      if (allowInline && tight.inline && tight.rows >= 1) return pick(tight, { inline: true });
    }
  }

  const named =
    attempts.find((a) => a.oneLine && a.rows >= 1) ??
    (allowWrap ? attempts.find((a) => a.twoLines && a.rows >= 2) : undefined) ??
    (allowTight
      ? (() => {
          const t = evaluate(tiny, rounded, "tight");
          return t.oneLine && t.rows >= 1 ? t : undefined;
        })()
      : undefined);
  if (named) return pick(named, { showChange: false, wrap: !named.oneLine });

  if (allowChangeOnly && hasChange) {
    const moveOnly =
      attempts.find((a) => a.changeFits) ??
      (allowTight
        ? (() => {
            const t = evaluate(tiny, rounded, "tight");
            return t.changeFits ? t : undefined;
          })()
        : undefined);
    if (moveOnly) return pick(moveOnly, { showName: false, showChange: true });
  }

  return {
    name: full,
    change,
    showName: false,
    showChange: false,
    wrap: false,
    inline: false,
    tier: "none",
    complete: false,
  };
}

/** Derive rem-aware tile budgets from the root font size when live CSS utilities aren't mounted (SSR / Node tests). */
export function scaledTileBudgets(rootFontSize: number): TileLayoutBudgets {
  const scale = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize / 16 : 1;
  return {
    tiers: {
      roomy: { padX: 10 * scale, padY: 8 * scale, size: 13, line: 18 },
      compact: { padX: 6 * scale, padY: 5, size: 12 * scale, line: 16 * scale },
      tight: { padX: 3, padY: 5, size: 12 * scale, line: 16 * scale },
      none: { padX: 0, padY: 0, size: 12 * scale, line: 16 * scale },
    },
    gapInline: 6 * scale,
    gapStack: 2 * scale,
  };
}

function budgetsEqual(a: TileLayoutBudgets, b: TileLayoutBudgets) {
  if (a.gapInline !== b.gapInline || a.gapStack !== b.gapStack) return false;
  for (const tier of ["roomy", "compact", "tight", "none"] as const) {
    const x = a.tiers[tier];
    const y = b.tiers[tier];
    if (x.padX !== y.padX || x.padY !== y.padY || x.size !== y.size || x.line !== y.line) return false;
  }
  return true;
}

/** Measure rendered tier paddings, font sizes, line heights and flex gaps from computed styles on `host`. */
export function measureTileBudgets(host: HTMLElement): TileLayoutBudgets {
  const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const fallback = scaledTileBudgets(rootFont);
  const probeRoot = document.createElement("div");
  probeRoot.setAttribute("aria-hidden", "true");
  probeRoot.style.cssText =
    "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:layout style";
  const tierProbes = {} as Record<TileTier, HTMLSpanElement>;
  for (const tier of ["roomy", "compact", "tight", "none"] as const) {
    const node = document.createElement("span");
    node.className = `${TILE_TIER_PADDING[tier]} ${TILE_TIER_TEXT[tier]}`;
    probeRoot.appendChild(node);
    tierProbes[tier] = node;
  }
  const inlineGapProbe = document.createElement("span");
  inlineGapProbe.className = "flex flex-row gap-1.5";
  const stackGapProbe = document.createElement("span");
  stackGapProbe.className = "flex flex-col gap-0.5";
  probeRoot.appendChild(inlineGapProbe);
  probeRoot.appendChild(stackGapProbe);
  host.appendChild(probeRoot);
  try {
    const roomyStyle = getComputedStyle(tierProbes.roomy);
    const hasCss =
      (parseFloat(roomyStyle.paddingLeft) || 0) > 0 &&
      (parseFloat(roomyStyle.fontSize) || 0) > 0;
    if (!hasCss) return fallback;

    const readTier = (tier: TileTier): TileTierSpec => {
      const cs = getComputedStyle(tierProbes[tier]);
      const base = fallback.tiers[tier];
      const padLeft = parseFloat(cs.paddingLeft);
      const padRight = parseFloat(cs.paddingRight);
      const padTop = parseFloat(cs.paddingTop);
      const padBottom = parseFloat(cs.paddingBottom);
      const fontSize = parseFloat(cs.fontSize);
      const lineHeight = parseFloat(cs.lineHeight);
      const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : base.size;
      const line =
        Number.isFinite(lineHeight) && lineHeight > 0
          ? lineHeight
          : Math.ceil(size * (base.line / base.size));
      return {
        padX: Number.isFinite(padLeft) && Number.isFinite(padRight) ? (padLeft + padRight) / 2 : base.padX,
        padY: Number.isFinite(padTop) && Number.isFinite(padBottom) ? (padTop + padBottom) / 2 : base.padY,
        size,
        line,
      };
    };

    const gapInline = parseFloat(getComputedStyle(inlineGapProbe).columnGap);
    const gapStack = parseFloat(getComputedStyle(stackGapProbe).rowGap);
    return {
      tiers: {
        roomy: readTier("roomy"),
        compact: readTier("compact"),
        tight: readTier("tight"),
        none: readTier("none"),
      },
      gapInline: Number.isFinite(gapInline) && gapInline >= 0 ? gapInline : fallback.gapInline,
      gapStack: Number.isFinite(gapStack) && gapStack >= 0 ? gapStack : fallback.gapStack,
    };
  } finally {
    probeRoot.remove();
  }
}

/** Evaluate whether a roomy sector header's name, move and optional streak chip fit without clipping. */
export function fitRoomySectorHeader({
  name,
  change,
  chip,
  width,
  narrow,
  measure,
  budgets = DEFAULT_TILE_BUDGETS,
}: {
  name: string;
  change: string;
  chip: string;
  width: number;
  narrow: boolean;
  measure: TileMeasure;
  budgets?: TileLayoutBudgets;
}): { showChip: boolean; nameFits: boolean } {
  const roomyPad = budgets.tiers.roomy.padX * 2;
  const roomySize = budgets.tiers.roomy.size;
  const headGap = budgets.gapInline;
  const nameWidth = measure(name, roomySize);
  const changeWidth = measure(change, roomySize);
  const chipWidth = chip ? measure(chip, budgets.tiers.compact.size) + budgets.tiers.compact.padX * 2 : 0;
  const chipWithGap = chip ? headGap + chipWidth : 0;
  const showChip =
    chip !== "" &&
    (narrow
      ? roomyPad + changeWidth + chipWithGap <= width
      : roomyPad + nameWidth + headGap + changeWidth + chipWithGap <= width);
  const nameFits = narrow
    ? nameWidth <= width - roomyPad && changeWidth <= width - roomyPad
    : nameWidth + headGap + changeWidth + (showChip ? chipWithGap : 0) <= width - roomyPad;
  return { showChip, nameFits };
}

/** Measure a graphic container's live pixel box, computed font family and rendered tile budgets. */
export function useMeasuredBox(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [family, setFamily] = useState("");
  const [budgets, setBudgets] = useState<TileLayoutBudgets>(DEFAULT_TILE_BUDGETS);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let lastKey = "";
    const syncStyles = () => {
      const nextFamily = getComputedStyle(element).fontFamily;
      const rootSize = getComputedStyle(document.documentElement).fontSize;
      const styleKey = `${nextFamily}|${rootSize}`;
      if (styleKey === lastKey) return;
      lastKey = styleKey;
      setFamily(nextFamily);
      const nextBudgets = measureTileBudgets(element);
      setBudgets((current) => (budgetsEqual(current, nextBudgets) ? current : nextBudgets));
    };
    const update = () => {
      syncStyles();
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current && Math.abs(current.w - width) < 1 && Math.abs(current.h - height) < 1 ? current : { w: width, h: height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const rootObserver = new MutationObserver(syncStyles);
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      observer.disconnect();
      rootObserver.disconnect();
    };
  }, [ref]);
  const measure = useCallback<TileMeasure>((text, px) => measureTileText(text, px, family), [family]);
  return { size, family, measure, budgets };
}
