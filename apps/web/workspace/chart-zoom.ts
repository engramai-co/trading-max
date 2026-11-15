import type { ECharts } from "echarts";
import { useRef, type PointerEvent } from "react";

export type ZoomRange = { start: number; end: number };
type Point = { x: number; y: number };
const entire: ZoomRange = { start: 0, end: 100 };

export function chartZoom(chart: ECharts | null): ZoomRange {
  const item = (chart?.getOption().dataZoom as Array<Partial<ZoomRange>> | undefined)?.[0];
  return item?.start == null || item.end == null ? entire : { start: item.start, end: item.end };
}

export function zoomRange(zoom: ZoomRange, factor: number, pan = 0, anchor = 0.5) {
  const width = zoom.end - zoom.start;
  const next = Math.min(100, Math.max(3, width * factor));
  const start = Math.max(0, Math.min(100 - next, zoom.start + (width - next) * anchor + pan));
  return { start, end: start + next };
}

export function changeZoom(chart: ECharts | null, range: ZoomRange) {
  chart?.dispatchAction({ type: "dataZoom", ...range });
}

/** The browser owns vertical touch scrolling. Only horizontal movement or a
 * two-finger scale beyond the threshold claims the pointer stream. */
export function useChartGestures(chart: () => ECharts | null, enabled: boolean) {
  const state = useRef({
    pointers: new Map<number, Point>(),
    mode: "pending" as "pending" | "horizontal" | "vertical" | "pinch" | "blocked",
    origin: { x: 0, y: 0 },
    zoom: entire,
    separation: 0,
  });
  const point = (event: PointerEvent<HTMLDivElement>) => ({ x: event.clientX, y: event.clientY });
  const distance = () => {
    const [a, b] = state.current.pointers.values();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  return {
    down(event: PointerEvent<HTMLDivElement>) {
      if (!enabled || event.button !== 0) return;
      const gesture = state.current;
      gesture.pointers.set(event.pointerId, point(event));
      if (gesture.pointers.size === 1) {
        gesture.origin = point(event);
        gesture.mode = "pending";
        gesture.zoom = chartZoom(chart());
      } else if (gesture.pointers.size === 2) {
        gesture.separation = distance();
        gesture.zoom = chartZoom(chart());
        gesture.mode = "pinch";
      }
    },
    move(event: PointerEvent<HTMLDivElement>) {
      const gesture = state.current;
      if (!enabled || !gesture.pointers.has(event.pointerId)) return false;
      gesture.pointers.set(event.pointerId, point(event));
      const dx = event.clientX - gesture.origin.x;
      const dy = event.clientY - gesture.origin.y;
      if (gesture.mode === "pending" && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
        gesture.mode = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      }
      const instance = chart();
      if (gesture.mode === "horizontal" && instance) {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
        changeZoom(instance, zoomRange(gesture.zoom, 1, -dx / event.currentTarget.clientWidth * (gesture.zoom.end - gesture.zoom.start)));
      } else if (gesture.mode === "pinch" && instance && gesture.separation > 0 && Math.abs(distance() - gesture.separation) >= 8) {
        const [a, b] = gesture.pointers.values();
        const rect = event.currentTarget.getBoundingClientRect();
        const anchor = Math.max(0, Math.min(1, ((a.x + b.x) / 2 - rect.left) / rect.width));
        changeZoom(instance, zoomRange(gesture.zoom, gesture.separation / Math.max(1, distance()), 0, anchor));
      }
      return gesture.mode !== "pending";
    },
    end(event: PointerEvent<HTMLDivElement>) {
      const gesture = state.current;
      const tracked = gesture.pointers.delete(event.pointerId);
      if (!tracked) return false;
      const consumed = gesture.mode !== "pending";
      if (gesture.pointers.size && gesture.mode === "pinch") gesture.mode = "blocked";
      return consumed;
    },
  };
}
