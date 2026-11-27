"use client";

import { MEDIA_QUERIES } from "@/lib/breakpoints";
import { useReducedMotion } from "@/lib/hooks";
import type { ECharts, EChartsOption, ECElementEvent } from "echarts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useReadingLock } from "@/ui/charts/reading";
import { useChartPalette } from "@/ui/charts/palette";
import { applyLumaChartTheme, mergeLiveZoom, type LiveZoomEntry } from "@/ui/charts/theme";

type EChartsRuntime = typeof import("@/ui/charts/echarts-runtime");
export type EChartsRuntimeProfile = "core" | "research";

type Runtime = {
  promise?: Promise<EChartsRuntime>;
  module?: EChartsRuntime;
  failed?: boolean;
};
const runtimes: Record<EChartsRuntimeProfile, Runtime> = { core: {}, research: {} };
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function preloadEChartsRuntime(profile: EChartsRuntimeProfile = "core"): Promise<EChartsRuntime> {
  const runtime = runtimes[profile];
  runtime.promise ??= (profile === "core"
    ? import("@/ui/charts/echarts-runtime")
    : Promise.all([preloadEChartsRuntime(), import("@/ui/charts/echarts-research-runtime")]).then(([core]) => core)
  ).then((module) => {
    runtime.module = module;
    listeners.forEach((listener) => listener());
    return module;
  }, (error) => {
    runtime.promise = undefined;
    runtime.failed = true;
    listeners.forEach((listener) => listener());
    throw error;
  });
  return runtime.promise;
}

export function useChartRuntime(profile: EChartsRuntimeProfile = "core") {
  const runtime = runtimes[profile];
  const status = useSyncExternalStore(
    subscribe,
    () => runtime.module ? "ready" : runtime.failed ? "failed" : "loading",
    () => "loading" as const,
  );
  useEffect(() => {
    if (!runtime.failed) void preloadEChartsRuntime(profile).catch(() => {});
  }, [profile, runtime]);
  return {
    status,
    retry() {
      runtime.failed = false;
      if (profile === "research") runtimes.core.failed = false;
      listeners.forEach((listener) => listener());
      void preloadEChartsRuntime(profile).catch(() => {});
    },
  };
}

function setController(controller: RefObject<ECharts | null> | undefined, value: ECharts | null) {
  if (controller) controller.current = value;
}

function withPreservedZoom(chart: ECharts, nextOption: EChartsOption): EChartsOption {
  if (!nextOption.dataZoom) return nextOption;
  const liveOption = chart.getOption() as { dataZoom?: LiveZoomEntry[] } | undefined;
  return {
    ...nextOption,
    dataZoom: mergeLiveZoom(nextOption.dataZoom, liveOption?.dataZoom),
  };
}

