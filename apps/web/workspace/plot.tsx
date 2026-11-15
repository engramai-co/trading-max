"use client";

import { FocusTrap, useComputedColorScheme } from "@mantine/core";
import { ArrowsOut, ArrowsIn } from "@phosphor-icons/react";
import { useLocale } from "@/components/locale-provider";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import type { ECharts, EChartsOption, XAXisComponentOption, YAXisComponentOption } from "echarts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Pending, useCopy } from "./foundation";
import { closestChartPosition, type ChartReadout } from "./chart-readout";
import { chartNumber } from "./research-chart-format";
import { exportChartCsv, exportChartPng } from "./chart-export";
import { changeZoom, chartZoom, useChartGestures, zoomRange } from "./chart-zoom";

function themeAxes<T extends XAXisComponentOption | YAXisComponentOption>(
  axes: T | T[] | undefined,
  colours: ChartColours,
  horizontal = false,
): T | T[] | undefined {
  const theme = (axis: T): T => ({
    ...axis,
    nameTextStyle: { color: colours.axis, ...axis.nameTextStyle },
    axisLabel: {
      color: colours.axis,
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
      ...axis.axisLabel,
    },
    axisLine: {
      ...axis.axisLine,
      lineStyle: { color: colours.axis, ...axis.axisLine?.lineStyle },
    },
    axisTick: {
      ...axis.axisTick,
      lineStyle: { color: colours.axis, ...axis.axisTick?.lineStyle },
    },
    splitLine: {
      ...axis.splitLine,
      lineStyle: {
        color: colours.grid,
        type: "dashed",
        ...axis.splitLine?.lineStyle,
      },
    },
  });
  return Array.isArray(axes) ? axes.map(theme) : axes ? theme(axes) : undefined;
}

