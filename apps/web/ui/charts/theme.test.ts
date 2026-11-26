import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canvasShadow, toCanvasColour, withCanvasAlpha } from "@/ui/charts/canvas-colour";
import {
  applyLumaChartTheme,
  buildLumaTooltip,
  lumaSeriesPalette,
  mergeLiveZoom,
} from "@/ui/charts/theme";
import { FONT_STACK } from "@/ui/theme";
import { chartColours, darkChartColours } from "@/tests/fixtures/theme-colours";

describe("toCanvasColour", () => {
  it("converts hex, rgb and oklch to canvas-safe rgb and rgba", () => {
    expect(toCanvasColour("#2563eb")).toBe("rgb(37, 99, 235)");
    expect(toCanvasColour("#fff")).toBe("rgb(255, 255, 255)");
    expect(toCanvasColour("#09090b80")).toBe("rgba(9, 9, 11, 0.502)");
    expect(toCanvasColour("rgb(9 9 11 / 0.12)")).toBe("rgba(9, 9, 11, 0.12)");
    expect(toCanvasColour("rgb(9 9 11 / 50%)")).toBe("rgba(9, 9, 11, 0.5)");
    expect(toCanvasColour("rgba(0, 0, 0, 0.45)")).toBe("rgba(0, 0, 0, 0.45)");
    expect(toCanvasColour("oklch(1 0 0)")).toBe("rgb(255, 255, 255)");
    expect(toCanvasColour("oklch(0 0 0)")).toBe("rgb(0, 0, 0)");
    expect(toCanvasColour("oklch(62.3% 0.214 259.815)")).toBe("rgb(43, 127, 255)");
    expect(toCanvasColour("oklch(62.3% 0.214 259.815 / 0.4)")).toBe("rgba(43, 127, 255, 0.4)");
    expect(toCanvasColour("transparent")).toBe("transparent");
  });

  it("rejects unresolved aliases and invalid colours", () => {
    expect(toCanvasColour("var(--unresolved)")).toBe("");
    expect(toCanvasColour("oklch(0.62 invalid 120)")).toBe("");
  });

  it("multiplies alpha via withCanvasAlpha", () => {
    expect(withCanvasAlpha("rgb(37, 99, 235)", 0.13)).toBe("rgba(37, 99, 235, 0.13)");
    expect(withCanvasAlpha("rgba(37, 99, 235, 0.5)", 0.5)).toBe("rgba(37, 99, 235, 0.25)");
  });
});

describe("canvasShadow", () => {
  it("extracts offsets, blur and canvas-safe rgba colour from dark and light popover shadows", () => {
    expect(canvasShadow(darkChartColours.shadowPopover)).toEqual({
      shadowOffsetX: 0,
      shadowOffsetY: 16,
      shadowBlur: 40,
      shadowColor: "rgba(0, 0, 0, 0.45)",
    });
    expect(canvasShadow(chartColours.shadowPopover)).toEqual({
      shadowOffsetX: 0,
      shadowOffsetY: 8,
      shadowBlur: 24,
      shadowColor: "rgba(9, 9, 11, 0.12)",
    });
  });
});

