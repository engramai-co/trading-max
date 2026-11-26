"use client";

import { useSyncExternalStore } from "react";
import { COLOR_SCHEME_ATTRIBUTE, type ResolvedColorScheme } from "@/lib/color-scheme";

const chartTokens = {
  accent: "--chart-3",
  axis: "--muted-foreground",
  border: "--border-strong",
  brand: "--chart-1",
  canvas: "--card",
  comparison: "--chart-2",
  grid: "--border",
  keyMomentBg: "--key-moment-bg",
  keyMomentInk: "--key-moment-ink",
  negative: "--loss",
  positive: "--gain",
  secondary: "--chart-4",
  series5: "--chart-5",
  text: "--foreground",
  tooltip: "--popover",
  tooltipBorder: "--panel-edge",
  tooltipMuted: "--muted-foreground",
  tooltipShadow: "--chart-tooltip-shadow",
  tooltipText: "--popover-foreground",
  warning: "--warning",
} as const;

export type ChartColours = { [Key in keyof typeof chartTokens]: string };
type ReadCssToken = (name: string) => string;

export function readChartColours(read: ReadCssToken): ChartColours {
  return Object.fromEntries(
    Object.entries(chartTokens).map(([key, token]) => [key, read(token)]),
  ) as ChartColours;
}

export function readAllocationChartColours(read: ReadCssToken): readonly string[] {
  return [
    ...Array.from({ length: 12 }, (_, index) => read(`--allocation-${index + 1}`)),
    read("--allocation-rest"),
  ];
}

type Palette = {
  scheme: ResolvedColorScheme;
  chart: ChartColours;
  allocation: readonly string[];
  ready: boolean;
};

// HTML and SVG can use CSS variables during SSR. The canvas waits for resolved
// colours so ECharts never receives var() strings or a palette for another scheme.
const cssReference = (name: string) => `var(${name})`;
const serverPalette: Palette = {
  scheme: "dark",
  chart: readChartColours(cssReference),
  allocation: readAllocationChartColours(cssReference),
  ready: false,
};

const palettes: Partial<Record<ResolvedColorScheme, Palette>> = {};
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function readPalette(): Palette {
  const root = document.documentElement;
  const scheme = root.getAttribute(COLOR_SCHEME_ATTRIBUTE) === "light" ? "light" : "dark";
  const cached = palettes[scheme];
  if (cached) return cached;
  const styles = getComputedStyle(root);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  if (!read("--chart-1")) return serverPalette;
  return palettes[scheme] = {
    scheme,
    chart: readChartColours(read),
    allocation: readAllocationChartColours(read),
    ready: true,
  };
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [COLOR_SCHEME_ATTRIBUTE] });
    window.addEventListener("load", notify);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
      window.removeEventListener("load", notify);
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
