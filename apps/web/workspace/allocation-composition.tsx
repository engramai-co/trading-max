"use client";

import { useComputedColorScheme } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useId, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { allocationChartColours, useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import { currency, percent } from "@/workspace/data";
import { Empty, useCopy } from "./foundation";

export type AllocationSlice = {
  name: string;
  value: number | null;
  weight: number | null;
};

export function AllocationComposition({ rows }: { rows: AllocationSlice[] }) {
  const t = useCopy();
  const colours = useChartColours();
  const scheme = useComputedColorScheme("light");
  const palette = allocationChartColours[scheme];
  const reduced = useReducedMotion();
  const description = useId();
  const detailId = useId();
  const [selected, setSelected] = useState(0);
  const slices = useMemo(() => {
    const visible = rows.slice(0, 12);
    const rest = rows.slice(12);
    return rest.length ? [...visible, {
      name: t("其余分类", "Other categories"),
      value: rest.every((row) => row.value !== null)
        ? rest.reduce((sum, row) => sum + row.value!, 0) : null,
      weight: rest.every((row) => row.weight !== null)
        ? rest.reduce((sum, row) => sum + row.weight!, 0) : null,
    }] : visible;
  }, [rows, t]);
  const activeIndex = Math.min(selected, Math.max(0, slices.length - 1));
  const active = slices[activeIndex];
  const option = useMemo<EChartsOption>(() => ({
    backgroundColor: "transparent",
    animation: !reduced,
    animationDuration: 250,
    animationDurationUpdate: 150,
    tooltip: {
      trigger: "item", renderMode: "richText", confine: true,
      backgroundColor: colours.tooltip, borderColor: colours.tooltipBorder,
      textStyle: { color: colours.tooltipText, fontSize: 12 },
      formatter: (params) => {
        const point = Array.isArray(params) ? params[0] : params;
        const row = slices[point.dataIndex];
        return row ? `${row.name}\n${currency(row.value, "GBP", 2)} · ${percent(row.weight)}` : "";
      },
    },
    series: [{
      type: "pie", radius: ["58%", "80%"], center: ["50%", "50%"],
      label: { show: false }, labelLine: { show: false },
      stillShowZeroSum: false,
      emphasis: { scale: false },
      data: slices.map((row, index) => ({
        name: row.name, value: Math.max(0, row.weight ?? 0),
        itemStyle: {
          color: palette[index],
          opacity: index === activeIndex ? 1 : 0.65,
          borderWidth: index === activeIndex ? 3 : 1,
          borderColor: colours.text,
          borderRadius: 2,
        },
      })),
    }],
  }), [activeIndex, colours, palette, reduced, slices]);
  const canvas = useECharts(option, "core", undefined, undefined, (event) => {
    if (event.componentType === "series" && event.seriesType === "pie")
      setSelected(event.dataIndex);
  });

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
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            setSelected(event.key === "Home" ? 0 : event.key === "End" ? slices.length - 1
              : (activeIndex + (event.key === "ArrowRight" ? 1 : -1) + slices.length) % slices.length);
          }}
        />
        <div className="mx-allocation-center" aria-hidden="true">
          <span>{active.name}</span>
          <strong>{percent(active.weight)}</strong>
          <small>{t("配置占比", "Allocation weight")}</small>
        </div>
        <p id={description} className="mx-form-help">
          {t("点击扇区或分类查看详情，也可用左右方向键切换。", "Select a slice or category for details. Arrow keys also switch categories.")}
        </p>
      </div>
      <div className="mx-allocation-details">
        <section id={detailId} aria-label={t("所选分类详情", "Selected category details")} aria-live="polite" aria-atomic="true">
          <p className="mx-form-help">{t("所选分类", "Selected category")}</p>
          <h3>{active.name}</h3>
          <dl className="mx-allocation-facts">
            <div><dt>{t("金额 · GBP", "Value · GBP")}</dt><dd>{currency(active.value, "GBP", 2)}</dd></div>
            <div><dt>{t("配置占比", "Allocation weight")}</dt><dd>{percent(active.weight)}</dd></div>
          </dl>
          {activeIndex === 12 && (
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
        <div role="group" aria-label={t("选择配置分类", "Choose allocation category")} className="mx-allocation-choices">
          {slices.map((row, index) => (
            <button key={index} type="button" aria-pressed={index === activeIndex}
              aria-controls={detailId} onClick={() => setSelected(index)}>
              <i aria-hidden="true" style={{ backgroundColor: palette[index] }} />
              <span>{row.name}</span><strong>{percent(row.weight)}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
