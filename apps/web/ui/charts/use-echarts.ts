"use client";

import { useComputedColorScheme } from "@mantine/core";
import type { ECharts, EChartsOption } from "echarts";
import { useEffect, useMemo, useRef } from "react";

type EChartsRuntime = typeof import("@/ui/charts/echarts-runtime");
export type EChartsRuntimeProfile = "core" | "research";

let runtimePromise: Promise<EChartsRuntime> | null = null;
let researchRuntimePromise: Promise<EChartsRuntime> | null = null;

function loadCoreRuntime() {
  runtimePromise ??= import("@/ui/charts/echarts-runtime");
  return runtimePromise;
}

function loadEChartsRuntime(profile: EChartsRuntimeProfile) {
  if (profile === "core") return loadCoreRuntime();
  researchRuntimePromise ??= Promise.all([
    loadCoreRuntime(),
    import("@/ui/charts/echarts-research-runtime"),
  ]).then(([runtime]) => runtime);
  return researchRuntimePromise;
}

export function preloadEChartsRuntime(profile: EChartsRuntimeProfile = "core") {
  return loadEChartsRuntime(profile);
}

export function useECharts(
  option: EChartsOption | null,
  profile: EChartsRuntimeProfile = "core",
) {
  const colourScheme = useComputedColorScheme("light");
  const themedOption = useMemo(
    () => option ? { ...option, darkMode: colourScheme === "dark" } : null,
    [colourScheme, option],
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const latestOptionRef = useRef(themedOption);
  const hasOption = themedOption !== null;

  useEffect(() => {
    latestOptionRef.current = themedOption;
  }, [themedOption]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasOption) return;

    let active = true;
    let initializing = false;
    const initialize = async () => {
      if (
        !active
        || chartRef.current
        || initializing
        || canvas.clientWidth === 0
        || canvas.clientHeight === 0
      ) return;

      initializing = true;
      try {
        const { init } = await loadEChartsRuntime(profile);
        if (
          !active
          || chartRef.current
          || canvas.clientWidth === 0
          || canvas.clientHeight === 0
        ) return;
        const chart = init(canvas, undefined, { renderer: "canvas" });
        chartRef.current = chart;
        if (latestOptionRef.current) {
          chart.setOption(latestOptionRef.current, { lazyUpdate: true, notMerge: true });
          requestAnimationFrame(() => {
            if (!active) return;
            canvas.dataset.tmChartReady = "true";
            performance.mark("tm:chart-ready");
          });
        }
      } finally {
        initializing = false;
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current) chartRef.current.resize();
      else void initialize();
    });
    resizeObserver.observe(canvas);
    void initialize();

    return () => {
      active = false;
      resizeObserver.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [hasOption, profile]);

  useEffect(() => {
    if (themedOption) {
      chartRef.current?.setOption(themedOption, { lazyUpdate: true, notMerge: true });
      if (chartRef.current && canvasRef.current) {
        canvasRef.current.dataset.tmChartReady = "true";
      }
    } else {
      chartRef.current?.clear();
      canvasRef.current?.removeAttribute("data-tm-chart-ready");
    }
  }, [themedOption]);

  return canvasRef;
}
