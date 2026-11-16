import type { TooltipComponentOption } from "echarts";
import { FONT_STACK } from "@/ui/theme";

/**
 * A native ECharts tooltip that shows a reading card. readingHtml draws the card with its own
 * overlay shell (18-overlay.css), so ECharts' box is transparent and adds no second border or shadow.
 * Use it only for item-triggered charts that keep a native tooltip; axis charts read through a readout.
 */
export const READING_TOOLTIP = {
  renderMode: "html",
  className: "mx-reading-tooltip",
  enterable: false,
  confine: true,
  transitionDuration: 0,
  padding: 0,
  borderWidth: 0,
  backgroundColor: "transparent",
  extraCssText: [
    "box-shadow:none",
    "border-radius:var(--mx-overlay-radius)",
    "z-index:var(--mx-overlay-z-tip)",
    "font-family:" + FONT_STACK,
    "",
  ].join(";"),
} satisfies TooltipComponentOption;

