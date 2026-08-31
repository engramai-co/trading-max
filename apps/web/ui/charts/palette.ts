"use client";

import { useComputedColorScheme } from "@mantine/core";

import { chartColours } from "@/ui/theme";

export { chartColours } from "@/ui/theme";

export type ChartColours = { [Key in keyof typeof chartColours]: string };

export const darkChartColours: ChartColours = {
  accent: "#f6ad55",
  axis: "#b8c5d6",
  border: "#46566d",
  brand: "#5b9dff",
  brandDark: "#86b6ff",
  canvas: "#ffffff",
  grid: "#3a485b",
  heatmapHigh: "#28543a",
  heatmapLow: "#633330",
  heatmapMid: "#2a384b",
  heatmapText: "#f3f7fb",
  negative: "#ff7b70",
  positive: "#62d384",
  secondary: "#69bfcd",
  text: "#f1f5f9",
  tooltip: "#111827",
  warning: "#f4c35f",
};

export function useChartColours(): ChartColours {
  const colourScheme = useComputedColorScheme("light");
  return colourScheme === "dark" ? darkChartColours : chartColours;
}

export const categoricalChartColours = [
  "#1768e5",
  "#347985",
  "#8a673c",
  "#7a6599",
  "#2f7a49",
  "#d97706",
  "#6b7280",
  "#b4473a",
] as const;
