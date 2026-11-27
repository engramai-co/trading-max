"use client";

import { Pagination } from "@mantine/core";
import { Table } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, type ReactNode } from "react";
import { Empty, useCopy } from "./foundation";

export function usePaginationLabels() {
  const t = useCopy();
  const labels = {
    first: t("第一页", "First page"),
    previous: t("上一页", "Previous page"),
    next: t("下一页", "Next page"),
    last: t("最后一页", "Last page"),
  };
  return (control: keyof typeof labels) => ({ "aria-label": labels[control] });
}

export type EvidenceColumn<T> = {
  label: string;
  value: (row: T, context: { compact: boolean }) => ReactNode;
  numeric?: boolean;
};

/** Paginated, keyboard-readable alternatives to charts and dense detail lists. */
export function EvidenceTable<T>({
  rows,
  columns,
  label,
  pageSize = 20,
  rowHeaderIndex = 0,
  totalRows,
  showCount = true,
  compactRecords = false,
  chart = false,
}: {
  rows: T[];
  columns: EvidenceColumn<T>[];
  label: string;
  pageSize?: number;
  rowHeaderIndex?: number;
  totalRows?: number;
  /** False when the surrounding layout already states the count, such as a disclosure summary. */
  showCount?: boolean;
  compactRecords?: boolean;
  chart?: boolean;
}) {
  const t = useCopy();
  const paginationLabels = usePaginationLabels();
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  if (!rows.length)
    return <Empty title={t("没有符合条件的记录", "No matching records")} />;
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);
  const region = {
    className: cn("mx-table-wrap", compactRecords && "mx-wide-records"),
    tabIndex: 0,
    role: "region",
    "aria-label": label,
  };
  const contents = <>
    {/* A single page shows its rows; the count only helps when paging. */}
    <caption className={"mx-table-caption" + (showCount && rows.length > pageSize ? "" : " sr-only")}>
      {label} · {totalRows ?? rows.length} {(totalRows ?? rows.length) === 1 ? t("条记录", "record") : t("条记录", "records")}
    </caption>
    <thead>
      <tr>
        {columns.map((c) => (
          <th
            scope="col"
            key={c.label}
            className={c.numeric ? "mx-align-right" : undefined}
          >
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {pageRows
        .map((row, i) => (
          <tr key={(current - 1) * pageSize + i}>
            {columns.map((c, j) =>
              j === rowHeaderIndex ? (
                <th
                  scope="row"
                  key={c.label}
                  className={c.numeric ? "mx-align-right" : undefined}
                >
                  {c.value(row, { compact: false })}
                </th>
              ) : (
                <td
                  key={c.label}
                  className={c.numeric ? "mx-align-right" : undefined}
                >
                  {c.value(row, { compact: false })}
                </td>
              ),
            )}
          </tr>
        ))}
    </tbody>
  </>;
  return (
    <>
      {chart ? (
        <Table containerProps={region} className="mx-table caption-top tabular-nums [&_td]:p-3 [&_th]:bg-transparent [&_th]:p-3 [&_td]:whitespace-nowrap">
          {contents}
        </Table>
      ) : <div {...region}><table className="mx-table">{contents}</table></div>}
      {compactRecords && <div className="mx-compact-records" aria-label={label} role="region">
        {pageRows.map((row, i) => <dl key={i}>{columns.map((col) => <div key={col.label}>
          <dt>{col.label}</dt><dd>{col.value(row, { compact: true })}</dd>
        </div>)}</dl>)}
      </div>}
      {pages > 1 && (
        <nav aria-label={t("记录分页", "Record pages")}>
          {chart ? (
            <div className="mt-4 flex flex-wrap items-center gap-1">
              <Button {...paginationLabels("first")} size="icon" variant="outline" disabled={current === 1} onClick={() => setPage(1)}><ChevronFirst size={16} aria-hidden="true" /></Button>
              <Button {...paginationLabels("previous")} size="icon" variant="outline" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft size={16} aria-hidden="true" /></Button>
              {chartPageNumbers(current, pages).map((item, i) => item === null
                ? <span key={"gap-" + i} aria-hidden="true" className="px-2">…</span>
                : <Button key={item} size="icon" variant={item === current ? "secondary" : "outline"}
                    aria-current={item === current ? "page" : undefined} onClick={() => setPage(item)}>{item}</Button>)}
              <Button {...paginationLabels("next")} size="icon" variant="outline" disabled={current === pages} onClick={() => setPage(current + 1)}><ChevronRight size={16} aria-hidden="true" /></Button>
              <Button {...paginationLabels("last")} size="icon" variant="outline" disabled={current === pages} onClick={() => setPage(pages)}><ChevronLast size={16} aria-hidden="true" /></Button>
            </div>
          ) : <Pagination total={pages} value={current} onChange={setPage} withEdges mt="md" getControlProps={paginationLabels} />}
        </nav>
      )}
    </>
  );
}

function chartPageNumbers(page: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, null, total];
  if (page >= total - 3) return [1, null, total - 4, total - 3, total - 2, total - 1, total];
  return [1, null, page - 1, page, page + 1, null, total];
}
