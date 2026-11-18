"use client";

import { VisuallyHidden } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { CenteredCopy } from "@/ui/centered-copy";
import { useAllocationChartColours, useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import { currency, percent } from "@/workspace/data";
import { Empty, useCopy } from "./foundation";

export type AllocationSlice = {
  name: string;
  value: number | null;
  weight: number | null;
  fullName?: string;
  category?: string;
  entityId?: string;
  group?: "tail" | "unresolved";
  directValue?: number;
  indirectValue?: number;
};

export function AllocationComposition({ rows, companies = false, remainder, initialGroup, onInspect, reading }: {
  rows: AllocationSlice[];
  companies?: boolean;
  initialGroup?: AllocationSlice["group"];
  onInspect?: (row: AllocationSlice) => void;
  reading?: ReactNode;
  remainder?: { value: number; weight: number };
}) {
  const t = useCopy();
  const colours = useChartColours();
  const palette = useAllocationChartColours();
  const reduced = useReducedMotion();
  const description = useId();
  const detailId = useId();
  // The slice or row under the pointer or keyboard focus; the centre shows it until the pointer leaves.
  const [preview, setPreview] = useState<number | null>(null);
  const chart = useRef<ECharts | null>(null);
  const bound = useRef<WeakSet<ECharts>>(new WeakSet());
  const slices = useMemo(() => {
    const visible = rows.slice(0, 12);
    const rest = rows.slice(12);
    const grouped = rest.length ? [...visible, {
      name: companies ? t("其余公司", "Other companies") : t("其余分类", "Other categories"),
      category: "tail", group: "tail" as const,
      value: rest.every((row) => row.value !== null)
        ? rest.reduce((sum, row) => sum + row.value!, 0) : null,
      weight: rest.every((row) => row.weight !== null)
        ? rest.reduce((sum, row) => sum + row.weight!, 0) : null,
      ...(companies ? {
        directValue: rest.reduce((sum, row) => sum + (row.directValue ?? 0), 0),
        indirectValue: rest.reduce((sum, row) => sum + (row.indirectValue ?? 0), 0),
      } : {}),
    }] : visible;
    return remainder ? [...grouped, {
      name: t("未穿透与其他资产", "Unresolved & other assets"),
      category: "unresolved", group: "unresolved" as const,
      ...remainder,
    }] : grouped;
  }, [rows, t, companies, remainder]);
  const [selected, setSelected] = useState(() => initialGroup ? Math.max(0,slices.findIndex(s => s.group === initialGroup)) : 0);
  const colour = (index: number) => remainder && index === slices.length - 1
    ? colours.axis : palette[index];
  const activeIndex = Math.min(selected, Math.max(0, slices.length - 1));
  const active = slices[activeIndex];
  function select(index: number) {
    setSelected(index);
    onInspect?.(slices[index]);
  }
  const shown = slices[preview ?? activeIndex] ?? active;
  const option = useMemo<EChartsOption>(() => ({
    backgroundColor: "transparent",
    animation: !reduced,
    animationDuration: 250,
    animationDurationUpdate: 0,
    // The centre answers for the slice under the pointer, so the ring has no tooltip.
    tooltip: { show: false },
    series: [{
      type: "pie", radius: ["58%", "80%"], center: ["50%", "50%"],
      label: { show: false }, labelLine: { show: false },
      stillShowZeroSum: false,
      padAngle: 0.8,
      emphasis: { scale: false, focus: "self" },
      blur: { itemStyle: { opacity: 0.35 } },
      data: slices.map((row, index) => ({
        name: row.name, value: Math.max(0, row.weight ?? 0),
        itemStyle: {
          color: remainder && index === slices.length - 1 ? colours.axis : palette[index],
          opacity: index === activeIndex ? 1 : 0.6,
          borderWidth: 0,
          borderRadius: 2,
        },
      })),
    }],
  }), [activeIndex, colours, palette, reduced, slices, remainder]);
  const { ref: canvas } = useECharts(option, "core", chart, undefined, (event) => {
    if (event.componentType === "series" && event.seriesType === "pie")
      select(event.dataIndex);
  });
  // Bound on first approach, so a chart rebuilt after a resize or theme change is bound too.
  const bind = () => {
    const instance = chart.current;
    if (!instance || bound.current.has(instance)) return;
    bound.current.add(instance);
    instance.on("mouseover", (event) => {
      if (event.componentType === "series" && event.seriesType === "pie") setPreview(event.dataIndex);
    });
    instance.on("mouseout", () => setPreview(null));
    instance.on("globalout", () => setPreview(null));
  };
  // A row under the pointer or keyboard focus lights its slice and softens the rest.
  const highlight = (index: number | null) => {
    setPreview(index);
    chart.current?.dispatchAction({ type: "downplay", seriesIndex: 0 });
    if (index != null) chart.current?.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex: index });
  };

  if (!active || !slices.some((row) => (row.weight ?? 0) > 0))
    return <Empty title={t("暂无配置数据", "No allocation data")} />;

  return (
    <div className="mx-allocation-composition">
      <div className="mx-allocation-visual">
        <div
          ref={canvas}
          className="mx-allocation-canvas"
          role="group"
          aria-label={t("配置组成", "Allocation composition")}
          aria-roledescription={t("交互环形图", "Interactive doughnut chart")}
          aria-describedby={description}
          aria-controls={detailId}
          tabIndex={0}
          onPointerEnter={bind}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            select(event.key === "Home" ? 0 : event.key === "End" ? slices.length - 1
              : (activeIndex + (event.key === "ArrowRight" ? 1 : -1) + slices.length) % slices.length);
          }}
        />
        <div className="mx-allocation-center" aria-hidden="true">
          <span>{shown.name}</span>
          <strong>{percent(shown.weight)}</strong>
          <small>{currency(shown.value, "GBP", 0)}</small>
        </div>
        {companies ? <VisuallyHidden id={description}>
          {t("点击扇区或公司查看详情，也可用左右方向键切换。", "Select a slice or company for details. Arrow keys also switch companies.")}
        </VisuallyHidden> : <p id={description} className="mx-form-help">
          <CenteredCopy>{t("点击扇区或分类查看详情，也可用左右方向键切换。", "Select a slice or category for details. Arrow keys also switch categories.")}</CenteredCopy>
        </p>}
      </div>
      <div className="mx-allocation-details">
        <section id={detailId} aria-label={t("所选分类详情", "Selected category details")} aria-live="polite" aria-atomic="true">
          <p className="mx-form-help">{t("所选分类", "Selected category")}</p>
          <h3>{active.fullName || active.name}</h3>
          <dl className="mx-allocation-facts">
            <div><dt>{t("金额 · GBP", "Value · GBP")}</dt><dd>{currency(active.value, "GBP", 2)}</dd></div>
            <div><dt>{t("配置占比", "Allocation weight")}</dt><dd>{percent(active.weight)}</dd></div>
            {companies && active.directValue !== undefined && <div><dt>{t("直接持有", "Direct")}</dt><dd>{currency(active.directValue, "GBP", 2)}</dd></div>}
            {companies && active.indirectValue !== undefined && <div><dt>{t("基金内持有", "Via funds")}</dt><dd>{currency(active.indirectValue, "GBP", 2)}</dd></div>}
          </dl>
          {!companies && activeIndex === 12 && rows.length > 12 && (
            <details key={activeIndex} open>
              <summary>{t("包含分类", "Included categories")} · {rows.length - 12}</summary>
              <ul className="mx-allocation-other">
                {rows.slice(12).map((row, index) => (
                  <li key={index}><span>{row.name}</span><span>{currency(row.value, "GBP", 2)} · {percent(row.weight)}</span></li>
                ))}
              </ul>
            </details>
          )}
        </section>
        {reading}
        <div role="group" aria-label={t("选择配置分类", "Choose allocation category")} className="mx-allocation-choices">
          {slices.map((row, index) => (
            <button key={index} type="button" aria-pressed={index === activeIndex}
              aria-controls={detailId} onClick={() => select(index)}
              onPointerEnter={() => highlight(index)} onPointerLeave={() => highlight(null)}
              onFocus={() => highlight(index)} onBlur={() => highlight(null)}>
              <i aria-hidden="true" style={{ backgroundColor: colour(index) }} />
              <span>{row.name}</span><strong>{percent(row.weight)}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