export function Plot({
  label,
  option,
  height = 300,
  research = false,
  controller,
  onZoom,
  readPoint,
  readout,
  overlay,
  fullscreen = false,
  customGestures = false,
  selection,
}: {
  label: string;
  option: (colours: ChartColours) => EChartsOption;
  height?: number;
  research?: boolean;
  controller?: RefObject<ECharts | null>;
  onZoom?: (chart: ECharts) => void;
  readPoint?: (index: number) => string;
  readout?: ChartReadout;
  overlay?: ReactNode;
  fullscreen?: boolean;
  customGestures?: boolean;
  selection?: RefObject<number | null>;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const description = useId();
  const [reading, setReading] = useState("");
  const [pinned, setPinned] = useState(false);
  const [picked, setPicked] = useState<number | null>(() => selection?.current ?? null);
  const [expanded, setExpanded] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const closeTrigger = useRef<HTMLButtonElement>(null);
  const scheme = useComputedColorScheme("light");
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [expanded]);
  const closeFullscreen = () => {
    setExpanded(false);
    requestAnimationFrame(() => fullscreenTrigger.current?.focus());
  };
  const cursor = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const colours = useChartColours();
  const settings = useMemo<EChartsOption>(() => {
    const custom = option(colours);
    return {
      backgroundColor: "transparent",
      textStyle: { color: colours.text, fontSize: 12 },
      color: [
        colours.brand,
        colours.accent,
        colours.secondary,
        colours.negative,
      ],
      grid: { top: 20, right: 18, bottom: 30, left: 58 },
      ...custom,
      dataZoom: custom.dataZoom ?? (fullscreen ? [{
        type: "inside", disabled: true, xAxisIndex: Array.isArray(custom.xAxis) ? custom.xAxis.map((_, i) => i) : 0,
        filterMode: "none",
      }] : undefined),
      xAxis: themeAxes(custom.xAxis, colours, true),
      yAxis: themeAxes(custom.yAxis, colours),
      legend: Array.isArray(custom.legend)
        ? custom.legend.map((legend) => ({
            ...legend,
            textStyle: { color: colours.text, ...legend.textStyle },
          }))
        : custom.legend
          ? {
              ...custom.legend,
              textStyle: { color: colours.text, ...custom.legend.textStyle },
            }
          : undefined,
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        backgroundColor: colours.tooltip,
        textStyle: { color: colours.tooltipText, fontSize: 12 },
        borderWidth: 1,
        borderColor: colours.tooltipBorder,
        shadowBlur: 16,
        shadowColor: colours.tooltipShadow,
        shadowOffsetY: 4,
        padding: 12,
        confine: true,
        // Research charts read in the reader's units; portfolio charts keep theirs.
        valueFormatter: (value) => chartNumber(value, research ? locale : "en"),
        axisPointer: {
          type: "line",
          lineStyle: { color: colours.axis, type: "dashed" },
        },
        ...(custom.tooltip && !Array.isArray(custom.tooltip)
          ? custom.tooltip
          : {}),
        ...(readout ? { show: false, triggerOn: "none" } : {}),
      },

    };
  }, [colours, option, research, locale, readout, fullscreen]);
  const internal = useRef<ECharts | null>(null);
  const selected = useRef(0);
  const control = controller ?? internal;
  const { ref, status, retry, applied } = useECharts(
    settings,
    research ? "research" : "core",
    control,
    (instance) => {
      setPicked(null);
      if (selection) selection.current = null;
      setPinned(false);
      onZoom?.(instance);
    },
    undefined,
    pinned || picked != null || Boolean(reading),
  );
  const gestures = useChartGestures(() => control.current, expanded || customGestures);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !(expanded || customGestures)) return;
    const scroll = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const instance = control.current;
      const box = canvas.getBoundingClientRect();
      const anchor = (event.clientX - box.left) / box.width;
      changeZoom(instance, zoomRange(chartZoom(instance), Math.exp(event.deltaY * 0.004), 0, anchor));
    };
    canvas.addEventListener("wheel", scroll, { passive: false });
    return () => canvas.removeEventListener("wheel", scroll);
  }, [control, ref, expanded, customGestures]);
  const active = picked != null && readout?.positions[closestChartPosition(readout.positions, picked)] === picked
    ? picked : null;
  useLayoutEffect(() => {
    const el = cursor.current;
    const bounds = ref.current;
    if (!el || !bounds) return;
    const draw = () => {
      const x = active == null ? NaN : control.current?.convertToPixel({ xAxisIndex: 0 }, active);
      el.style.visibility = typeof x === "number" && x >= 0 && x <= bounds.clientWidth ? "visible" : "hidden";
      if (typeof x === "number") el.style.transform = `translateX(${x}px)`;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(bounds);
    return () => observer.disconnect();
  }, [active, control, ref, status]);

  const pickAt = (event: PointerEvent<HTMLDivElement>) => {
    if (!readout) return null;
    const instance = control.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const axes = Array.isArray(settings.xAxis) ? settings.xAxis.length : 1;
    if (!instance || !(readout.gridIndexes ?? Array.from({ length: axes }, (_, i) => i)).some((gridIndex) =>
      instance.containPixel({ gridIndex }, [x, y]))) return null;
    const target = instance.convertFromPixel({ xAxisIndex: 0 }, x);
    if (typeof target !== "number" || !Number.isFinite(target) || readout.gap?.(target)) return null;
    return readout.positions[closestChartPosition(readout.positions, target)] ?? null;
  };
  const choose = (point: number | null) => {
    setPicked(point);
    if (selection) selection.current = point;
  };
  const dismiss = () => {
    choose(null);
    control.current?.setOption({ tooltip: { alwaysShowContent: false } });
    control.current?.dispatchAction({ type: "hideTip" });
    setPinned(false);
    setReading("");
  };
  const currentReading = readout && readout.positions.length ? readout.point(active ?? readout.positions.at(-1)!) : "";
  const zoomBy = (factor: number) => changeZoom(control.current, zoomRange(chartZoom(control.current), factor));
  const visibleRecords = () => {
    if (!readout?.records) return [];
    const x = control.current;
    if (!x) return [];
    const positions = readout.positions;
    const domain = chartZoom(x);
    const start = positions[0], end = positions.at(-1)!;
    const min = start + (end - start) * domain.start / 100;
    const max = start + (end - start) * domain.end / 100;
    const rows = readout.records;
    return positions.flatMap((position) => position >= min && position <= max ? rows(position) : []);
  };
  const action = async (work: () => void | Promise<void>, success = "") => {
    try {
      await work();
      setExportStatus(success);
    } catch {
      setExportStatus(t("未能完成操作", "Action unavailable"));
    }
  };
  const hasTools = fullscreen || (!!readout?.records);
  const content = (
    <div className={hasTools ? "mx-chart-host" : undefined} data-expanded={expanded || undefined}
      role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? label : undefined}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          closeFullscreen();
        }
      }}>
    {hasTools && <div className="mx-chart-actions">
      {expanded && <strong>{label}</strong>}
      {expanded && <div className="mx-chart-zoom-buttons" aria-label={t("图表缩放", "Chart zoom")}>
        <button type="button" aria-label={t("放大", "Zoom in")} onClick={() => zoomBy(0.65)}>+</button>
        <button type="button" aria-label={t("缩小", "Zoom out")} onClick={() => zoomBy(1.55)}>−</button>
        <button type="button" onClick={() => changeZoom(control.current, { start: 0, end: 100 })}>{t("恢复范围", "Reset zoom")}</button>
      </div>}
      {readout?.records && <details>
        <summary>{t("更多", "More")}</summary>
        <div className="mx-chart-menu">
          <button type="button" onClick={() => void action(async () => {
            const plain = currentReading.replaceAll("\n", " · ");
            if (typeof ClipboardItem === "function" && ClipboardItem.supports?.("text/tab-separated-values")) {
              await navigator.clipboard.write([new ClipboardItem({
                "text/plain": new Blob([plain], { type: "text/plain" }),
                "text/tab-separated-values": new Blob([currentReading.replaceAll("\n", "\t")], { type: "text/tab-separated-values" }),
              })]);
            } else await navigator.clipboard.writeText(plain);
          }, t("已复制", "Copied"))}>{t("复制读数", "Copy reading")}</button>
          <button type="button" onClick={() => void action(() => exportChartCsv(visibleRecords()))}>{t("导出 CSV", "Export CSV")}</button>
          <button type="button" onClick={() => void action(async () => {
            if (control.current) await exportChartPng(control.current, label, currentReading, scheme === "dark");
          })}>{t("导出 PNG", "Export PNG")}</button>
          <span role="status">{exportStatus}</span>
        </div>
      </details>}
      {fullscreen && (expanded
        ? <button data-autofocus type="button" ref={closeTrigger} aria-label={t("退出全屏", "Exit fullscreen")} onClick={closeFullscreen}><ArrowsIn aria-hidden="true" size={17} /></button>
        : <button type="button" ref={fullscreenTrigger} aria-label={t("全屏", "Fullscreen")} onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => closeTrigger.current?.focus());
        }}><ArrowsOut aria-hidden="true" size={17} /></button>)}
    </div>}
    {readout && <div className="mx-chart-readout">
      <div className="mx-chart-readout-latest"><strong>{readout.latest}</strong>
        {(readout.observationCount ?? readout.positions.length) < 3 && <span data-chart-sparse="true">
          {t("仅", "Only")} {readout.observationCount ?? readout.positions.length} {t("个观测", "observations")}
        </span>}
      </div>
      <div className="mx-chart-readout-values" data-chart-reading={active == null ? "latest" : "selected"} aria-live="polite" aria-atomic="true">
        {currentReading.split("\n").filter(Boolean).map((line, i) => <span key={i}>{line}</span>)}
      </div>
    </div>}
    <div className="mx-plot" style={{ height: expanded ? `max(${height}px, calc(100dvh - 180px))` : height }}>
      {overlay}
      <div
        role="group"
        aria-roledescription={t("交互图表", "Interactive chart")}
        aria-label={label}
        aria-describedby={description}
        tabIndex={0}
        onPointerMove={(event) => {
          if (gestures.move(event) || !readout || pinned || event.pointerType === "touch" || event.buttons) return;
          const position = pickAt(event);
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => choose(position));
        }}
        onPointerLeave={() => {
          cancelAnimationFrame(frame.current);
          if (readout && !pinned) choose(null);
        }}
        onPointerCancel={(event) => { gestures.end(event); touchStart.current = null; }}
        onPointerDown={(event) => {
          gestures.down(event);
          if (event.pointerType === "touch" || readout)
            touchStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (gestures.end(event)) return;
          if (
            (event.pointerType !== "touch" && !readout) ||
            !start ||
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
          )
            return;
          if (readout) {
            const position = pickAt(event);
            if (position === active && pinned || position == null) dismiss();
            else { choose(position); setPinned(true); }
            return;
          }
          if (pinned) {
            dismiss();
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          control.current?.setOption({ tooltip: { alwaysShowContent: true } });
          control.current?.dispatchAction({
            type: "showTip",
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          });
          setPinned(true);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (!pinned && (reading || active != null) &&
            !(next && event.currentTarget.closest(".mx-chart-host")?.contains(next))) dismiss();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (pinned || reading || active != null) {
              event.preventDefault();
              event.stopPropagation();
            }
            dismiss();
            return;
          }
          if (readout) {
            const values = readout.positions;
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              if (pinned) dismiss();
              else if (values.length) { choose(active ?? values.at(-1)!); setPinned(true); }
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !values.length) return;
            event.preventDefault();
            const index = active == null ? values.length - 1 : closestChartPosition(values, active);
            const next = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1
              : Math.max(0, Math.min(values.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
            choose(values[next]);
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const option = applied.current ?? settings;
          const series = Array.isArray(option.series) ? option.series[0] : option.series;
          const count =
            series && "data" in series && Array.isArray(series.data)
              ? series.data.length
              : 0;
          if (!count) return;
          selected.current =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? count - 1
                : Math.max(
                    0,
                    Math.min(
                      count - 1,
                      selected.current + (event.key === "ArrowRight" ? 1 : -1),
                    ),
                  );
          control.current?.dispatchAction({
            type: "showTip",
            seriesIndex: 0,
            dataIndex: selected.current,
          });
          setReading(readPoint?.(selected.current) ?? chartReading(option, selected.current, locale, t));
        }}
        ref={ref}
        style={{ height: "100%", width: "100%", touchAction: expanded || customGestures ? "pan-y" : undefined }}
      />
      {readout && <div className="mx-chart-cursor" ref={cursor} aria-hidden="true" />}
      {status !== "ready" && <div className="mx-plot-loading">
        {status === "loading" ? <Pending shape="chart" label={t("正在绘制图表…", "Preparing chart…")} />
          : <button className="mx-inline-retry" type="button" onClick={retry}>{t("重试绘图", "Retry chart")}</button>}
      </div>}
      <span id={description} className="sr-only">
        {t(
          "左右方向键查看相邻读数，Home 和 End 到首尾，Escape 关闭。触控轻点固定读数，再次轻点关闭。",
          "Use arrow keys for adjacent readings, Home and End for the first and last point, and Escape to dismiss. Tap to pin a reading, then tap again to dismiss.",
        )}
      </span>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reading}
      </span>
      {pinned && (
        <button type="button" className="mx-chart-dismiss" onClick={dismiss}>
          {t("关闭读数", "Dismiss reading")}
        </button>
      )}
    </div>
    </div>
  );
  return fullscreen ? <FocusTrap active={expanded}>{content}</FocusTrap> : content;
}

