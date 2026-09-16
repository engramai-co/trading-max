"use client";

import type { Preview } from "./research-facts";
import { Plot } from "./charts";
import { currency, percent, tone } from "./data";
import { useCopy } from "./foundation";

export function ValuationScenarioComparison({ preview, selected, onSelect }: {
  preview: Preview;
  selected: string;
  onSelect: (scenario: string) => void;
}) {
  const t = useCopy();
  const keys = ["bear", "base", "bull"] as const;
  const names = { bear: t("保守", "Conservative"), base: t("基准", "Base"), bull: t("乐观", "Optimistic") };
  // Symmetric percentage bounds keep spot at the same physical position even
  // when a different scenario or horizon requires a larger comparison range.
  const extent = Math.max(0.25, Math.ceil(Math.max(...keys.map((key) => Math.abs(preview.scenarios[key].upside))) / 0.25) * 0.25);
  return (
    <div className="mx-scenario-comparison">
      <div className="mx-scenario-spot">
        <span>{t("现价", "Current price")}</span>
        <strong>{currency(preview.basis.spot, preview.basis.currency, 2)}</strong>
      </div>
      <div className="mx-scenario-cards" role="group" aria-label={t("选择估值情景", "Select a valuation scenario")}>
        {keys.map((key) => {
          const scenario = preview.scenarios[key];
          return <button type="button" key={key} aria-pressed={selected === key} onClick={() => onSelect(key)}>
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
        option={(c) => ({
          animation: false,
          grid: { left: 54, right: 38, top: 32, bottom: 28 },
          xAxis: {
            type: "value", min: -extent, max: extent, interval: extent / 2,
            axisLabel: { formatter: (v: number) => percent(v, true, 0) },
            axisLine: { show: false }, axisTick: { show: false },
            splitLine: { show: false },
          },
          yAxis: {
            type: "category", inverse: true, data: keys.map((key) => names[key]),
            axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          },
          tooltip: {
            trigger: "item",
            formatter: (input) => {
              const item = Array.isArray(input) ? input[0] : input;
              const key = keys[item.seriesIndex ?? 0];
              if (!key) return "";
              const scenario = preview.scenarios[key];
              return `${names[key]} · ${currency(scenario.value, preview.basis.currency, 2)}\n${t("与现价相比", "Against current price")} ${percent(scenario.upside, true, 2)}`;
            },
          },
          series: keys.map((key, i) => ({
            name: names[key], type: "line", symbol: "circle", symbolSize: selected === key ? 10 : 7,
            data: [[0, i], [preview.scenarios[key].upside, i]],
            lineStyle: { color: c.brand, width: selected === key ? 3 : 2, opacity: selected === key ? 0.85 : 0.25 },
            itemStyle: { color: selected === key ? c.brand : c.axis },
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
