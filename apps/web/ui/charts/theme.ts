import type { ResolvedColorScheme } from "@/lib/color-scheme";
import type {
  EChartsOption,
  LegendComponentOption,
  SeriesOption,
  TooltipComponentOption,
  XAXisComponentOption,
  YAXisComponentOption,
} from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import { canvasShadow, withCanvasAlpha } from "@/ui/charts/canvas-colour";
import { FONT_STACK } from "@/ui/theme";

/** Fixed Luma series palette: primary cobalt, neutral comparison, amber accent, teal secondary, violet fifth. */
export function lumaSeriesPalette(colours: ChartColours): string[] {
  return [
    colours.brand,
    colours.comparison,
    colours.accent,
    colours.secondary,
    colours.series5,
  ];
}

export type LiveZoomEntry = {
  start?: number;
  end?: number;
  startValue?: number | string | Date;
  endValue?: number | string | Date;
};

/** Preserve the live zoom bounds across option replacements such as dark/light scheme switches. */
export function mergeLiveZoom(
  nextDataZoom: EChartsOption["dataZoom"],
  liveZooms: readonly LiveZoomEntry[] | undefined,
): EChartsOption["dataZoom"] {
  if (!nextDataZoom || !Array.isArray(liveZooms) || liveZooms.length === 0) return nextDataZoom;
  const mergeEntry = (entry: Record<string, unknown>, index: number) => {
    const live = liveZooms[index] ?? liveZooms[0];
    if (!live) return entry;
    if (typeof live.start === "number" && typeof live.end === "number") {
      const rest = { ...entry };
      delete rest.startValue;
      delete rest.endValue;
      return { ...rest, start: live.start, end: live.end };
    }
    if (live.startValue !== undefined && live.endValue !== undefined) {
      const rest = { ...entry };
      delete rest.start;
      delete rest.end;
      return { ...rest, startValue: live.startValue, endValue: live.endValue };
    }
    return entry;
  };
  return (Array.isArray(nextDataZoom)
    ? nextDataZoom.map((entry, index) => mergeEntry(entry as Record<string, unknown>, index))
    : mergeEntry(nextDataZoom as Record<string, unknown>, 0)) as EChartsOption["dataZoom"];
}

function themeAxes<T extends XAXisComponentOption | YAXisComponentOption>(
  axes: T | T[] | undefined,
  colours: ChartColours,
  horizontal: boolean,
): T | T[] | undefined {
  const theme = (axis: T): T => {
    const label = axis.axisLabel as Record<string, unknown> | undefined;
    const nameStyle = axis.nameTextStyle as Record<string, unknown> | undefined;
    const labelFontSize = typeof label?.fontSize === "number" ? Math.max(12, label.fontSize) : 12;
    const nameFontSize = typeof nameStyle?.fontSize === "number" ? Math.max(12, nameStyle.fontSize) : 12;
    const splitLine = axis.splitLine;
    return {
      ...axis,
      nameTextStyle: {
        color: colours.axis,
        fontFamily: FONT_STACK,
        ...nameStyle,
        fontSize: nameFontSize,
      },
      axisLabel: {
        color: colours.axis,
        fontFamily: FONT_STACK,
        hideOverlap: true,
        // Keep edge ticks inside without shifting labels centred below bars.
        ...(horizontal && (axis.type !== "category" || axis.boundaryGap === false) && {
          alignMinLabel: axis.inverse ? "right" : "left",
          alignMaxLabel: axis.inverse ? "left" : "right",
        }),
        ...(horizontal && axis.type === "category" && axis.boundaryGap === false && {
          showMinLabel: true,
          showMaxLabel: true,
        }),
        ...label,
        fontSize: labelFontSize,
      },
      axisLine: {
        ...axis.axisLine,
        lineStyle: { color: colours.border, width: 1, ...axis.axisLine?.lineStyle },
      },
      axisTick: {
        ...axis.axisTick,
        show: false,
      },
      splitLine: horizontal
        ? { show: false }
        : {
            ...splitLine,
            lineStyle: {
              color: colours.grid,
              type: "solid",
              width: 1,
              ...splitLine?.lineStyle,
            },
          },
    };
  };
  return Array.isArray(axes) ? axes.map(theme) : axes ? theme(axes) : undefined;
}

