"use client";

import { useState } from "react";
import type { ResearchLensSnapshot } from "@/lib/types";
import { number, numeric, object, objects, percent, str, tone } from "./data";
import { Facts, Panel, Segments, useCopy } from "./foundation";

export function Seasonality({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [measure, setMeasure] = useState("meanReturn");
  const [month, setMonth] = useState(1);
  const source = object(data.fundamentals);
  const rows = objects(source.seasonality).filter(
    (row) => numeric(row.month) != null,
  );
  const coverage = object(source.seasonalityCoverage);
  if (!rows.length) return null;
  const selected = rows.find((row) => row.month === month) ?? rows[0];
  const months = [
    t("1 月", "Jan"),
    t("2 月", "Feb"),
    t("3 月", "Mar"),
    t("4 月", "Apr"),
    t("5 月", "May"),
    t("6 月", "Jun"),
    t("7 月", "Jul"),
    t("8 月", "Aug"),
    t("9 月", "Sep"),
    t("10 月", "Oct"),
    t("11 月", "Nov"),
    t("12 月", "Dec"),
  ];
  const monthLabel = (value: unknown) =>
    months[Number(value) - 1] ?? number(value, 0);
  return (
    <Panel
      title={t("月度季节性", "Monthly seasonality")}
      description={
        str(coverage.firstSession).slice(0, 7) +
        " — " +
        str(coverage.lastSession).slice(0, 7)
      }
      help={t(
        "按日历月份汇总历史价格变化。均值易受极端月份影响，可切换中位数，并查看上涨比例和样本数。历史范围截至数据日期，最近月份可能尚未结束；历史表现不代表未来规律。",
        "Historical price changes grouped by calendar month. Compare the mean with the median, positive-month frequency and sample count. Coverage ends at the data date, so the latest month may be incomplete. Past patterns do not predict future returns.",
      )}
      action={
        <Segments
          label={t("季节性统计", "Seasonality statistic")}
          value={measure}
          onChange={setMeasure}
          options={[
            { value: "meanReturn", label: t("均值", "Mean") },
            { value: "medianReturn", label: t("中位数", "Median") },
          ]}
        />
      }
    >
      <div
        className="mx-month-calendar"
        aria-label={t("各月历史表现", "Historical performance by month")}
      >
        {Array.from({ length: 12 }, (_, index) => {
          const row = rows.find((r) => Number(r.month) === index + 1);
          const value = numeric(row?.[measure]);
          return (
            <button
              key={index}
              type="button"
              disabled={!row}
              className={"mx-month-cell mx-" + tone(value)}
              aria-pressed={selected.month === index + 1}
              aria-label={
                monthLabel(index + 1) + " · " + percent(value, true, 1)
              }
              onClick={() => setMonth(index + 1)}
            >
              <span>{monthLabel(index + 1)}</span>
              <strong>{percent(value, true, 1)}</strong>
            </button>
          );
        })}
      </div>
      <div className="mx-season-detail" aria-live="polite">
        <h3>{monthLabel(selected.month)}</h3>
        <Facts
          rows={[
            [
              t("平均涨跌", "Mean return"),
              percent(selected.meanReturn, true, 2),
            ],
            [
              t("中位数", "Median return"),
              percent(selected.medianReturn, true, 2),
            ],
            [t("上涨月份占比", "Positive months"), percent(selected.hitRate)],
            [t("样本月份", "Month samples"), number(selected.observations, 0)],
            [t("最好月份", "Best month"), percent(selected.best, true, 2)],
            [t("最差月份", "Worst month"), percent(selected.worst, true, 2)],
          ]}
        />
      </div>
    </Panel>
  );
}