describe("applyLumaChartTheme", () => {
  it("applies Luma palette, typography, 12px muted axes without ticks, hairline horizontal gridlines, 2px lines, 6px symbols, candlestick colours, and richText tooltip", () => {
    const themed = applyLumaChartTheme(
      {
        xAxis: { type: "category", data: ["A", "B"], axisLabel: { fontSize: 10 } },
        yAxis: { type: "value", name: "USD", nameTextStyle: { fontSize: 11 } },
        tooltip: { trigger: "item", renderMode: "html" },
        dataZoom: [{ type: "slider" }, { type: "inside" }],
        series: [
          { type: "line", data: [1, 2], markLine: { data: [{ yAxis: 1.5 }] } },
          { type: "candlestick", data: [[1, 2, 0.5, 2.5]] },
        ],
      },
      darkChartColours,
      "dark",
      false,
    );

    expect(themed.backgroundColor).toBe("transparent");
    expect(themed.darkMode).toBe(true);
    expect(themed.color).toEqual(lumaSeriesPalette(darkChartColours));
    expect(themed.textStyle).toMatchObject({ color: darkChartColours.text, fontSize: 12, fontFamily: FONT_STACK });

    const xAxis = themed.xAxis as Record<string, unknown>;
    expect(xAxis.axisLabel).toMatchObject({ color: darkChartColours.axis, fontSize: 12, fontFamily: FONT_STACK });
    expect(xAxis.axisTick).toMatchObject({ show: false });
    expect(xAxis.splitLine).toEqual({ show: false });

    const yAxis = themed.yAxis as Record<string, unknown>;
    expect(yAxis.nameTextStyle).toMatchObject({ color: darkChartColours.axis, fontSize: 12, fontFamily: FONT_STACK });
    expect(yAxis.axisTick).toMatchObject({ show: false });
    expect(yAxis.splitLine).toMatchObject({ lineStyle: { color: darkChartColours.grid, type: "solid", width: 1 } });

    const series = themed.series as Array<Record<string, unknown>>;
    expect(series[0]).toMatchObject({
      symbolSize: 6,
      lineStyle: { width: 2 },
      markLine: { lineStyle: { color: darkChartColours.axis, type: [3, 3], width: 1 } },
    });
    expect(series[1]).toMatchObject({
      itemStyle: {
        color: darkChartColours.positive,
        color0: darkChartColours.negative,
        borderColor: darkChartColours.positive,
        borderColor0: darkChartColours.negative,
      },
    });

    const zoom = themed.dataZoom as Array<Record<string, unknown>>;
    expect(zoom[0]).toMatchObject({
      backgroundColor: darkChartColours.muted,
      borderColor: darkChartColours.grid,
      handleStyle: { color: darkChartColours.canvas, borderColor: darkChartColours.border },
      moveHandleStyle: { color: darkChartColours.border },
    });

    const tooltip = themed.tooltip as Record<string, unknown>;
    expect(tooltip).toMatchObject({
      renderMode: "richText",
      backgroundColor: darkChartColours.tooltip,
      borderColor: darkChartColours.tooltipBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: [8, 12],
      textStyle: { color: darkChartColours.tooltipText, fontSize: 12, fontFamily: FONT_STACK },
    });
    expect(buildLumaTooltip(chartColours)).toMatchObject({
      renderMode: "richText",
      backgroundColor: chartColours.tooltip,
      borderColor: chartColours.tooltipBorder,
      borderRadius: 12,
    });
  });

  it("removes vertical gridlines and respects reduced motion", () => {
    const themed = applyLumaChartTheme(
      {
        xAxis: { type: "value", splitLine: { show: true } },
        yAxis: { type: "category", data: ["One"], splitLine: { show: false } },
        tooltip: { show: false },
      },
      chartColours,
      "light",
      true,
    );
    expect(themed.animation).toBe(false);
    expect(themed.darkMode).toBe(false);
    expect((themed.xAxis as Record<string, unknown>).splitLine).toEqual({ show: false });
    expect((themed.yAxis as Record<string, unknown>).splitLine).toMatchObject({ show: false });
    expect(themed.tooltip).toEqual({ show: false, renderMode: "richText" });
  });
});

describe("mergeLiveZoom", () => {
  it("preserves live percentage bounds and clears stale value bounds across scheme switches", () => {
    const merged = mergeLiveZoom(
      [
        { type: "inside", startValue: "2024-01-01", endValue: "2024-12-31" },
        { type: "slider", start: 0, end: 100 },
      ],
      [
        { start: 25, end: 75 },
        { start: 25, end: 75 },
      ],
    ) as Array<Record<string, unknown>>;
    expect(merged[0]).toEqual({ type: "inside", start: 25, end: 75 });
    expect(merged[1]).toEqual({ type: "slider", start: 25, end: 75 });
  });

  it("preserves live startValue/endValue when percentage bounds are absent", () => {
    const merged = mergeLiveZoom(
      { type: "inside", start: 0, end: 100 },
      [{ startValue: 10, endValue: 40 }],
    ) as Record<string, unknown>;
    expect(merged).toEqual({ type: "inside", startValue: 10, endValue: 40 });
  });
});

describe("echarts-research-runtime on-demand registration", () => {
  it("excludes unwired charts/components and avoids duplicate MarkPointComponent registration", () => {
    const source = readFileSync(resolve(import.meta.dirname, "echarts-research-runtime.ts"), "utf8");
    expect(source).not.toContain("GaugeChart");
    expect(source).not.toContain("HeatmapChart");
    expect(source).not.toContain("VisualMapComponent");
    expect(source).not.toContain("MarkPointComponent");
  });
});
