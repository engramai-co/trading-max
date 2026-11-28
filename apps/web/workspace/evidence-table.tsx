"use client";

import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, type Key, type ReactNode } from "react";
import { Empty, useCopy } from "./foundation";

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
  rowKey,
  sort,
  className,
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
  rowKey?: (row: T) => Key;
  sort?: { column: number; direction: "ascending" | "descending" };
  className?: string;
}) {
  const t = useCopy();
  const [paging, setPaging] = useState({ column: sort?.column, direction: sort?.direction, page: 1 });
  const sortChanged = paging.column !== sort?.column || paging.direction !== sort?.direction;
  const setPage = (page: number) => setPaging({ column: sort?.column, direction: sort?.direction, page });
  if (sortChanged) setPage(1);
  const page = sortChanged ? 1 : paging.page;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  const paginationLabels = {
    first: t("第一页", "First page"),
    previous: t("上一页", "Previous page"),
    next: t("下一页", "Next page"),
    last: t("最后一页", "Last page"),
  };
  if (!rows.length)
    return <Empty title={t("没有符合条件的记录", "No matching records")} />;
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);
  const rowId = (row: T, index: number) => rowKey ? rowKey(row) : (current - 1) * pageSize + index;
  const count = totalRows ?? rows.length;
  const caption = `${label} · ${count} ${count === 1 ? t("条记录", "record") : t("条记录", "records")}`;
  const table = <>
    <Table
      label={label}
      caption={caption}
      showCaption={showCount && pages > 1}
      className={cn("mx-table", chart && "mx-chart-records-table", className)}
      containerProps={{ className: cn("mx-table-wrap", compactRecords && "tm-table-wide") }}
    >
      <TableHeader>
        <TableRow>
          {columns.map((column, index) => (
            <TableHead scope="col" key={column.label}
              aria-sort={sort?.column === index ? sort.direction : undefined}
              className={column.numeric ? "mx-align-right" : undefined}>
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {pageRows.map((row, index) => (
          <TableRow key={rowId(row, index)}>
            {columns.map((column, columnIndex) => {
              const value = column.value(row, { compact: false });
              const alignment = column.numeric ? "mx-align-right" : undefined;
              return columnIndex === rowHeaderIndex
                ? <TableHead scope="row" key={column.label} className={alignment}>{value}</TableHead>
                : <TableCell key={column.label} className={alignment}>{value}</TableCell>;
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
    {compactRecords && <div className="mx-compact-records tm-table-compact" aria-label={label} role="region">
      {pageRows.map((row, index) => <dl key={rowId(row, index)}>{columns.map((column) => <div key={column.label}>
        <dt>{column.label}</dt><dd>{column.value(row, { compact: true })}</dd>
      </div>)}</dl>)}
    </div>}
  </>;
  return (
    <>
      {compactRecords ? <div className="tm-table-variants">{table}</div> : table}
      {pages > 1 && (
        chart ? <nav aria-label={t("记录分页", "Record pages")}>
          <div className="mt-4 flex flex-wrap items-center gap-1">
            <Button aria-label={paginationLabels.first} size="icon" variant="outline" disabled={current === 1} onClick={() => setPage(1)}><ChevronFirst size={16} aria-hidden="true" /></Button>
            <Button aria-label={paginationLabels.previous} size="icon" variant="outline" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft size={16} aria-hidden="true" /></Button>
            {chartPageNumbers(current, pages).map((item, i) => item === null
              ? <span key={"gap-" + i} aria-hidden="true" className="px-2">…</span>
              : <Button key={item} size="icon" variant={item === current ? "secondary" : "outline"}
                  aria-current={item === current ? "page" : undefined} onClick={() => setPage(item)}>{item}</Button>)}
            <Button aria-label={paginationLabels.next} size="icon" variant="outline" disabled={current === pages} onClick={() => setPage(current + 1)}><ChevronRight size={16} aria-hidden="true" /></Button>
            <Button aria-label={paginationLabels.last} size="icon" variant="outline" disabled={current === pages} onClick={() => setPage(pages)}><ChevronLast size={16} aria-hidden="true" /></Button>
          </div>
        </nav> : <Pagination label={t("记录分页", "Record pages")} total={pages} value={current}
          onChange={setPage} className="mt-4" />
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
