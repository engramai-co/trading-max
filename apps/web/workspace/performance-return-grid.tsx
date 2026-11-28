"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ChevronRight } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { useLocale } from "@/components/locale-provider";
import { useBreakpoint } from "@/lib/hooks";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { Scope } from "@/lib/portfolio/nav";
import { returnPeriods, type ReturnPeriod } from "@/lib/portfolio/return-periods";
import { formatCalendarDate, formatDate } from "@/ui/formatters";
import { percent, tone } from "@/workspace/data";
import { Empty, Panel, Pending, QueryError, QueryReadStatus, Segments, useCopy } from "./foundation";
import { SelectPicker } from "./picker";

export function ReturnGrid({ scope, onSelect, selected, runId }: {
  scope: Scope;
  runId?: string;
  onSelect: (period: ReturnPeriod) => void;
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
  const cards = kind === "month" ? periods.months : kind === "quarter" ? periods.quarters : periods.annual;
  const label = (key: string) => kind === "month"
    ? formatDate(key + "-01", locale, { month: "short", timeZone: "UTC" })
    : kind === "quarter" ? key.slice(5) : key;
  const columns = (target: string) => kind === "month" ? Array.from({ length: 12 }, (_, i) => `${target}-${String(i + 1).padStart(2, "0")}`)
    : kind === "quarter" ? Array.from({ length: 4 }, (_, i) => `${target}-Q${i + 1}`) : [target];
  const render = (key: string, showLabel: boolean) => {
    const period = cards.find((entry) => entry.key === key);
    if (!period || period.value == null) return <span className="mx-heat-empty">{showLabel && <small>{label(key)}</small>}—</span>;
    const active = selected?.start === period.start && selected.end === period.end;
    const partial = period.partial ? t("部分覆盖", "Partial coverage") : "";
    const title = [key, percent(period.value, true, 2), formatCalendarDate(period.start, locale) + " – " + formatCalendarDate(period.end, locale), partial].filter(Boolean).join(" · ");
    return <button type="button" className={`mx-heat-pill tm-heat-pill mx-${tone(period.value)}`} title={title} aria-label={title}
      aria-pressed={active} data-partial={period.partial}
      style={{ "--mx-heat": Math.min(1, Math.abs(period.value) / 0.03) } as CSSProperties} onClick={() => onSelect(period)}>
      {showLabel && <small>{label(key)}</small>}
      {percent(period.value, true, 2)}{period.partial && <span aria-hidden="true"> *</span>}
    </button>;
  };
  return <Panel>
    <details className="mx-monthly-returns" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><ChevronRight size={16} className="-mx-px shrink-0" aria-hidden="true" />{t("周期收益（TWR）", "Periodic returns (TWR)")}</summary>
      {open && <>
        <div className="mx-return-grid-tools">
          <Segments label={t("收益周期", "Return period")} value={kind} onChange={setKind} options={[
            { value: "month", label: t("月", "Month") },
            { value: "quarter", label: t("季", "Quarter") },
            { value: "year", label: t("年", "Year") },
          ]} />
          {phone && periods.years.length > 1 && <SelectPicker aria-label={t("年份", "Year")} value={year} options={periods.years} onChange={(value) => setYear(value ?? undefined)} />}
        </div>
        <QueryReadStatus label={t("周期收益", "Periodic returns")} failed={query.isError && !query.data} ready={!!query.data} error={query.error} />
      {query.isPending ? <Pending compact /> : query.isError && !query.data ? <QueryError retry={query.refetch} />
          : !year ? <Empty title={t("需要更多每日收益记录", "More daily return observations are needed")} />
          : <Table containerProps={{ className: "mx-table-wrap mx-month-table-wrap" }} label={t("周期收益", "Periodic returns")} className="mx-table mx-month-table">
              <TableHeader><TableRow><TableHead scope="col">{t("年份", "Year")}</TableHead>{columns(year).map((key) => <TableHead scope="col" key={key}>{kind === "year" ? t("收益", "Return") : label(key)}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{(phone ? [year] : periods.years).map((item) => <TableRow key={item}>
                <TableHead scope="row">{item}</TableHead>
                {columns(item).map((key) => <TableCell key={key} className="mx-month-return">{render(key, !!phone)}</TableCell>)}
              </TableRow>)}</TableBody>
            </Table>}
        {cards.some((period) => period.value != null && period.partial) && <span className="mx-muted">* {t("部分覆盖", "Partial coverage")}</span>}
      </>}
    </details>
  </Panel>;
}
