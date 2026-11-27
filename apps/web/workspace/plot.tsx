"use client";

import { Button, CloseButton } from "@/components/ui/button";
import { Toolbar } from "@base-ui/react/toolbar";
import { ChartToolbar } from "./chart-toolbar";
import { Dialog, DialogOverlay, DialogPortal, DialogSurface } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBreakpoint } from "@/lib/hooks";
import { Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/locale-provider";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import type { ECharts, EChartsOption, ECElementEvent, XAXisComponentOption, YAXisComponentOption } from "echarts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Pending, useCopy } from "./foundation";
import { isImeComposing } from "./shortcut-platform";
import { closestChartPosition, readingText, type ChartReadout, type Reading } from "./chart-readout";
import { ReadingCard } from "./reading-card";
import { chartNumber } from "./research-chart-format";
import { exportChartCsv, exportChartPng } from "./chart-export";
import { changeZoom, chartZoom, useChartGestures, zoomRange } from "./chart-zoom";

/** The first index whose position is at or after the target. */
function after(positions: readonly number[], target: number) {
  let lo = 0, hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Hit = ({ position: number } | { gap: readonly [number, number] }) & { x: number; grid?: number };

export function Plot({
  label,
  option,
  height = 300,
  research = false,
  updateWhileReading = false,
  controller,
  onZoom,
  onPointClick,
  onPointHover,
  readPoint,
  readout,
  overlay,
  pin,
  fullscreen = false,
  customGestures = false,
  initialSelection = null,
  onSelectionChange,
  onBrush,
  keyboardPanes,
  pointInstructions,
  inlineActions,
}: {
  label: string;
  option: (colours: ChartColours) => EChartsOption;
  height?: number;
  research?: boolean;
  updateWhileReading?: boolean;
  controller?: RefObject<ECharts | null>;
  onZoom?: (chart: ECharts) => void;
  onPointClick?: (event: ECElementEvent) => void;
  onPointHover?: (event: ECElementEvent | null) => void;
  readPoint?: (index: number) => string;
  readout?: ChartReadout;
  overlay?: ReactNode;
  /** A reading the caller pinned from a tap (charts without a readout); shown in the phone strip. */
  pin?: { reading: Reading; onClose: () => void } | null;
  fullscreen?: boolean;
  customGestures?: boolean;
  initialSelection?: number | null;
  onBrush?: (start: number, end: number) => void;
  keyboardPanes?: readonly [string, string];
  pointInstructions?: string;
  inlineActions?: ReactNode;
  onSelectionChange?: (position: number | null) => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const pathname = usePathname();
  // Callers build a new readout each render; the chart's options only depend on whether there is one.
  const hasReadout = Boolean(readout);
  const touchLayout = useBreakpoint("touchLayout");
  const description = useId();
  const [reading, setReading] = useState<{index: number; text: string} | null>(null);
  const [pinned, setPinned] = useState(false);
  const [picked, setPicked] = useState<number | null>(initialSelection);
  const [gapSpan, setGapSpan] = useState<readonly [number, number] | null>(null);
  const [announced, setAnnounced] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const menuContainer = useRef<HTMLDivElement>(null);
  const pendingAnnouncement = useRef<string | null>(null);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const closeTrigger = useRef<HTMLButtonElement>(null);
  const [chartPortal, setChartPortal] = useState<HTMLDivElement | null>(null);
  const closeFullscreen = () => setExpanded(false);
  const host = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const actionsPopup = useRef<HTMLDivElement>(null);
  const marksLayer = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const plotBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!expanded) return;
    // The chart keeps its canvas in an inline portal. Make sibling content inert
    // so even scripted focus cannot escape the active fullscreen surface.
    const locked: HTMLElement[] = [];
    for (let node: HTMLElement | null = chartPortal; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert || sibling.matches("script, style, link")) continue;
        sibling.setAttribute("inert", "");
        locked.push(sibling);
      }
    }
    return () => { for (const element of locked) element.removeAttribute("inert"); };
  }, [chartPortal, expanded]);
  // Pointer position inside a missing interval, where the cursor follows the pointer.
  const pointerX = useRef<number | null>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // Escape hides a hover reading until the pointer leaves the plot.
  const suppressed = useRef(false);
  const touchStart = useRef<{ x: number; y: number; scrub: boolean } | null>(null);
  // Where the finger last touched, so a docked strip can keep clear of the point being read.
  const brush = useRef<{position:number; x:number} | null>(null);
  const keyboardAnchor = useRef<number | null>(null);
  const [brushPixels, setBrushPixels] = useState<[number,number] | null>(null);
  const touchY = useRef<number | null>(null);
  // The pane under the pointer or touch, or explicitly selected with the keyboard.
  const [pane, setPane] = useState<number | undefined>(undefined);
  const keyboardPane = useRef(0);
  const colours = useChartColours();
  const settings = useMemo<EChartsOption>(() => {
    const custom = option(colours);
    const customTooltip = custom.tooltip && !Array.isArray(custom.tooltip) ? custom.tooltip : undefined;
    return {
      grid: { top: 20, right: 18, bottom: 30, left: 58 },
      ...custom,
      dataZoom: custom.dataZoom ?? (fullscreen ? [{
        type: "inside", disabled: true, xAxisIndex: Array.isArray(custom.xAxis) ? custom.xAxis.map((_, i) => i) : 0,
        filterMode: "none",
      }] : undefined),
      ...(hasReadout ? { axisPointer: undefined } : {}),
      xAxis: hasReadout
        ? Array.isArray(custom.xAxis) ? custom.xAxis.map((axis) => ({ ...axis, axisPointer: { show: false } }))
          : custom.xAxis ? { ...custom.xAxis, axisPointer: { show: false } } : undefined
        : custom.xAxis,
      tooltip: hasReadout
        ? { ...customTooltip, show: false, triggerOn: "none" }
        : {
            // Research charts read in the reader's units; portfolio charts keep theirs.
            valueFormatter: (value) => chartNumber(value, research ? locale : "en"),
            ...customTooltip,
          },
    };
  }, [colours, option, research, locale, hasReadout, fullscreen]);
  const internal = useRef<ECharts | null>(null);
  const selected = useRef(0);
  const control = controller ?? internal;
  const { ref: setCanvas, canvasEl, canvasRef: ref, status, retry, applied } = useECharts(
    settings,
    research ? "research" : "core",
    control,
    (instance) => {
      setPicked(null);
      setGapSpan(null);
      onSelectionChange?.(null);
      setPinned(false);
      onZoom?.(instance);
    },
    onPointClick,
    pinned || picked != null || gapSpan != null || Boolean(reading),
    updateWhileReading,
    onPointHover,
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
  }, [control, ref, expanded, customGestures, canvasEl]);
  const active = picked != null && readout?.positions[closestChartPosition(readout.positions, picked)] === picked
    ? picked : null;
  const gap = active == null ? gapSpan : null;
  const current = readout && active != null ? readout.read(active, { grid: pane }) : null;
  const gapReading: Reading | null = readout && gap ? {
    time: [t("无记录", "No data"), [readout.read(gap[0])?.time, readout.read(gap[1])?.time].filter(Boolean).join("–")]
      .filter(Boolean).join(" · "),
  } : null;
  const shown = current ?? gapReading;
  const latestReading = readout && readout.positions.length ? readout.read(readout.positions.at(-1)!) : null;
  const latestText = latestReading ? readingText(latestReading, locale) : "";
  const currentText = current ? readingText(current, locale) : latestText;
  const marks = readout?.marks && active != null ? readout.marks(active) : [];
  const drawCursor = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    drawCursor.current = () => {
      const el = cursor.current;
      const bounds = ref.current;
      if (!el || !bounds) return;
      const instance = control.current;
      const pixel = active != null ? instance?.convertToPixel({ xAxisIndex: 0 }, active) : gap != null ? pointerX.current : null;
      const x = typeof pixel === "number" ? pixel : NaN;
      const width = bounds.clientWidth;
      const height = bounds.clientHeight;
      const card = popup.current;
      const cardWidth = card?.childElementCount ? card.offsetWidth : 0;
      const shownAt = typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= width;
      el.style.visibility = shownAt ? "visible" : "hidden";
      if (shownAt) el.style.transform = `translateX(${x}px)`;
      const dots = marksLayer.current ? Array.from(marksLayer.current.children) as HTMLElement[] : [];
      dots.forEach((dot, index) => {
        const mark = marks[index];
        const point = shownAt && mark && active != null
          ? instance?.convertToPixel({ xAxisIndex: mark.xAxisIndex ?? 0, yAxisIndex: mark.yAxisIndex ?? 0 }, [active, mark.value])
          : undefined;
        const placed = Array.isArray(point) && point.every(Number.isFinite) && point[1] >= 0 && point[1] <= height;
        dot.style.visibility = placed ? "visible" : "hidden";
        if (placed) dot.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
      });
      if (!card) return;
      if (!shownAt || !cardWidth) {
        card.style.visibility = "hidden";
        return;
      }
      // The card's top sits 8px into the plot; it follows the cursor sideways,
      // flips left near the right edge and always stays inside the plot.
      const w = cardWidth, spacing = 12;
      let left = x + spacing;
      if (left + w > width - 4) left = x - spacing - w;
      left = Math.max(4, Math.min(left, width - w - 4));
      card.style.transform = `translate(${Math.round(left)}px, 8px)`;
      card.style.visibility = "visible";
    };
    drawCursor.current();
  });
  useLayoutEffect(() => {
    const bounds = ref.current;
    if (!bounds) return;
    const observer = new ResizeObserver(() => drawCursor.current());
    observer.observe(bounds);
    return () => observer.disconnect();
  }, [ref, canvasEl]);

  const pickAt = (event: PointerEvent<HTMLDivElement>): Hit | null => {
    if (!readout) return null;
    const instance = control.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const axes = Array.isArray(settings.xAxis) ? settings.xAxis.length : 1;
    const grid = instance ? (readout.gridIndexes ?? Array.from({ length: axes }, (_, i) => i)).find((gridIndex) =>
      instance.containPixel({ gridIndex }, [x, y])) : undefined;
    if (!instance || grid == null) return null;
    const target = instance.convertFromPixel({ xAxisIndex: 0 }, x);
    if (typeof target !== "number" || !Number.isFinite(target)) return null;
    const positions = readout.positions;
    if (readout.gap?.(target)) {
      const next = after(positions, target);
      return next > 0 && next < positions.length ? { gap: [positions[next - 1], positions[next]], x, grid } : null;
    }
    const position = positions[closestChartPosition(positions, target)];
    return position == null ? null : { position, x, grid };
  };
  const choose = (point: number | null, remember = false) => {
    setPicked(point);
    setGapSpan(null);
    if (remember) onSelectionChange?.(point);
  };
  const chooseGap = (span: readonly [number, number], x: number) => {
    pointerX.current = x;
    setPicked(null);
    setGapSpan((previous) => previous?.[0] === span[0] && previous[1] === span[1] ? previous : span);
    drawCursor.current();
  };
  // Hover never speaks; keyboard and touch selections update the live region.
  const announce = (position: number | null, grid?: number, repeat = false) => {
    const value = position == null ? null : readout?.read(position, { grid });
    if (!value) return;
    const paneName = grid != null ? keyboardPanes?.[grid] : null;
    const text = [paneName, readingText(value, locale)].filter(Boolean).join("\n");
    pendingAnnouncement.current = repeat ? text : null;
    if (!repeat) setAnnounced(text);
  };
  const finishAnnouncement = () => {
    if (pendingAnnouncement.current) setAnnounced(pendingAnnouncement.current);
    pendingAnnouncement.current = null;
  };
  const dismiss = () => {
    choose(null, true);
    pointerX.current = null;
    control.current?.setOption({ tooltip: { alwaysShowContent: false } });
    control.current?.dispatchAction({ type: "hideTip" });
    setPinned(false);
    setReading(null);
    pendingAnnouncement.current = null;
    keyboardPane.current = 0;
    setAnnounced(null);
  };
  const dismissRef = useRef(dismiss);
  useLayoutEffect(() => { dismissRef.current = dismiss; });
  const open = active != null || gap != null || pinned || Boolean(reading);
  // Escape closes any reading, however it opened; a pinned reading also closes from outside the chart.
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return;
      const layer = (event.target as Element | null)?.closest?.('[role="menu"], [role="alertdialog"], [role="dialog"]');
      if (layer && !layer.contains(host.current)) return;
      event.preventDefault();
      if (!pinned) suppressed.current = true;
      dismissRef.current();
    };
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (pinned && !host.current?.contains(target) && !actionsPopup.current?.contains(target)) dismissRef.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, pinned]);
  const route = useRef(pathname);
  useEffect(() => {
    if (route.current === pathname) return;
    route.current = pathname;
    dismissRef.current();
  }, [pathname]);
  // A caller's pinned tap reading uses the same strip and docking as a readout's touch reading.
  const stripReading = pin?.reading ?? (readout && touchLayout ? shown : null);
  const stripShown = Boolean(stripReading);
  // The strip sits above the plot and the chart's own controls, so fullscreen and More stay
  // reachable. When that space has scrolled under the top bar, it docks below the bar instead
  // of disappearing. In the fullscreen dialog, whose controls sit above the plot, it reads below.
  // Placement reads the latest reading on every render, like the cursor; listeners attach once.
  const placeStrip = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    placeStrip.current = () => {
      const element = strip.current;
      const box = plotBox.current?.getBoundingClientRect();
      if (!stripShown || !element || !box) return;
      if (expanded) {
        element.removeAttribute("data-docked");
        element.removeAttribute("data-docked-inside");
        return;
      }
      const actions = host.current?.querySelector<HTMLElement>(":scope > .mx-chart-actions");
      const lift = actions?.offsetHeight ? Math.max(0, box.top - actions.getBoundingClientRect().top) : 0;
      // Inside a dialog (the research full chart), dock below the dialog's header, not the page's top bar.
      const dialog = element.closest<HTMLElement>("[role=dialog]");
      const header = dialog?.querySelector<HTMLElement>('[data-slot="dialog-header"]');
      const bar = dialog
        ? header ? header.getBoundingClientRect().bottom : dialog.getBoundingClientRect().top
        : document.querySelector(".mx-topbar")?.getBoundingClientRect().bottom ?? 0;
      const stripHeight = element.offsetHeight;
      const docked = box.top - lift - stripHeight - 4 < bar && box.bottom > bar + stripHeight;
      // Docked strips sit under the top bar, or above the phone's tab bar when the dot being read,
      // the one nearest the finger, is up there.
      const dock = document.querySelector(".mx-mobile-dock")?.getBoundingClientRect();
      const floor = dock?.height ? dock.top : window.innerHeight;
      const finger = touchY.current;
      const instance = control.current;
      const canvas = ref.current?.getBoundingClientRect();
      const dots = finger == null || active == null || !instance || !canvas ? [] : marks.flatMap((mark) => {
        const point = instance.convertToPixel({ xAxisIndex: mark.xAxisIndex ?? 0, yAxisIndex: mark.yAxisIndex ?? 0 }, [active, mark.value]);
        return Array.isArray(point) && Number.isFinite(point[1]) ? [canvas.top + point[1]] : [];
      });
      const focus = finger == null ? null : dots.reduce((best, y) => Math.abs(y - finger) < Math.abs(best - finger) ? y : best, dots[0] ?? finger);
      const low = focus != null && focus < bar + stripHeight + 24;
      element.toggleAttribute("data-docked", docked && !dialog);
      element.toggleAttribute("data-docked-inside", docked && !!dialog);
      element.style.setProperty("--mx-strip-lift", `${Math.round(lift)}px`);
      element.style.setProperty("--mx-strip-offset", `${Math.round(bar + 4 - box.top)}px`);
      element.style.setProperty("--mx-strip-top", `${Math.round(low ? floor - stripHeight - 4 : bar + 4)}px`);
      element.style.setProperty("--mx-strip-left", `${Math.round(box.left)}px`);
      element.style.setProperty("--mx-strip-width", `${Math.round(box.width)}px`);
    };
    placeStrip.current();
  });
  useLayoutEffect(() => {
    const element = strip.current;
    if (!stripShown || !element) return;
    let scheduled = 0;
    const place = () => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        placeStrip.current();
      });
    };
    const resized = new ResizeObserver(place);
    resized.observe(element);
    // Capture scrolls of any container, such as a dialog's body, not only the page.
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(scheduled);
      resized.disconnect();
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [stripShown, canvasEl]);
  // A horizontal touch drag reads continuously; vertical movement stays with the page.
  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    const start = touchStart.current;
    if (!start) {
      gestures.move(event);
      return;
    }
    if (!start.scrub) {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      // A zoomable chart pans with a horizontal drag until a reading is open.
      if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy) || ((expanded || customGestures) && !pinned)) {
        gestures.move(event);
        return;
      }
      start.scrub = true;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    }
    touchY.current = event.clientY;
    const hit = pickAt(event);
    if (!hit) return;
    setPane(hit.grid);
    if ("gap" in hit) chooseGap(hit.gap, hit.x);
    else choose(hit.position, true);
    setPinned(true);
  };
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
  const action = async (work: () => void | Promise<void>, success = "", failure = t("未能完成操作", "Action unavailable")) => {
    try {
      await work();
      setExportStatus(success);
    } catch {
      setExportStatus(failure);
    }
  };
  const hasTools = fullscreen || !!readout?.records;
  const menu = readout?.records && <DropdownMenu modal={false}>
    <DropdownMenuTrigger aria-label={t("更多图表操作", "More chart actions")} render={expanded
      ? <Toolbar.Button render={<Button variant="ghost" />} />
      : <Button variant="ghost" />}>{t("更多", "More")}</DropdownMenuTrigger>
    <DropdownMenuContent ref={actionsPopup} portalContainer={expanded ? menuContainer : undefined} align="end">
      <DropdownMenuItem onClick={() => void action(async () => {
        const plain = currentText.replaceAll("\n", " · ");
        if (typeof ClipboardItem === "function" && ClipboardItem.supports?.("text/tab-separated-values")) {
          try {
            await navigator.clipboard.write([new ClipboardItem({
              "text/plain": new Blob([plain], { type: "text/plain" }),
              "text/tab-separated-values": new Blob([currentText.replaceAll("\n", "\t")], { type: "text/tab-separated-values" }),
            })]);
            return;
          } catch {
            // Some hosts reject the extra MIME type but allow plain-text writes.
          }
        }
        await navigator.clipboard.writeText(plain);
      }, t("已复制", "Copied"), t("未能复制读数，请重试", "Couldn’t copy the reading. Try again."))}>{t("复制读数", "Copy reading")}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => void action(() => exportChartCsv(visibleRecords()))}>{t("导出 CSV", "Export CSV")}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => void action(async () => {
        if (control.current) {
          await exportChartPng(control.current, label, currentText, colours.canvas, colours.text, colours.axis);
        }
      })}>{t("导出 PNG", "Export PNG")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
  const feedback = <span className={exportStatus ? "mx-chart-status text-xs text-muted-foreground" : "mx-chart-status sr-only"} role="status">{exportStatus}</span>;
  const content = (
    <div ref={host} className={hasTools ? "mx-chart-host min-w-0" : undefined} data-expanded={expanded || undefined}>
    {hasTools && <div className="mx-chart-actions flex flex-wrap items-center justify-end gap-1 text-sm">
      {expanded && <strong className="me-auto min-w-0 break-words max-md:basis-full">{label}</strong>}
      {expanded ? <ChartToolbar aria-label={t("图表操作", "Chart actions")} className="flex min-w-0 flex-wrap items-center justify-end gap-1">
        <Toolbar.Group aria-label={t("图表缩放", "Chart zoom")} className="flex flex-wrap gap-1">
          <Toolbar.Button render={<Button size="icon" variant="ghost" />} aria-label={t("放大", "Zoom in")} onClick={() => zoomBy(0.65)}><Plus size={18} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Button render={<Button size="icon" variant="ghost" />} aria-label={t("缩小", "Zoom out")} onClick={() => zoomBy(1.55)}><Minus size={18} aria-hidden="true" /></Toolbar.Button>
          <Toolbar.Button render={<Button variant="ghost" />} onClick={() => changeZoom(control.current, { start: 0, end: 100 })}>{t("恢复范围", "Reset zoom")}</Toolbar.Button>
        </Toolbar.Group>
        <Toolbar.Separator className="mx-1 h-4 w-px shrink-0 bg-border" />
        {feedback}
        {menu}
      </ChartToolbar> : <>{inlineActions}{feedback}{menu}</>}
      {fullscreen && (expanded
        ? <Button data-autofocus variant="ghost" size="icon" ref={closeTrigger} aria-label={t("退出全屏", "Exit fullscreen")} onClick={closeFullscreen}><Minimize2 aria-hidden="true" size={18} /></Button>
        : <Button variant="ghost" size="icon" ref={fullscreenTrigger} aria-label={t("全屏", "Fullscreen")} onClick={() => setExpanded(true)}><Maximize2 aria-hidden="true" size={18} /></Button>)}
    </div>}
    {expanded && <div ref={menuContainer} />}
    {/* The reading is spoken here; it shows as a card beside the cursor, or a strip above the plot on phones. */}
    {readout && <div className="sr-only">
      <div className="mx-chart-readout-latest"><strong>{readout.latest}</strong>
        {(readout.observationCount ?? readout.positions.length) < 3 && <span data-chart-sparse="true">
          {t("仅", "Only")} {readout.observationCount ?? readout.positions.length}{" "}
          {(readout.observationCount ?? readout.positions.length) === 1 ? t("个观测", "observation") : t("个观测", "observations")}
        </span>}
      </div>
      <div className="mx-chart-readout-values" data-chart-reading={active == null ? "latest" : "selected"}>
        {(announced ?? latestText).split("\n").filter(Boolean).map((line, i) => <span key={i}>{line}</span>)}
      </div>
      <span role="status" className="sr-only">{announced}</span>
    </div>}
    <div className="mx-plot-frame relative min-w-0" ref={plotBox}>
    {stripShown && stripReading && <div className="mx-chart-strip" data-below={expanded || undefined} ref={strip}>
      <div aria-hidden="true"><ReadingCard reading={stripReading} variant="strip" /></div>
      <CloseButton iconSize={18} className="absolute top-1/2 right-1 size-11 -translate-y-1/2" aria-label={t("关闭读数", "Close reading")} onClick={pin ? pin.onClose : dismiss} />
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
          if (brush.current && event.buttons === 1) {
            const hit = pickAt(event);
            if (hit && "position" in hit) setBrushPixels([brush.current.x, hit.x]);
            return;
          }
          if (readout && event.pointerType === "touch") {
            scrub(event);
            return;
          }
          if (gestures.move(event) || !readout || pinned || event.buttons || suppressed.current) return;
          const hit = pickAt(event);
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => {
            if (!hit) choose(null);
            else {
              setPane(hit.grid);
              if ("gap" in hit) chooseGap(hit.gap, hit.x);
              else if (hit.position !== active) choose(hit.position);
            }
          });
        }}
        onPointerLeave={() => {
          cancelAnimationFrame(frame.current);
          suppressed.current = false;
          if (readout && !pinned) choose(null);
        }}
        onPointerCancel={(event) => { brush.current = null; setBrushPixels(null); gestures.end(event); touchStart.current = null; }}
        onPointerDown={(event) => {
          if (onBrush && !touchLayout && event.button === 0 && (!expanded || event.shiftKey)) {
            const hit = pickAt(event);
            if (hit && "position" in hit) {
              brush.current = {position:hit.position,x:hit.x};
              setBrushPixels(null);
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          }
          if (!brush.current) gestures.down(event);
          touchY.current = event.pointerType === "touch" ? event.clientY : null;
          if (event.pointerType === "touch" || readout)
            touchStart.current = { x: event.clientX, y: event.clientY, scrub: false };
        }}
        onPointerUp={(event) => {
          const anchor = brush.current;
          brush.current = null;
          const hit = anchor && pickAt(event);
          if (anchor && hit && "position" in hit && anchor.position !== hit.position && Math.abs(hit.x-anchor.x)>4) {
            touchStart.current = null;
            onBrush?.(Math.min(anchor.position,hit.position),Math.max(anchor.position,hit.position));
            setBrushPixels([anchor.x,hit.x]);
            return;
          }
          setBrushPixels(null);
          const start = touchStart.current;
          touchStart.current = null;
          if (start?.scrub) {
            gestures.end(event);
            announce(active, pane);
            return;
          }
          if (gestures.end(event)) return;
          if (
            (event.pointerType !== "touch" && !readout) ||
            !start ||
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
          )
            return;
          if (readout) {
            const hit = pickAt(event);
            if (hit) setPane(hit.grid);
            if (!hit || ("position" in hit && hit.position === active && pinned)) dismiss();
            else if ("gap" in hit) {
              chooseGap(hit.gap, hit.x);
              setPinned(true);
            } else {
              choose(hit.position, true);
              setPinned(true);
              if (event.pointerType === "touch") announce(hit.position, hit.grid);
            }
            return;
          }
          if (pinned) {
            dismiss();
            return;
          }
          // A chart without a tooltip (labelled bars) has nothing to pin.
          if (!Array.isArray(settings.tooltip) && settings.tooltip?.show === false) return;
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
          finishAnnouncement();
          const next = event.relatedTarget;
          if (!pinned && (reading || active != null) &&
            !(next && event.currentTarget.closest(".mx-chart-host")?.contains(next))) dismiss();
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return;
          if (event.key === "Escape") {
            brush.current = null; keyboardAnchor.current=null; setBrushPixels(null);
            if (pinned || reading || active != null || gap != null) {
              event.preventDefault();
              event.stopPropagation();
            }
            dismiss();
            return;
          }
          if (readout) {
            const values = readout.positions;
            if (keyboardPanes && values.length && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              const grid = event.key === "ArrowUp" ? 0 : 1;
              keyboardPane.current = grid;
              setPane(grid);
              const position = active ?? values.at(-1)!;
              choose(position, true);
              announce(position, grid, event.repeat);
              return;
            }
            const grid = keyboardPanes ? keyboardPane.current : undefined;
            if (event.key === " " || event.key === "Enter") {
              setPane(grid);
              event.preventDefault();
              if (pinned) dismiss();
              else if (values.length) {
                const position = active ?? values.at(-1)!;
                choose(position, true);
                setPinned(true);
                announce(position, grid);
              }
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !values.length) return;
            event.preventDefault();
            const index = active == null ? values.length - 1 : closestChartPosition(values, active);
            const next = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1
              : Math.max(0, Math.min(values.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
            setPane(grid);
            if (onBrush && event.shiftKey) keyboardAnchor.current ??= values[index];
            choose(values[next], true);
            announce(values[next], grid, event.repeat);
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
          setReading({
            index: selected.current,
            text: readPoint?.(selected.current) ?? chartReading(option, selected.current, locale, t),
          });
        }}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) finishAnnouncement();
          if (event.key === "Shift" && keyboardAnchor.current != null) {
            const anchor=keyboardAnchor.current;
            keyboardAnchor.current=null;
            if (active!=null && active!==anchor) onBrush?.(Math.min(anchor,active),Math.max(anchor,active));
          }
        }}
        ref={setCanvas}
        style={{ height: "100%", width: "100%", touchAction: readout || expanded || customGestures ? "pan-y" : undefined }}
      />
      {onBrush && brushPixels && <div aria-hidden="true" className="mx-chart-brush" style={{left:Math.min(...brushPixels),width:Math.abs(brushPixels[1]-brushPixels[0])}}/>}
      {readout && <div className="mx-chart-cursor" ref={cursor} aria-hidden="true" />}
      {readout?.marks && <div className="mx-chart-marks" ref={marksLayer} aria-hidden="true">
        {marks.map((mark, index) => <span key={index} className="mx-chart-mark" style={{ "--mark": mark.colour } as CSSProperties} />)}
      </div>}
      {readout && !touchLayout && <div className="mx-chart-popup" ref={popup} aria-hidden="true">
        {shown && <ReadingCard reading={shown} />}
      </div>}
      {status !== "ready" && <div className="mx-plot-loading">
        {status === "loading" ? <Pending shape="chart" label={t("正在绘制图表…", "Preparing chart…")} />
          : <button className="mx-inline-retry" type="button" onClick={retry}>{t("重试绘图", "Retry chart")}</button>}
      </div>}
      <span id={description} className="sr-only">
        {keyboardPanes && t("上下方向键切换收益与回撤。", "Use the up and down arrows to switch between returns and drawdown.")}{" "}
        {onBrush && t("拖动选择归因区间，或按住 Shift 并用方向键选择。","Drag to select an attribution range, or hold Shift and use the arrow keys.")}
        {pointInstructions ?? t(
          "左右方向键查看相邻读数，Home 和 End 到首尾，Escape 关闭。触控轻点或横向拖动查看读数，再次轻点关闭。",
          "Use arrow keys for adjacent readings, Home and End for the first and last point, and Escape to dismiss. Tap or drag sideways to read, then tap again to dismiss.",
        )}
      </span>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reading && (updateWhileReading
          ? readPoint?.(reading.index) ?? chartReading(settings, reading.index, locale, t)
          : reading.text)}
      </span>
      {pinned && !readout && (
        <CloseButton iconSize={18} className="absolute top-1 right-1 z-[5] border-panel-edge bg-popover shadow-(--shadow-popover)" aria-label={t("关闭读数", "Close reading")} onClick={dismiss} />
      )}
    </div>
    </div>
    </div>
  );
  if (!fullscreen) return content;
  // Keep inline controls outside closed-dialog focus management; the chart preserves live zoom across remounts.
  return <div ref={setChartPortal}>
    {!expanded && content}
    <Dialog open={expanded} disablePointerDismissal onOpenChange={(next, details) => {
      if (next) return;
      const event = details.event;
      if (event instanceof KeyboardEvent && (event.defaultPrevented || isImeComposing(event))) details.cancel();
      else closeFullscreen();
    }}>
      <DialogPortal container={chartPortal}>
        <DialogOverlay />
        <DialogSurface className="tm-chart-dialog tm-overlay-surface" aria-modal="true" aria-label={label}
          initialFocus={closeTrigger} finalFocus={fullscreenTrigger}>
          {expanded ? content : null}
        </DialogSurface>
      </DialogPortal>
    </Dialog>
  </div>;
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

