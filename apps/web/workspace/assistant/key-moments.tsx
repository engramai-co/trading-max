"use client";
import "./research.css";

import { useQueryClient } from "@tanstack/react-query";
import type { ECharts } from "echarts";
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MomentWindow, Moments, NumberedMoment } from "./moment-controls";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { useCopy } from "../foundation";
import { isImeComposing } from "../shortcut-platform";
import { AnchoredReading, ReadingLines } from "./cards";
import { usePageRole } from "./context";
import { useRoleReading } from "./reading";
import { placeMarkers } from "./marker-layout";
import { useResearchOrigin } from "./research";

type Point = { date: string; category: string; high: number };
type Mark = NumberedMoment & { x: number; y: number; high: number };

/** ECharts supplies the coordinates after layout, including log scales, zoom and pane resizing. */
export function MomentOverlay({ moments, chart, points, name }: {
  moments: Moments; chart: RefObject<ECharts | null>; points: Point[]; name?: string;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const [marks, setMarks] = useState<Mark[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    let frame = 0;
    let instance: ECharts | null = null;
    function measure() {
      if (!el || !chart.current || chart.current.isDisposed()) return;
      if (instance !== chart.current) {
        instance = chart.current;
        instance.on("rendered", schedule);
      }
      const anchors = moments.items.flatMap(m => {
        const point = points.find(p => p.date === m.date);
        if (!point) return [];
        const pixel = instance!.convertToPixel({ gridIndex: 0 }, [point.category, point.high]);
        if (!pixel || !pixel.every(Number.isFinite) || !instance!.containPixel({ gridIndex: 0 }, pixel)) return [];
        return [{ ...m, x: Math.round(pixel[0]), high: Math.round(pixel[1]) }];
      });
      const next = placeMarkers(anchors, el.clientHeight);
      setMarks(old => old.length === next.length && old.every((a, i) => a.date === next[i].date && a.number === next[i].number && a.x === next[i].x && a.y === next[i].y && a.high === next[i].high) ? old : next);
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); }
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    // The lazy chart runtime may finish after the candidates.
    const ready = new MutationObserver(schedule);
    if (el.parentElement) ready.observe(el.parentElement, { attributes: true, subtree: true, attributeFilter: ["data-tm-chart-ready"] });
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); ready.disconnect(); if (instance && !instance.isDisposed()) instance.off("rendered", schedule); };
  }, [chart, points, moments.items]);
  const active = marks.find(m => m.date === moments.current?.date);
  return <div className="mx-key-layer" ref={layer}>{marks.map(m => <Fragment key={m.date}><span aria-hidden="true" className="mx-key-stem" style={{left:m.x, top:Math.min(m.y,m.high), height:Math.abs(m.high-m.y)}}/><button type="button"
    className="mx-key-marker" style={{ left: m.x, top: m.y }} aria-expanded={moments.current?.date === m.date}
    aria-label={t("关键时刻", "Key moment") + " " + m.number + " · " + formatCalendarDate(m.date, locale)}
    onClick={e => moments.open(m.date, e.currentTarget)}>{m.number}</button></Fragment>)}
    {moments.current && moments.window && moments.snapshotId && <div className="mx-key-anchor"
      style={{ left: `clamp(4px, ${(active?.x ?? 180) - 180}px, max(4px, 100% - 364px))`, top: (active?.y ?? 0) + 14 }}>
      <MomentReading key={moments.key + moments.current.date} window={moments.window} date={moments.current.date}
        snapshotId={moments.snapshotId} name={name} close={moments.close} />
    </div>}
  </div>;
}

function MomentReading({ window, date, snapshotId, name, close }: {
  window: MomentWindow; date: string; snapshotId: string; name?: string; close: () => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const client = useQueryClient();
  const [stopped, setStopped] = useState(false);
  const context = useMemo(() => ({...window, date}), [window, date]);
  const request = {role: "key-moment", context, snapshotId};
  const result = useRoleReading(request, !stopped);
  const origin = useResearchOrigin(window.ticker, window.index_id ? "price" : "technical", snapshotId);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => { wrapper.current?.querySelector<HTMLButtonElement>(".mx-reading-close")?.focus({preventScroll: true}); }, []);
  const card = useMemo(() => ({
    role: "key-moment", title: t("关键时刻", "Key moments"), object: [name || window.ticker, formatCalendarDate(date, locale)].join(" · "),
    context, origin, reading: result.data,
    questions: [t("当天有哪些已核实的事件？", "Which events were verified that day?"), t("成交量如何变化？", "How did volume change?"),
      t("之后的价格如何变化？", "What did the price do afterwards?")],
  }), [context, date, locale, name, origin, result.data, t, window.ticker]);
  usePageRole(card);
  return <div ref={wrapper} onKeyDown={e => { if (e.key === "Escape" && !isImeComposing(e)) { e.stopPropagation(); close(); } }}>
    <AnchoredReading card={card} onClose={close}>{result.data ? <ReadingLines card={card} /> :
      <div className="mx-brief-empty" role="status">{result.isFetching ? <>
        {t("正在读取当日行情与事件…", "Reading the day’s price and events…")}
        <button onClick={() => { setStopped(true); void client.cancelQueries({ queryKey: ["assistant-reading", request] }); }}>{t("停止", "Stop")}</button>
      </> : stopped ? t("已停止。", "Stopped.") : t("暂无可核实的解读。", "No verified reading is available.")}</div>}
    </AnchoredReading></div>;
}