function themeLegend(
  legend: LegendComponentOption | LegendComponentOption[] | undefined,
  colours: ChartColours,
): LegendComponentOption | LegendComponentOption[] | undefined {
  const apply = (entry: LegendComponentOption): LegendComponentOption => {
    const base = {
      ...entry,
      textStyle: {
        color: colours.text,
        fontSize: 12,
        fontFamily: FONT_STACK,
        ...entry.textStyle,
      },
    };
    if (entry.type !== "scroll") return base;
    const scroll = entry as Record<string, unknown>;
    return {
      ...base,
      pageTextStyle: {
        color: colours.axis,
        fontSize: 12,
        fontFamily: FONT_STACK,
        ...(scroll.pageTextStyle as Record<string, unknown> | undefined),
      },
      pageIconColor: scroll.pageIconColor ?? colours.text,
      pageIconInactiveColor: scroll.pageIconInactiveColor ?? colours.axis,
    } as LegendComponentOption;
  };
  return Array.isArray(legend) ? legend.map(apply) : legend ? apply(legend) : undefined;
}

function themeDataZoom(
  dataZoom: EChartsOption["dataZoom"],
  colours: ChartColours,
  scheme: ResolvedColorScheme,
): EChartsOption["dataZoom"] {
  if (!dataZoom) return undefined;
  const apply = (entry: Record<string, unknown>) => {
    if (entry.type !== "slider") return entry;
    const handleStyle = entry.handleStyle as Record<string, unknown> | undefined;
    const moveHandleStyle = entry.moveHandleStyle as Record<string, unknown> | undefined;
    const dataBackground = entry.dataBackground as Record<string, unknown> | undefined;
    const selectedDataBackground = entry.selectedDataBackground as Record<string, unknown> | undefined;
    const textStyle = entry.textStyle as Record<string, unknown> | undefined;
    return {
      backgroundColor: colours.muted,
      borderColor: colours.grid,
      fillerColor: withCanvasAlpha(colours.selection, scheme === "dark" ? 0.65 : 0.75),
      ...entry,
      handleStyle: {
        color: colours.canvas,
        borderColor: colours.border,
        borderWidth: 1,
        ...handleStyle,
      },
      moveHandleStyle: {
        color: colours.border,
        ...moveHandleStyle,
      },
      dataBackground: {
        lineStyle: { color: colours.border, width: 1 },
        areaStyle: { color: colours.grid, opacity: 0.4 },
        ...dataBackground,
      },
      selectedDataBackground: {
        lineStyle: { color: colours.brand, width: 1 },
        areaStyle: { color: colours.brand, opacity: 0.13 },
        ...selectedDataBackground,
      },
      textStyle: {
        color: colours.axis,
        fontSize: 12,
        fontFamily: FONT_STACK,
        ...textStyle,
      },
    };
  };
  return (Array.isArray(dataZoom)
    ? dataZoom.map((entry) => apply(entry as Record<string, unknown>))
    : apply(dataZoom as Record<string, unknown>)) as EChartsOption["dataZoom"];
}

function themeSeries(
  series: SeriesOption | SeriesOption[] | undefined,
  colours: ChartColours,
): SeriesOption | SeriesOption[] | undefined {
  if (!series) return undefined;
  const apply = (entry: SeriesOption): SeriesOption => {
    const raw = entry as Record<string, unknown>;
    const markLine = raw.markLine as Record<string, unknown> | undefined;
    const themedMarkLine = markLine
      ? {
          ...markLine,
          lineStyle: {
            color: colours.axis,
            type: [3, 3],
            width: 1,
            ...(markLine.lineStyle as Record<string, unknown> | undefined),
          },
        }
      : undefined;

    if (entry.type === "line") {
      const silent = raw.silent === true;
      const lineStyle = raw.lineStyle as Record<string, unknown> | undefined;
      return {
        ...entry,
        symbolSize: raw.symbolSize ?? 6,
        ...(!silent
          ? {
              lineStyle: {
                width: 2,
                ...lineStyle,
              },
            }
          : {}),
        ...(themedMarkLine ? { markLine: themedMarkLine } : {}),
      } as SeriesOption;
    }

    if (entry.type === "candlestick") {
      const itemStyle = raw.itemStyle as Record<string, unknown> | undefined;
      return {
        ...entry,
        itemStyle: {
          color: colours.positive,
          color0: colours.negative,
          borderColor: colours.positive,
          borderColor0: colours.negative,
          ...itemStyle,
        },
        ...(themedMarkLine ? { markLine: themedMarkLine } : {}),
      } as SeriesOption;
    }

    return themedMarkLine ? ({ ...entry, markLine: themedMarkLine } as SeriesOption) : entry;
  };
  return Array.isArray(series) ? series.map(apply) : apply(series);
}

