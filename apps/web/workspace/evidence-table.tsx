"use client";

import { Pagination } from "@mantine/core";
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
  value: (row: T) => ReactNode;
  numeric?: boolean;
};

/** Paginated, keyboard-readable alternatives to charts and dense detail lists. */
export function EvidenceTable<T>({
  rows,
  columns,
  label,
  pageSize = 20,
  rowHeaderIndex = 0,
}: {
  rows: T[];
  columns: EvidenceColumn<T>[];
  label: string;
  pageSize?: number;
  rowHeaderIndex?: number;
}) {
  const t = useCopy();
  const paginationLabels = usePaginationLabels();
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  if (!rows.length)
    return <Empty title={t("暂无对应记录", "No matching records")} />;
  return (
    <>
      <div
        className="mx-table-wrap"
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        <table className="mx-table">
          <caption className="mx-table-caption">
            {label} · {rows.length} {t("条记录", "records")}
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
            {rows
              .slice((current - 1) * pageSize, current * pageSize)
              .map((row, i) => (
                <tr key={(current - 1) * pageSize + i}>
                  {columns.map((c, j) =>
                    j === rowHeaderIndex ? (
                      <th
                        scope="row"
                        key={c.label}
                        className={c.numeric ? "mx-align-right" : undefined}
                      >
                        {c.value(row)}
                      </th>
                    ) : (
                      <td
                        key={c.label}
                        className={c.numeric ? "mx-align-right" : undefined}
                      >
                        {c.value(row)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <Pagination
          total={pages}
          value={current}
          onChange={setPage}
          withEdges
          mt="md"
          aria-label={t("记录分页", "Record pages")}
          getControlProps={paginationLabels}
        />
      )}
    </>
  );
}
