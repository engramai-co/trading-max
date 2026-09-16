import { numeric, str, type Json } from "./data";

export const ratingKeys = [
  "strongBuy",
  "buy",
  "hold",
  "underperform",
  "sell",
] as const;
export const targetKeys = ["low", "mean", "median", "high"] as const;

export function normalizeRatingRow(row: Json): Json {
  if (!Object.hasOwn(row, "strongSell")) return row;
  // Yahoo names the last two bands sell/strongSell; the existing view model
  // names them underperform/sell. Keep missing counts missing.
  const { strongSell, sell, ...rest } = row;
  return { ...rest, underperform: sell, sell: strongSell };
}

export function ratingSummary(rows: Json[]) {
  rows = rows.map(normalizeRatingRow);
  const row =
    rows.find((r) => r.period === "0m") ??
    [...rows]
      .filter((r) => /^-\d+m$/.test(str(r.period)))
      .sort((a, b) => parseInt(str(b.period)) - parseInt(str(a.period)))[0] ??
    rows[0];
  const counts = ratingKeys.map((key) => {
    const count = numeric(row?.[key]);
    return count != null && count >= 0 && Number.isInteger(count)
      ? count
      : null;
  });
  const complete = counts.every((count) => count != null);
  const knownTotal = counts.reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  // An incomplete distribution cannot support a consensus score.
  const score =
    complete && knownTotal > 0
      ? counts.reduce<number>(
          (sum, count, index) => sum + count! * (index + 1),
          0,
        ) / knownTotal
      : null;
  return { counts, complete, knownTotal, score, period: str(row?.period) };
}

export function targetSnapshot(targets: Json, current: unknown) {
  const positive = (value: unknown) => {
    const n = numeric(value);
    return n != null && n > 0 ? n : null;
  };
  const spot = positive(current);
  const rows = targetKeys.map((key) => {
    const value = positive(targets[key]);
    return {
      key,
      value,
      change: value != null && spot != null ? value / spot - 1 : null,
    };
  });
  const low = rows[0].value,
    high = rows[3].value;
  return {
    spot,
    rows,
    range:
      low != null && high != null && low <= high
        ? ([low, high] as const)
        : null,
  };
}

export function recommendationChange(row: Json) {
  const epoch = numeric(row.epochGradeDate);
  const date =
    str(row.index ?? row.GradeDate ?? row.gradeDate) ||
    (epoch != null && Number.isFinite(new Date(epoch * 1000).getTime())
      ? new Date(epoch * 1000).toISOString()
      : "");
  return {
    date: date.slice(0, 10),
    firm: str(row.Firm ?? row.firm),
    from: str(row.FromGrade ?? row.fromGrade),
    to: str(row.ToGrade ?? row.toGrade),
    action: str(row.Action ?? row.action),
    target: numeric(row.currentPriceTarget),
  };
}
