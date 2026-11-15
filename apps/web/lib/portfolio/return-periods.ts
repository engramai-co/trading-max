import type { NavPoint } from "@/lib/types";
import { inRange, navNumber, periodReturn, type Scope } from "./nav";

export type ReturnPeriod = {
  key: string;
  start: string;
  end: string;
  value: number | null;
  partial: boolean;
};

export function returnPeriods(points: NavPoint[], scope: Scope, asOf?: string) {
  const rows = inRange(points, "ALL").filter((row) => !row.intraday);
  const monthlyRows = new Map<string, NavPoint[]>();
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    const month = monthlyRows.get(key) ?? [];
    month.push(row);
    monthlyRows.set(key, month);
  }
  const months: ReturnPeriod[] = [];
  let previous: NavPoint | undefined;
  for (const [key, records] of monthlyRows) {
    const first = records[0], last = records.at(-1)!;
    const [year, month] = key.split("-").map(Number);
    const preceding = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
    const fromPrevious = previous?.date.startsWith(preceding) ? previous : undefined;
    const start = fromPrevious ?? first;
    const endOfMonth = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const through = (asOf ?? rows.at(-1)!.date).slice(0, 10);
    const seriesComplete = records.every((record) => navNumber(record, scope, "Twr") != null);
    const lastDayClose = Date.parse(endOfMonth) - Date.parse(last.date) <= 4 * 86_400_000;
    months.push({ key, start: start.date, end: last.date,
      value: seriesComplete && start !== last ? periodReturn(navNumber(start, scope, "Twr"), navNumber(last, scope, "Twr")) : null,
      partial: !fromPrevious || through < endOfMonth || !lastDayClose });
    previous = last;
  }
  const years = [...new Set(months.map((month) => month.key.slice(0, 4)))].reverse();
  const compound = (key: string, entries: ReturnPeriod[], expected: number) => {
    // A quarter or year compounds only contiguous, complete calendar
    // months. An internal missing month does not become a zero return.
    const complete = entries.filter((entry) => entry.value != null && !entry.partial);
    const contiguous = complete.every((entry, i) => i === 0 || entry.start === complete[i - 1].end);
    const bounds = contiguous && complete.length ? complete : entries;
    return {
      key,
      start: bounds[0]?.start ?? "",
      end: bounds.at(-1)?.end ?? "",
      value: contiguous && complete.length ? complete.reduce((product, entry) => product * (1 + entry.value!), 1) - 1 : null,
      partial: complete.length !== expected,
    };
  };
  return {
    years,
    months,
    quarters: years.flatMap((year) => Array.from({ length: 4 }, (_, q) => compound(
      `${year}-Q${q + 1}`,
      months.filter((month) => month.key.startsWith(year) && Math.floor((Number(month.key.slice(5)) - 1) / 3) === q),
      3,
    ))),
    annual: years.map((year) => compound(year, months.filter((month) => month.key.startsWith(year)), 12)),
  };
}
