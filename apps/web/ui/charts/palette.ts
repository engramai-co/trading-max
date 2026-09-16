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
  negative: "#ff958a",
  positive: "#78cf91",
  secondary: "#69bfcd",
  text: "#f1f5f9",
  tooltip: "#202124",
  tooltipBorder: "#414246",
  tooltipMuted: "#bfc0c4",
  tooltipShadow: "rgba(0,0,0,.16)",
  tooltipText: "#f4f4f5",
  warning: "#f4c35f",
};
export function useChartColours(): ChartColours {
  return useComputedColorScheme("light") === "dark"
    ? darkChartColours
    : chartColours;
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
