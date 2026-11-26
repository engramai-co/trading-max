"use client";

import { useSyncExternalStore } from "react";
import { COLOR_SCHEME_ATTRIBUTE, type ResolvedColorScheme } from "@/lib/color-scheme";
import { toCanvasColour } from "@/ui/charts/canvas-colour";

type ReadCssToken = (name: string) => string;

const chartColourTokens = {
  accent: "--chart-3",
  allocationRest: "--allocation-rest",
  axis: "--muted-foreground",
  border: "--border-strong",
  brand: "--chart-1",
  canvas: "--card",
  comparison: "--chart-2",
  grid: "--border",
  keyMomentBg: "--key-moment-bg",
  keyMomentInk: "--key-moment-ink",
  muted: "--muted",
  negative: "--loss",
  positive: "--gain",
  secondary: "--chart-4",
  selection: "--selection",
  series5: "--chart-5",
  text: "--foreground",
  tooltip: "--popover",
  tooltipBorder: "--panel-edge",
  tooltipText: "--popover-foreground",
  warning: "--warning",
} as const;

export type ChartColours = {
  [Key in keyof typeof chartColourTokens]: string;
} & {
  shadowPopover: string;
  tooltipRadius: string;
};

function readChartStyle(read: ReadCssToken, readColour: ReadCssToken): ChartColours {
  const colours = Object.fromEntries(
    Object.entries(chartColourTokens).map(([key, token]) => [key, readColour(token)]),
  ) as { [Key in keyof typeof chartColourTokens]: string };
  return {
    ...colours,
    shadowPopover: read("--shadow-popover"),
    tooltipRadius: read("--radius-tooltip"),
  };
}

export function readChartColours(read: ReadCssToken): ChartColours {
  return readChartStyle(read, (token) => toCanvasColour(read(token)));
}

function allocationColours(read: ReadCssToken): readonly string[] {
  return [
    ...Array.from({ length: 12 }, (_, index) => read(`--allocation-${index + 1}`)),
    read("--allocation-rest"),
  ];
}

export function readAllocationChartColours(read: ReadCssToken): readonly string[] {
  return allocationColours((token) => toCanvasColour(read(token)));
}

type Palette = {
  scheme: ResolvedColorScheme;
  chart: ChartColours;
  allocation: readonly string[];
  ready: boolean;
};

// HTML and SVG can use CSS variables during SSR. The canvas waits for resolved
// RGB colours so ECharts never receives var() or oklch() strings or a palette for another scheme.
const cssReference = (name: string) => `var(${name})`;
const serverPalette: Palette = {
  scheme: "dark",
  chart: readChartStyle(cssReference, cssReference),
  allocation: allocationColours(cssReference),
  ready: false,
};

let cachedPalette: Palette | undefined;
let stale = true;
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
function samePalette(a: Palette, b: Palette): boolean {
  return a.scheme === b.scheme
    && a.allocation.every((colour, index) => b.allocation[index] === colour)
    && (Object.keys(a.chart) as Array<keyof ChartColours>).every((key) => a.chart[key] === b.chart[key]);
}

function readPalette(): Palette {
  const root = document.documentElement;
  const scheme = root.getAttribute(COLOR_SCHEME_ATTRIBUTE) === "light" ? "light" : "dark";
  if (!stale && cachedPalette && cachedPalette.scheme === scheme) return cachedPalette;
  const styles = getComputedStyle(root);
  const read: ReadCssToken = (name) => styles.getPropertyValue(name).trim();
  const chart = readChartColours(read);
  const allocation = readAllocationChartColours(read);
  if (Object.values(chart).some((token) => !token) || allocation.some((colour) => !colour)) return serverPalette;
  const next: Palette = { scheme, chart, allocation, ready: true };
  stale = false;
  if (cachedPalette && samePalette(cachedPalette, next)) return cachedPalette;
  cachedPalette = next;
  return next;
}

function notify() {
  stale = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [COLOR_SCHEME_ATTRIBUTE, "class", "style"],
    });
    window.addEventListener("load", notify);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
      window.removeEventListener("load", notify);
      stale = true;
    }
  };
}

export function useChartPalette() {
  return useSyncExternalStore(subscribe, readPalette, () => serverPalette);
}

export function useChartColours(): ChartColours {
  return useChartPalette().chart;
}

export function useAllocationChartColours() {
  return useChartPalette().allocation;
}
