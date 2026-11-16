"use client";

import { useRef, useState } from "react";
import type { ECharts } from "echarts";
import type { Preview } from "./research-facts";
import { Plot } from "./charts";
import { currency, percent, tone } from "@/workspace/data";
import { useCopy } from "./foundation";
import { minus } from "./readout-bridge";

const KEYS = ["bear", "base", "bull"] as const;
type ScenarioKey = (typeof KEYS)[number];

export function ValuationScenarioComparison({ preview, selected, onSelect }: {
  preview: Preview;
  selected: string;
  onSelect: (scenario: string) => void;
}) {
  const t = useCopy();
  const keys = KEYS;
  const names = { bear: t("保守", "Bear"), base: t("中性", "Base"), bull: t("乐观", "Bull") };
  // The cards above already carry each value and gap, so the chart has no tooltip:
  // a line under the pointer lights its card, and a card under the pointer or focus lights its line.
  const [hovered, setHovered] = useState<ScenarioKey | null>(null);
  const chart = useRef<ECharts | null>(null);
  const bound = useRef<WeakSet<ECharts>>(new WeakSet());
  const bind = () => {
    const instance = chart.current;
    if (!instance || bound.current.has(instance)) return;
    bound.current.add(instance);
    instance.on("mouseover", (event) => {
      if (event.componentType === "series") setHovered(KEYS[event.seriesIndex ?? -1] ?? null);
    });
    instance.on("mouseout", () => setHovered(null));
    instance.on("globalout", () => setHovered(null));
  };
  const light = (key: ScenarioKey | null) => {
    setHovered(key);
    chart.current?.dispatchAction({ type: "downplay" });
    if (key) chart.current?.dispatchAction({ type: "highlight", seriesIndex: KEYS.indexOf(key) });
  };
  // Symmetric percentage bounds keep spot at the same physical position even
  // when a different scenario or horizon requires a larger comparison range.
  const extent = Math.max(0.25, Math.ceil(Math.max(...keys.map((key) => Math.abs(preview.scenarios[key].upside))) / 0.25) * 0.25);
  // Unlevered equity cannot lose more than 100%, so the downside scale never extends below -100%.
  const minBound = -Math.min(1, extent);
  const maxBound = extent;
  return (
    <div className="mx-scenario-comparison" onPointerEnter={bind}>
      <div className="mx-scenario-spot">
        <span>{t("现价", "Current price")}</span>
        <strong>{currency(preview.basis.spot, preview.basis.currency, 2)}</strong>
      </div>
      <div className="mx-scenario-cards" role="group" aria-label={t("选择估值情景", "Select a valuation scenario")}>
        {keys.map((key) => {
          const scenario = preview.scenarios[key];
          return <button type="button" key={key} aria-pressed={selected === key} data-hover={hovered === key || undefined}
            onClick={() => onSelect(key)}
            onPointerEnter={() => light(key)} onPointerLeave={() => light(null)}
            onFocus={() => light(key)} onBlur={() => light(null)}>
            <span>{names[key]}</span>
            <strong>{currency(scenario.value, preview.basis.currency, 2)}</strong>
            <span className={`mx-${tone(scenario.upside)}`}>{percent(scenario.upside, true, 2)}</span>
          </button>;
        })}
      </div>
      <Plot
        research
        label={t("情景估值与现价的百分比差距", "Scenario valuations relative to current price")}
        height={180}
        controller={chart}
        option={(c) => ({
          animation: false,
          grid: { left: 54, right: 38, top: 32, bottom: 28 },
          xAxis: {
            type: "value", min: minBound, max: maxBound, splitNumber: 4,
            axisLabel: { formatter: (v: number) => minus(percent(v, true, 0)) },
            axisLine: { show: false }, axisTick: { show: false },
            splitLine: { show: false },
          },
          yAxis: {
            type: "category", inverse: true, data: keys.map((key) => names[key]),
            axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          },
          tooltip: { show: false },
          series: keys.map((key, i) => ({
            name: names[key], type: "line", symbol: "circle", symbolSize: selected === key ? 10 : 7,
            // The whole line answers the pointer, not only its two dots.
            triggerLineEvent: true,
            data: [[0, i], [preview.scenarios[key].upside, i]],
            lineStyle: { color: c.brand, width: selected === key ? 3 : 2, opacity: selected === key ? 0.85 : 0.25 },
            itemStyle: { color: selected === key ? c.brand : c.axis },
            emphasis: { lineStyle: { opacity: 0.85 } },
            markLine: i === 0 ? {
              silent: true, symbol: "none", data: [{ xAxis: 0 }],
              lineStyle: { color: c.axis, type: "dashed", width: 1 },
              label: { formatter: t("现价", "Current price"), position: "start", color: c.text },
            } : undefined,
          })),
        })}
      />
    </div>
  );
}
