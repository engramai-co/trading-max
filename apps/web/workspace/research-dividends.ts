import { numeric, str, type Json } from "./data";

/** Do not connect a partial year to annual totals, or treat truncated history as zero. */
export function dividendSummary(
  source: Json[],
  asOf: string,
  hasEarlierRecords?: boolean,
) {
  const day = asOf.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const rows = source
    .filter((r) => str(r.date) <= day && numeric(r.amount) != null)
    .sort((a, b) => str(a.date).localeCompare(str(b.date)));
  if (!rows.length) return null;
  const first = str(rows[0].date),
    year = Number(day.slice(0, 4));
  const startYear =
    Number(first.slice(0, 4)) + (hasEarlierRecords === false ? 0 : 1);
  const covered = (start: string) =>
    hasEarlierRecords === false || start >= first;
  const sum = (start: string, end: string, exclusive = false) =>
    covered(start)
      ? rows
          .filter(
            (r) =>
              (exclusive ? str(r.date) > start : str(r.date) >= start) &&
              str(r.date) <= end,
          )
          .reduce((total, row) => total + Number(row.amount), 0)
      : null;
  const annual = Array.from(
    { length: Math.max(0, year - Math.max(startYear, year - 10)) },
    (_, i) => {
      const y = Math.max(startYear, year - 10) + i;
      return { date: String(y), value: sum(`${y}-01-01`, `${y}-12-31`) };
    },
  );
  const trailing = (end: string) => {
    const before = new Date(end + "T00:00:00Z");
    const month = before.getUTCMonth();
    before.setUTCFullYear(before.getUTCFullYear() - 1);
    if (before.getUTCMonth() !== month) before.setUTCDate(0);
    return sum(before.toISOString().slice(0, 10), end, true);
  };
  const monthEnds: string[] = [];
  const endDate = new Date(day + "T00:00:00Z");
  for (let i = 119; i >= 0; i--) {
    const end = new Date(Date.UTC(year, endDate.getUTCMonth() - i, 0))
      .toISOString()
      .slice(0, 10);
    if (end < day && trailing(end) != null) monthEnds.push(end);
  }
  const ytd = sum(`${year}-01-01`, day);
  const priorYtd = sum(`${year - 1}-01-01`, `${year - 1}${day.slice(4)}`);
  return {
    asOf: day,
    year,
    annual,
    ytd,
    priorYtd,
    ytdChange:
      ytd != null && priorYtd != null && priorYtd > 0
        ? ytd / priorYtd - 1
        : null,
    ttm: trailing(day),
    trailing: [...monthEnds, day].map((date) => ({
      date,
      value: trailing(date),
    })),
  };
}