/** Build the Luma canvas-safe richText tooltip matching shadcn Popover/Tooltip surfaces. */
export function buildLumaTooltip(colours: ChartColours): TooltipComponentOption {
  return {
    trigger: "axis",
    renderMode: "richText",
    backgroundColor: colours.tooltip,
    borderColor: colours.tooltipBorder,
    borderWidth: 1,
    padding: [8, 12],
    confine: true,
    textStyle: {
      color: colours.tooltipText,
      fontSize: 12,
      fontFamily: FONT_STACK,
    },
    axisPointer: {
      type: "line",
      lineStyle: { color: colours.axis, type: "solid", width: 1 },
    },
    borderRadius: Number.parseFloat(colours.tooltipRadius),
    ...canvasShadow(colours.shadowPopover),
  };
}

function themeTooltip(
  tooltip: EChartsOption["tooltip"],
  colours: ChartColours,
): EChartsOption["tooltip"] {
  if (!tooltip) return undefined;
  const apply = (entry: TooltipComponentOption): TooltipComponentOption => {
    if (entry.show === false) return { ...entry, renderMode: "richText" };
    const defaults = buildLumaTooltip(colours);
    const defaultText = defaults.textStyle as Record<string, unknown>;
    const customText = entry.textStyle as Record<string, unknown> | undefined;
    return {
      ...defaults,
      ...entry,
      renderMode: "richText",
      textStyle: {
        ...defaultText,
        ...customText,
        fontFamily: FONT_STACK,
      },
    };
  };
  return Array.isArray(tooltip) ? tooltip.map(apply) : apply(tooltip);
}

/**
 * Single Luma ECharts 6 theme layer applied to every chart instance.
 * Guarantees canvas-safe RGB colours, product typography, 12px muted axes without ticks,
 * hairline horizontal gridlines, 2px primary lines, 6px hover dots, themed slider dataZoom,
 * and shadcn-aligned richText tooltips without any HTML sink.
 */
export function applyLumaChartTheme(
  option: EChartsOption,
  colours: ChartColours,
  scheme: ResolvedColorScheme,
  reducedMotion: boolean,
): EChartsOption {
  const textStyle = option.textStyle as Record<string, unknown> | undefined;
  return {
    backgroundColor: "transparent",
    color: lumaSeriesPalette(colours),
    ...option,
    darkMode: scheme === "dark",
    animation: !reducedMotion && option.animation !== false,
    animationDuration: option.animationDuration ?? 150,
    animationDurationUpdate: 0,
    // "inherit" is not a canvas font; without an explicit stack labels fall back to 10px.
    textStyle: {
      color: colours.text,
      fontSize: 12,
      ...textStyle,
      fontFamily: FONT_STACK,
    },
    ...(option.xAxis !== undefined ? { xAxis: themeAxes(option.xAxis, colours, true) } : {}),
    ...(option.yAxis !== undefined ? { yAxis: themeAxes(option.yAxis, colours, false) } : {}),
    ...(option.legend !== undefined ? { legend: themeLegend(option.legend, colours) } : {}),
    ...(option.dataZoom !== undefined ? { dataZoom: themeDataZoom(option.dataZoom, colours, scheme) } : {}),
    ...(option.series !== undefined ? { series: themeSeries(option.series, colours) } : {}),
    ...(option.tooltip !== undefined ? { tooltip: themeTooltip(option.tooltip, colours) } : {}),
  };
}
