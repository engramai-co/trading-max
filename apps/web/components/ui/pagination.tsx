"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Ellipsis } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import { Button } from "./button";

function pageRange(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function pageItems(current: number, total: number) {
  if (total <= 7) return pageRange(1, total);
  if (current <= 4) return [...pageRange(1, 5), "end-gap", total];
  if (current >= total - 3) return [1, "start-gap", ...pageRange(total - 4, total)];
  return [1, "start-gap", ...pageRange(current - 1, current + 1), "end-gap", total];
}

export function Pagination({
  label, total, value, onChange, responsive = false, className,
}: {
  label: string;
  total: number;
  value: number;
  onChange: (page: number) => void;
  responsive?: boolean;
  className?: string;
}) {
  const { locale } = useLocale();
  const first = value <= 1;
  const last = value >= total;
  const controls = [
    { key: "first", label: locale === "zh" ? "第一页" : "First page", page: 1, disabled: first, Icon: ChevronsLeft },
    { key: "previous", label: locale === "zh" ? "上一页" : "Previous page", page: value - 1, disabled: first, Icon: ChevronLeft },
    { key: "next", label: locale === "zh" ? "下一页" : "Next page", page: value + 1, disabled: last, Icon: ChevronRight },
    { key: "last", label: locale === "zh" ? "最后一页" : "Last page", page: total, disabled: last, Icon: ChevronsRight },
  ];
  function edge({ key, label, page, disabled, Icon }: typeof controls[number]) {
    return <li key={key}>
      <Button type="button" variant="outline" size="icon" aria-label={label} disabled={disabled} onClick={() => onChange(page)}>
        <Icon size={16} aria-hidden="true" />
      </Button>
    </li>;
  }
  if (total <= 0) return null;
  return <nav aria-label={label} data-slot="pagination" data-responsive={responsive || undefined} className={cn("tm-pagination", className)}>
    <ul role="list" data-slot="pagination-content">
      {controls.slice(0, 2).map(edge)}
      {pageItems(value, total).map((page) => (
        <li key={page} data-pagination-number aria-hidden={typeof page === "string" ? true : undefined}>
          {typeof page === "number" ? <Button
            type="button"
            variant={page === value ? "default" : "outline"}
            size="icon"
            className="h-auto w-auto px-2 tabular-nums pointer-coarse:h-auto pointer-coarse:w-auto"
            aria-current={page === value ? "page" : undefined}
            onClick={() => onChange(page)}
          >{page}</Button> : <span data-slot="pagination-ellipsis"><Ellipsis size={16} /></span>}
        </li>
      ))}
      {responsive && <li className="tm-pagination-position" aria-current="page">{value} / {total}</li>}
      {controls.slice(2).map(edge)}
    </ul>
  </nav>;
}