export function useECharts(
  option: EChartsOption | null,
  profile: EChartsRuntimeProfile = "core",
  controller?: RefObject<ECharts | null>,
  onZoom?: (chart: ECharts) => void,
  onClick?: (event: ECElementEvent) => void,
  pinned = false,
  updateWhileReading = false,
  onHover?: (event: ECElementEvent | null) => void,
) {
  const callbacks = useRef({ onZoom, onClick, onHover });
  useLayoutEffect(() => { callbacks.current = { onZoom, onClick, onHover }; }, [onZoom, onClick, onHover]);
  const reportsHover = onHover != null;
  const { chart: colours, scheme, ready } = useChartPalette();
  const reduced = useReducedMotion();
  const { status, retry } = useChartRuntime(profile);
  const themedOption = useMemo(
    () => (option && ready ? applyLumaChartTheme(option, colours, scheme, reduced) : null),
    [colours, scheme, option, ready, reduced],
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const attachCanvas = useCallback((element: HTMLDivElement | null) => {
    canvasRef.current = element;
    setCanvasEl(element);
  }, []);
  const chartRef = useRef<ECharts | null>(null);
  const lastApplied = useRef<EChartsOption | null>(null);
  const lastColours = useRef(colours);
  const latestColours = useRef(colours);
  const latest = useRef(themedOption);
  const preservedZoom = useRef<{ canvas: HTMLDivElement; zoom: LiveZoomEntry[] } | undefined>(undefined);
  const hasOption = themedOption !== null;
  const [interacting, setInteracting] = useState(false);
  const locked = interacting || pinned;
  useReadingLock(locked);

  useLayoutEffect(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    let hovering = false;
    const pressed = new Set<number>();
    const report = () => setInteracting(hovering || pressed.size > 0);
    const hover = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && !hovering) { hovering = true; report(); }
    };
    const leave = () => { hovering = false; report(); };
    const press = (event: PointerEvent) => { pressed.add(event.pointerId); report(); };
    const release = (event: PointerEvent) => { if (pressed.delete(event.pointerId)) report(); };
    const clear = () => { pressed.clear(); leave(); };
    canvas.addEventListener("pointerenter", hover);
    canvas.addEventListener("pointermove", hover);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", clear);
    return () => {
      canvas.removeEventListener("pointerenter", hover);
      canvas.removeEventListener("pointermove", hover);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", clear);
    };
  }, [canvasEl]);

  useLayoutEffect(() => {
    latest.current = themedOption;
    latestColours.current = colours;
  }, [colours, themedOption]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const runtime = runtimes[profile].module;
    // A callback ref runs during commit, before its element reaches state.
    if (!canvas || canvas !== canvasEl || !hasOption || !runtime || status !== "ready") return;
    const initialize = () => {
      if (chartRef.current || !latest.current || !canvas.clientWidth || !canvas.clientHeight) return;
      const chart = runtime.init(canvas, undefined, { renderer: "canvas" });
      canvas.dataset.tmChartInitCount = String(Number(canvas.dataset.tmChartInitCount ?? 0) + 1);
      chartRef.current = chart;
      chart.on("datazoom", () => callbacks.current.onZoom?.(chart));
      chart.on("click", (event: ECElementEvent) => callbacks.current.onClick?.(event));
      if (reportsHover) {
        chart.on("mouseover", (event: ECElementEvent) => callbacks.current.onHover?.(event));
        chart.on("mouseout", () => callbacks.current.onHover?.(null));
        chart.on("globalout", () => callbacks.current.onHover?.(null));
      }
      setController(controller, chart);
      const entry = latest.current;
      const saved = preservedZoom.current;
      preservedZoom.current = undefined;
      const restored = saved && saved.canvas !== canvas && entry.dataZoom
        ? { ...entry, dataZoom: mergeLiveZoom(entry.dataZoom, saved.zoom) }
        : entry;
      const noMotion = window.matchMedia(MEDIA_QUERIES.reducedMotion).matches;
      chart.setOption(noMotion ? { ...restored, animation: false } : restored, { notMerge: true });
      lastApplied.current = entry;
      lastColours.current = latestColours.current;
      canvas.dataset.tmChartReady = "true";
      canvas.dataset.tmChartAppliedAt = String(performance.mark("tm:chart-ready").startTime);
    };
    initialize();
    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current) chartRef.current.resize();
      else initialize();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      const liveOption = chartRef.current?.getOption() as { dataZoom?: LiveZoomEntry[] } | undefined;
      preservedZoom.current = liveOption?.dataZoom?.length ? { canvas, zoom: liveOption.dataZoom } : undefined;
      chartRef.current?.dispose();
      chartRef.current = null;
      lastApplied.current = null;
      delete canvas.dataset.tmChartReady;
      delete canvas.dataset.tmChartAppliedAt;
      setController(controller, null);
    };
  }, [canvasEl, hasOption, profile, controller, reportsHover, status]);

  useLayoutEffect(() => {
    const themeChanged = themedOption?.darkMode !== lastApplied.current?.darkMode || lastColours.current !== colours;
    if ((!locked || updateWhileReading || themeChanged) && themedOption && chartRef.current && lastApplied.current !== themedOption) {
      // Replace the option on the existing canvas. ECharts treats notMerge as a
      // new model, so animationDurationUpdate alone wouldn't prevent replay.
      const next = themeChanged
        ? withPreservedZoom(chartRef.current, { ...themedOption, animation: false })
        : { ...themedOption, animation: false };
      chartRef.current.setOption(next, { notMerge: true });
      lastApplied.current = themedOption;
      lastColours.current = colours;
      if (canvasRef.current) canvasRef.current.dataset.tmChartAppliedAt = String(performance.now());
    }
  }, [colours, locked, themedOption, updateWhileReading]);

  return { ref: attachCanvas, canvasEl, canvasRef, status, retry, applied: lastApplied };
}
