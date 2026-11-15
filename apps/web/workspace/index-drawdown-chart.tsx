"use client";

import { useState } from "react";
import { deepestDrawdown } from "@/lib/portfolio/drawdown-episodes";
import { drawdowns } from "@/lib/portfolio/math";
import { indexHistoryRows, type IndexHistory } from "./market-indices-data";
import { HistoryChart } from "./charts";
import { DrawdownReading, drawdownMarks } from "./drawdown-reading";
import { useCopy } from "./foundation";

export function IndexDrawdownChart({ history }: { history: IndexHistory }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  if ((history.points?.length ?? 0) < 3) return null;
  return <details className="mx-chart-data" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("指数回撤", "Index drawdown")}</summary>
    {open && <DrawdownContent rows={indexHistoryRows(history)} />}
  </details>;
}

function DrawdownContent({ rows }: { rows: Array<{ at: string; left?: number | null }> }) {
  const t = useCopy();
  const first = rows.find((row) => row.left != null)?.left;
  if (!first) return null;
  const dates = rows.map((row) => row.at);
  const values = drawdowns(rows.map((row) => row.left == null ? null : row.left / first - 1), true);
  const episode = deepestDrawdown(values);
  return <>
    <DrawdownReading episode={episode} dates={dates} basis="selected" />
    <HistoryChart
      dates={dates} label={t("指数回撤曲线", "Index drawdown chart")} percentage height={220}
      lines={[{ name: t("回撤", "Drawdown"), values, colour: "negative", markers: drawdownMarks(episode, dates, t) }]}
    />
  </>;
}