function chartReading(
  option: EChartsOption,
  index: number,
  locale: string,
  t: ReturnType<typeof useCopy>,
): string {
  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis];
  const valueAxes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
  const series = Array.isArray(option.series) ? option.series : [option.series];
  const missing = t("无数据", "No data");
  const format = (v: unknown): string =>
    typeof v === "number"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(v)
      : v == null
        ? missing
        : String(v);
  const coordinate = (
    value: unknown,
    axis: XAXisComponentOption | YAXisComponentOption | undefined,
    fallback: (value: unknown) => string,
  ): string => {
    if (typeof value !== "number") return fallback(value);
    if (axis?.type === "category") {
      const entry = axis.data?.[value];
      return format(entry && typeof entry === "object" ? entry.value : entry);
    }
    if (axis?.type === "time") return new Date(value).toLocaleString(locale);
    if (axis?.type === "value" || axis?.type === "log") {
      const formatter = axis.axisLabel?.formatter;
      if (typeof formatter === "function")
        return String(formatter(value, index, undefined))
          .replace(/\{[^{}|]+\|([^{}]*)\}/g, "$1")
          .replace(/\s+/g, " ");
      if (typeof formatter === "string")
        return formatter.replace("{value}", format(value));
    }
    return fallback(value);
  };
  return series
    .flatMap((s) => {
      if (!s || s.silent || !("data" in s) || !Array.isArray(s.data)) return [];
      const raw = s.data[index];
      const value =
        raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
      const axis =
        axes[
          "xAxisIndex" in s && typeof s.xAxisIndex === "number"
            ? s.xAxisIndex
            : 0
        ];
      const category =
        axis && "data" in axis && Array.isArray(axis.data)
          ? axis.data[index]
          : null;
      const heading = [category, s.name].filter((v) => v != null).join(" · ");
      const valueAxis =
        valueAxes[
          "yAxisIndex" in s && typeof s.yAxisIndex === "number"
            ? s.yAxisIndex
            : 0
        ];
      const valueFormatter = !Array.isArray(option.tooltip)
        ? option.tooltip?.valueFormatter
        : undefined;
      const axisFormatter = valueAxis?.axisLabel?.formatter;
      const formatReading = (v: unknown) => {
        if (v == null || typeof v !== "number") return format(v);
        if (typeof valueFormatter === "function")
          return String(valueFormatter(v, index));
        if (valueAxis?.type === "value" || valueAxis?.type === "log") {
          const formatter = valueAxis.axisLabel?.formatter;
          if (typeof formatter === "function")
            return String(formatter(v, index, undefined));
        }
        if (typeof axisFormatter === "string")
          return axisFormatter.replace("{value}", format(v));
        return format(v);
      };
      if (s.type === "candlestick" && Array.isArray(value)) {
        const labels = [
          t("开盘", "Open"),
          t("收盘", "Close"),
          t("最低", "Low"),
          t("最高", "High"),
        ];
        return `${heading}: ${value.map((v, i) => `${labels[i] ?? i} ${format(v)}`).join(", ")}`;
      }
      if (
        Array.isArray(value) &&
        axis?.type === "time" &&
        typeof value[0] === "number"
      )
        return `${new Date(value[0]).toLocaleString(locale)} · ${s.name ?? ""}: ${value.slice(1).map(formatReading).join(", ")}`;
      if (Array.isArray(value) && value.length === 2)
        return `${heading}: ${coordinate(value[0], axis, format)}, ${coordinate(value[1], valueAxis, formatReading)}`;
      return `${heading}: ${Array.isArray(value) ? value.map((v, i) => (i === value.length - 1 ? formatReading(v) : format(v))).join(", ") : formatReading(value)}`;
    })
    .join("; ");
}
