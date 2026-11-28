"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { useLocale } from "@/components/locale-provider";
import { useBreakpoint } from "@/lib/hooks";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { Scope } from "@/lib/portfolio/nav";
import { returnPeriods, type ReturnPeriod } from "@/lib/portfolio/return-periods";
import { formatCalendarDate, formatDate } from "@/ui/formatters";
import { percent, tone } from "@/workspace/data";
import { Empty, Panel, Pending, QueryError, QueryReadStatus, Segments, Tip, useCopy } from "./foundation";
import { SelectPicker } from "./picker";

const cellButton = [
  "gap-0 rounded-[var(--radius-heat-tile)] px-[5px] font-semibold [font-size:inherit] [line-height:inherit]",
  "aria-pressed:border-link forced-colors:aria-pressed:border-[ButtonText]",
  "data-[partial=true]:underline data-[partial=true]:decoration-dotted data-[partial=true]:underline-offset-[3px]",
  "max-phone:grid max-phone:min-h-11 max-phone:w-full max-phone:place-items-center",
].join(" ");

export function ReturnGrid({ scope, onSelect, selected, runId }: {
  scope: Scope;
  runId?: string;
  onSelect: (period: ReturnPeriod, trigger: HTMLElement) => void;
  selected: { start: string; end: string } | null;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"month" | "quarter" | "year">("month");
  const [chosenYear, setYear] = useState<string>();
  const phone = useBreakpoint("phone");
  const selection = useMemo(() => ({ detail: "summary" as const, range: "ALL" as const, scope }), [scope]);
  const query = useDashboardLens("analytics", undefined, open, selection, runId);
  const periods = useMemo(() => returnPeriods(query.data?.nav ?? [], scope, query.data?.brokerAsOf ?? undefined),
    [query.data?.nav, query.data?.brokerAsOf, scope]);
  const year = chosenYear && periods.years.includes(chosenYear) ? chosenYear : periods.years[0];
  const hasYearPicker = phone && periods.years.length > 1;
  const showCellLabel = Boolean(phone && (kind !== "year" || !hasYearPicker));
  const returnLabel = t("周期收益", "Periodic returns");
  const cards = kind === "month" ? periods.months : kind === "quarter" ? periods.quarters : periods.annual;
  const label = (key: string) => kind === "month"
    ? formatDate(key + "-01", locale, { month: "short", timeZone: "UTC" })
    : kind === "quarter" ? key.slice(5) : key;
  const columns = (target: string) => kind === "month" ? Array.from({ length: 12 }, (_, i) => `${target}-${String(i + 1).padStart(2, "0")}`)
    : kind === "quarter" ? Array.from({ length: 4 }, (_, i) => `${target}-Q${i + 1}`) : [target];
  const render = (key: string) => {
    const period = cards.find((entry) => entry.key === key);
    if (!period || period.value == null) return <span className="mx-heat-empty max-phone:grid max-phone:min-h-11 max-phone:w-full max-phone:place-items-center">{showCellLabel && <small>{label(key)}</small>}—</span>;
    const active = selected?.start === period.start && selected.end === period.end;
    const partial = period.partial ? t("部分覆盖", "Partial coverage") : "";
    const value = percent(period.value, true, 2);
    const title = [key, value, formatCalendarDate(period.start, locale) + " – " + formatCalendarDate(period.end, locale), partial].filter(Boolean).join(" · ");
    return <Tip label={title} describes={false} decorative>
      <Button type="button" variant={null} size="table"
        className={`mx-heat-pill tm-heat-pill mx-${tone(period.value)} ${cellButton}`}
        aria-label={title} aria-pressed={active} data-partial={period.partial}
        style={{ "--mx-heat": Math.min(1, Math.abs(period.value) / 0.03) } as CSSProperties}
        onClick={(event) => onSelect(period, event.currentTarget)}>
        {showCellLabel && <small>{label(key)}</small>}
        <span>{value}{period.partial && <span aria-hidden="true"> *</span>}</span>
      </Button>
    </Tip>;
  };
  return <Panel>
    <Collapsible className="mx-monthly-returns" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button variant="link" className="group/disclosure max-w-full justify-start px-0 text-start font-semibold whitespace-normal max-phone:min-h-11" />}>
        <ChevronRight size={16} className="-mx-px group-data-[panel-open]/disclosure:rotate-90" aria-hidden="true" />
        {t("周期收益（TWR）", "Periodic returns (TWR)")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && <>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-[0.8125rem]">
            <Segments label={t("收益周期", "Return period")} value={kind} onChange={setKind} options={[
              { value: "month", label: t("月", "Month") },
              { value: "quarter", label: t("季", "Quarter") },
              { value: "year", label: t("年", "Year") },
            ]} />
            {hasYearPicker && <SelectPicker aria-label={t("年份", "Year")} value={year} options={periods.years} onChange={(value) => setYear(value ?? undefined)} />}
          </div>
          <QueryReadStatus label={returnLabel} failed={query.isError && !query.data} ready={!!query.data} error={query.error} />
          {query.isPending ? <Pending compact /> : query.isError && !query.data ? <QueryError retry={query.refetch} />
            : !year ? <Empty title={t("需要更多每日收益记录", "More daily return observations are needed")} />
            : <Table containerProps={{ className: "mx-table-wrap max-phone:block" }} label={returnLabel}
                pinFirst={!phone} role="table" className="mx-table mx-month-table">
                {/* Retain table roles in WebKit when the phone view lays out the row as a grid. */}
                <TableHeader role="rowgroup" className="max-phone:sr-only">
                  <TableRow role="row">
                    <TableHead scope="col" role="columnheader">{t("年份", "Year")}</TableHead>
                    {columns(year).map((key) => <TableHead scope="col" role="columnheader" key={key}>{kind === "year" ? t("收益", "Return") : label(key)}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody role="rowgroup">
                  {(phone ? [year] : periods.years).map((item) =>
                    <TableRow role="row" key={item} className="max-phone:grid max-phone:grid-cols-[repeat(3,minmax(min-content,1fr))] max-phone:gap-1">
                      <TableHead scope="row" role="rowheader" className={hasYearPicker || (phone && kind === "year") ? "sr-only" : "max-phone:col-span-full"}>{item}</TableHead>
                      {columns(item).map((key) => <TableCell role="cell" key={key} className="mx-month-return max-phone:border-0 max-phone:p-0">{render(key)}</TableCell>)}
                    </TableRow>
                  )}
                </TableBody>
              </Table>}
          {cards.some((period) => period.value != null && period.partial) && <span className="mx-muted">* {t("部分覆盖", "Partial coverage")}</span>}
        </>}
      </CollapsibleContent>
    </Collapsible>
  </Panel>;
}
