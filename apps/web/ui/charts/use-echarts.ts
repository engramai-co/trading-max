"use client";

import { useComputedColorScheme } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import type { ECharts, EChartsOption, ECElementEvent } from "echarts";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { FONT_STACK } from "@/ui/theme";

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

export function useECharts(
  option: EChartsOption | null,
  profile: EChartsRuntimeProfile = "core",
  controller?: RefObject<ECharts | null>,
  onZoom?: (chart: ECharts) => void,
  onClick?: (event: ECElementEvent) => void,
) {
  const callbacks = useRef({ onZoom, onClick });
  useLayoutEffect(() => { callbacks.current = { onZoom, onClick }; }, [onZoom, onClick]);
  const colourScheme = useComputedColorScheme("light");
  const reduced = useReducedMotion();
  const { status, retry } = useChartRuntime(profile);
  const themedOption = useMemo(
    () =>
      option
        ? {
            ...option,
            animation: !reduced && option.animation !== false,
            animationDuration: 150,
            animationDurationUpdate: 0,
            // "inherit" is not a canvas font; without a family the labels fall back to 10px.
            textStyle: { fontSize: 12, ...(option.textStyle as object | undefined), fontFamily: FONT_STACK },
            darkMode: colourScheme === "dark",
          }
        : null,
    [colourScheme, option, reduced],
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const lastApplied = useRef<EChartsOption | null>(null);
  const latest = useRef(themedOption);
  const hasOption = themedOption !== null;

  useLayoutEffect(() => { latest.current = themedOption; }, [themedOption]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const runtime = runtimes[profile].module;
    if (!canvas || !hasOption || !runtime || status !== "ready") return;
    const initialize = () => {
      if (chartRef.current || !latest.current || !canvas.clientWidth || !canvas.clientHeight) return;
      const chart = runtime.init(canvas, undefined, { renderer: "canvas" });
      chartRef.current = chart;
      chart.on("datazoom", () => callbacks.current.onZoom?.(chart));
      chart.on("click", (event: ECElementEvent) => callbacks.current.onClick?.(event));
      setController(controller, chart);
      const entry = latest.current;
      const noMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      chart.setOption(noMotion ? { ...entry, animation: false } : entry, { notMerge: true });
      lastApplied.current = latest.current;
      canvas.dataset.tmChartReady = "true";
      performance.mark("tm:chart-ready");
    };
    initialize();
    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current) chartRef.current.resize();
      else initialize();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
      lastApplied.current = null;
      delete canvas.dataset.tmChartReady;
      setController(controller, null);
    };
  }, [hasOption, profile, controller, status]);

  useLayoutEffect(() => {
    if (themedOption && chartRef.current && lastApplied.current !== themedOption) {
      // Replace the option on the existing canvas. ECharts treats notMerge as a
      // new model, so animationDurationUpdate alone wouldn't prevent replay.
      chartRef.current.setOption({ ...themedOption, animation: false }, { notMerge: true });
      lastApplied.current = themedOption;
    }
  }, [themedOption]);

  return { ref: canvasRef, status, retry };
}
