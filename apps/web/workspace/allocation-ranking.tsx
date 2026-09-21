"use client";

import type { AllocationSlice } from "./allocation-composition";
import { currency, percent } from "@/workspace/data";
import { Empty, useCopy } from "./foundation";

/** HTML labels let long category names wrap without clipping the chart. */
export function AllocationRanking({ rows }: { rows: AllocationSlice[] }) {
  const t = useCopy();
  if (!rows.length) return <Empty title={t("暂无配置数据", "No allocation data")} />;
  return (
    <ol className="mx-allocation-ranking" aria-label={t("底层配置排名", "Underlying allocation ranking")}>
      {rows.map((row, index) => (
        <li key={index}>
          <span className="mx-allocation-ranking__name">{row.name}</span>
          <span className="mx-allocation-ranking__track" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(1, row.weight ?? 0)) * 100}%` }} />
          </span>
          <span className="mx-allocation-ranking__value">
            <strong>{percent(row.weight)}</strong>
            <small>{currency(row.value, "GBP", 2)}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}
