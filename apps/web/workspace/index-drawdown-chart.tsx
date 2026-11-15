"use client";

import { useState } from "react";
import { deepestDrawdown } from "@/lib/portfolio/drawdown-episodes";
import { drawdowns } from "@/lib/portfolio/math";
import { HistoryChart } from "./charts";
import { DrawdownReading, drawdownMarks } from "./drawdown-reading";
import { useCopy } from "./foundation";

export function IndexDrawdownChart({ rows }: { rows: Array<{ at: string; left?: number | null }> }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const first = rows.find((row) => row.left != null)?.left;
  if (!first || rows.length < 3) return null;
  const dates = rows.map((row) => row.at);
  const values = drawdowns(rows.map((row) => row.left == null ? null : row.left / first - 1), true);
  const episode = deepestDrawdown(values);
  return <details className="mx-chart-data" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("指数回撤", "Index drawdown")}</summary>
    {open && <>
      <DrawdownReading episode={episode} dates={dates} basis="selected" />
      <HistoryChart
        dates={dates} label={t("指数回撤曲线", "Index drawdown chart")} percentage height={220}
        lines={[{ name: t("回撤", "Drawdown"), values, colour: "negative", markers: drawdownMarks(episode, dates, t) }]}
      />
    </>}
  </details>;
}
