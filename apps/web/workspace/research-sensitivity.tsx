"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Plot } from "./charts";
import { currency, number, object, percent } from "./data";
import { EvidenceTable } from "./evidence-table";
import { Empty, Panel, useCopy } from "./foundation";
import { sensitivityPoints } from "./research-display";

export function ValuationSensitivity({
  value: v,
}: {
  value: NonNullable<ResearchLensSnapshot["valuation"]>;
}) {
  const t = useCopy();
  if (!v.sensitivity) return null;
  const base = object(v.scenarios.base);
  const axes = [
    {
      key: "revenueGrowth",
      label: t("营收年复合增长", "Revenue CAGR"),
      base: base.revenueCagr,
    },
    {
      key: "fcfMargin",
      label: t("目标现金流率", "Target FCF margin"),
      base: base.targetFcfMargin,
    },
    {
      key: "discountRate",
      label: t("折现率", "Discount rate"),
      base: base.discountRate,
    },
  ].map((axis) => ({
    ...axis,
    points: sensitivityPoints(object(v.sensitivity)[axis.key], axis.base),
  }));
  const values = axes.flatMap((axis) => axis.points.map((p) => p.value));
  const lower = Math.min(...values, v.spot),
    upper = Math.max(...values, v.spot);
  const pad = Math.max((upper - lower) * 0.12, Math.abs(upper) * 0.02, 1);
  const step = 10 ** Math.floor(Math.log10(Math.max(upper - lower, 1))) / 2;
  const axisMin = Math.floor((lower - pad) / step) * step;
  const axisMax = Math.ceil((upper + pad) / step) * step;
  return (
    <Panel
      title={t("五年估值敏感性", "Five-year valuation sensitivity")}
      description={v.currency + t(" / 股", " / share")}
      help={t(
        "一次只改变一个输入，其余保持基准假设。实点为模型基准，虚线为现价。这组敏感性只对应五年模型。",
        "One input changes at a time; other assumptions stay at the base. The filled point marks the base and the dashed line marks spot. This sensitivity set belongs to the five-year model.",
      )}
    >
      <div className="mx-sensitivity-grid">
        {axes.map((axis) => (
          <section key={axis.key}>
            <div className="mx-sensitivity-heading">
              <h3>{axis.label}</h3>
              <span>
                {t("基准", "Base")} {percent(axis.base, false, 1)}
              </span>
            </div>
            {axis.points.length ? (
              <Plot
                label={
                  axis.label +
                  t("与五年每股估值", " and five-year value per share")
                }
                height={245}
                option={(c) => ({
                  grid: { left: 48, right: 15, top: 25, bottom: 38 },
                  xAxis: {
                    type: "value",
                    min: axis.points[0].input,
                    max: axis.points.at(-1)!.input,
                    splitNumber: 3,
                    axisLabel: {
                      color: c.axis,
                      formatter: (value: number) => percent(value, false, 1),
                      hideOverlap: true,
                    },
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { show: false },
                  },
                  yAxis: {
                    type: "value",
                    min: axisMin,
                    max: axisMax,
                    splitNumber: 3,
                    axisLabel: {
                      color: c.axis,
                      formatter: (value: number) => number(value, 0),
                    },
                    splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
                  },
                  tooltip: {
                    formatter: (input) => {
                      const entry = (Array.isArray(input) ? input : [input])[0];
                      const point = axis.points[entry?.dataIndex];
                      return point
                        ? [
                            axis.label + " " + percent(point.input, false, 2),
                            t("每股价值", "Value per share") +
                              " " +
                              currency(point.value, v.currency, 2),
                            t("相对基准", "From base") +
                              " " +
                              number(point.delta * 100, 1) +
                              " pp",
                          ].join("\n")
                        : "";
                    },
                  },
                  series: [
                    {
                      type: "line",
                      showSymbol: true,
                      symbol: "circle",
                      symbolSize: 6,
                      data: axis.points.map((point) => ({
                        value: [point.input, point.value],
                        symbolSize: point.delta === 0 ? 11 : 5,
                        itemStyle: {
                          color: point.delta === 0 ? c.brand : c.canvas,
                          borderColor: c.brand,
                          borderWidth: 2,
                        },
                      })),
                      lineStyle: { color: c.brand, width: 2 },
                      markLine: {
                        silent: true,
                        symbol: "none",
                        label: { show: false },
                        lineStyle: {
                          color: c.axis,
                          type: "dashed",
                          opacity: 0.7,
                        },
                        data: [{ yAxis: v.spot }],
                      },
                    },
                  ],
                })}
              />
            ) : (
              <Empty
                title={t("暂无敏感性记录", "No sensitivity observations")}
              />
            )}
          </section>
        ))}
      </div>
      <div className="mx-chart-legend">
        <span>
          <i style={{ background: "var(--mx-brand)" }} />
          {t("模型价值 · 实点为基准", "Model value · filled point is the base")}
        </span>
        <span>
          {t("虚线：现价", "Dashed: spot")} {currency(v.spot, v.currency, 2)}
        </span>
      </div>
      <details className="mx-chart-data">
        <summary>{t("查看敏感性数值", "Sensitivity values")}</summary>
        <EvidenceTable
          label={t("五年模型敏感性", "Five-year sensitivity")}
          rows={axes.flatMap((axis) =>
            axis.points.map((point) => ({ ...point, name: axis.label })),
          )}
          columns={[
            { label: t("假设", "Assumption"), value: (row) => row.name },
            {
              label: t("输入值", "Input"),
              value: (row) => percent(row.input, false, 2),
              numeric: true,
            },
            {
              label: t("相对基准", "From base"),
              value: (row) => number(row.delta * 100, 1) + " pp",
              numeric: true,
            },
            {
              label: t("每股价值", "Value per share"),
              value: (row) => currency(row.value, v.currency, 2),
              numeric: true,
            },
          ]}
        />
      </details>
    </Panel>
  );
}
