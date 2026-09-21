"use client";

import { useState } from "react";
import { Pagination } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { fetchHistory } from "@/lib/portfolio-history-query";
import { currency, percent } from "@/workspace/data";
import { navNumber } from "@/lib/portfolio/nav";
import { EvidenceTable, usePaginationLabels } from "./evidence-table";
import { Pending, QueryError, useCopy } from "./foundation";
import { valuationNote } from "@/lib/portfolio/history";
import type { HistoryPage, HistorySelection } from "@/lib/portfolio/prepared";

/** Exact source rows load only when opened; page keys pin the chart's snapshot. */
export function HistoryRecords({ selection, label }: { selection: HistorySelection; label: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const labels = usePaginationLabels();
  const query = useQuery({
    queryKey: ["history-records", selection, page], enabled: open,
    queryFn: ({ signal }) => fetchHistory<HistoryPage>(selection, signal, page),
    staleTime: Infinity, gcTime: 60_000, retry: 1,
  });
  const data = query.data;
  return <details className="mx-chart-data" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("查看精确记录", "View exact observations")}</summary>
    {open && (query.isPending ? <Pending compact /> : query.isError ? <QueryError retry={query.refetch} /> : data && <>
      <EvidenceTable label={label} totalRows={data.total}
        rows={data.points.map((point, index) => ({ point, index }))}
        columns={[
          { label: t("日期", "Date"), value: ({ point }) => point.date },
          { label: t("来源与精度", "Source & precision"), value: ({ point }) => valuationNote(point, t) },
          { label: t("账户价值", "Account value"), numeric: true, value: ({ point }) => currency(navNumber(point, selection.scope), "GBP", 2) },
          { label: t("累计净入金", "Cumulative net contributions"), numeric: true, value: ({ point }) => currency(navNumber(point, selection.scope, "NetContributionsGbp"), "GBP", 2) },
          { label: t("区间净入金", "Net contributions in period"), numeric: true, value: ({ index }) => currency(data.money.periodFlows[index], "GBP", 2) },
          { label: t("区间净盈亏", "Period P&L"), numeric: true, value: ({ index }) => currency(data.money.pnls[index], "GBP", 2) },
          { label: t("盈亏相对期初", "P&L / opening value"), numeric: true, value: ({ index }) => percent(data.money.pnlPercents[index], false, 2) },
          { label: t("盈亏回撤", "P&L drawdown"), numeric: true, value: ({ index }) => currency(data.money.drawdown[index], "GBP", 2) },
          { label: t("区间价值变化", "Value change"), numeric: true, value: ({ index }) => currency(data.money.valueChanges[index], "GBP", 2) },
          { label: t("价值相对期初", "Value change / opening"), numeric: true, value: ({ index }) => percent(data.money.valueChangePercents[index], false, 2) },
          ...(data.points.some((p) => p.investModelValueGbp != null || p.isaModelValueGbp != null) ? [{
            label: t("同时段重建值", "Modeled value in this interval"), numeric: true,
            value: ({ point }: { point: HistoryPage["points"][number] }) => {
              const model = selection.scope === "invest" ? point.investModelValueGbp
                : selection.scope === "isa" ? point.isaModelValueGbp
                  : point.investModelValueGbp != null && point.isaModelValueGbp != null
                    ? point.investModelValueGbp + point.isaModelValueGbp + (data.carriedCfdValue ?? 0) : null;
              return currency(model, "GBP", 2);
            },
          }] : []),
        ]} />
      {data.total > data.pageSize && <Pagination total={Math.ceil(data.total / data.pageSize)} value={page} onChange={setPage}
        withEdges mt="md" aria-label={t("记录分页", "Record pages")} getControlProps={labels} />}
    </>)}
  </details>;
}
